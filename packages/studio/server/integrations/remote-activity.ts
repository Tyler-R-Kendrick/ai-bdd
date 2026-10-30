import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Store, HttpError } from '../store.ts';
import type { User } from '../../shared/domain.ts';
import {
  emptyRemoteRuns,
  emptyRemoteStream,
  mergeRemoteRuns,
  remoteAnswerActionSchema,
  type RemoteActivity,
  type RemoteQuestion,
  type RemoteControl,
  type RemoteIncoming,
  type RemoteRunState,
  type RemoteStreamState,
  type RemoteFeature,
} from '../../shared/remote-agent.ts';
import {
  applyRemotePart,
  declaredRemoteTools,
} from '../../shared/remote-stream.ts';
const hash = (value: string) =>
    createHash('sha256').update(value).digest('hex'),
  stamp = () => new Date().toISOString();
const MAX_EVENT_BYTES = 2 * 1024 * 1024,
  MAX_STATE_BYTES = 1536 * 1024;
type Scope = { user: User; artifactId?: string };
export type RemoteActivityOptions = {
  store: Store;
  origin: string;
  authenticate: (request: FastifyRequest) => Promise<Scope>;
  cancelJob?: (jobId: string, user: User) => Promise<void>;
  allowed: (user: User, id: string) => Promise<boolean>;
};
type Event = Extract<RemoteIncoming, { eventId: string }>;
/** Durable presentation and user input. None of these records grant tool, source-write or implementation authority. */
export class RemoteActivityService {
  constructor(readonly options: RemoteActivityOptions) {}
  get store() {
    return this.options.store;
  }
  async initialize() {
    await this.store.tx(async () => {
      await this.store.lock('schema:studio.remote-activity');
      await this.store.db.exec(`
CREATE TABLE IF NOT EXISTS studio_remote_activity(request_id TEXT PRIMARY KEY REFERENCES studio_remote_requests(id) ON DELETE CASCADE,ordinal BIGINT NOT NULL UNIQUE,thread_id TEXT NOT NULL,source_version BIGINT NOT NULL,source_sha256 TEXT,anchors_json TEXT NOT NULL,stream_json TEXT NOT NULL,runs_json TEXT NOT NULL,cursor BIGINT NOT NULL DEFAULT 0,event_bytes BIGINT NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS studio_remote_events(request_id TEXT NOT NULL REFERENCES studio_remote_requests(id) ON DELETE CASCADE,event_key TEXT NOT NULL,sequence BIGINT NOT NULL,input_sha256 TEXT NOT NULL,event_json TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(request_id,event_key),UNIQUE(request_id,sequence));
CREATE TABLE IF NOT EXISTS studio_remote_questions(request_id TEXT NOT NULL REFERENCES studio_remote_requests(id) ON DELETE CASCADE,id TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL,revision BIGINT NOT NULL,answers_json TEXT NOT NULL,value_json TEXT,answered_by TEXT,run_id TEXT,root_run_id TEXT,stage_id TEXT,anchor_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(request_id,id));
CREATE TABLE IF NOT EXISTS studio_remote_controls(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES studio_remote_requests(id) ON DELETE CASCADE,action TEXT NOT NULL,run_id TEXT,status TEXT NOT NULL,message TEXT,created_at TEXT NOT NULL,expires BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS studio_remote_questions_open ON studio_remote_questions(request_id,status);
`);
    });
  }
  async prepare(requestId: string, job: any, threadId: string) {
    const artifact = await this.store.artifact(
      job.artifactId,
      job.principalId,
      'write',
    );
    await this.store.tx(async () => {
      await this.store.lock('project:' + job.projectId);
      await this.store.lock('job:' + job.id);
      await this.store.lock('remote-activity:ordinal');
      const current = await this.store.artifact(
        job.artifactId,
        job.principalId,
        'write',
      );
      const exact = current.version === job.artifactVersion;
      const blocks = current.content.doc?.content ?? [];
      const anchors = exact
        ? blocks.slice(0, 10000).map((node: any, index: number) => ({
            index,
            nodeId:
              typeof node.attrs?.id === 'string'
                ? node.attrs.id.slice(0, 200)
                : undefined,
            digest: 'sha256:' + hash(JSON.stringify(node)),
            decision: [
              'questionnaireBlock',
              'decisionBlock',
              'researchOfferBlock',
            ].includes(node.type),
          }))
        : [];
      await this.store.exec(
        'INSERT INTO studio_remote_activity(request_id,ordinal,thread_id,source_version,source_sha256,anchors_json,stream_json,runs_json,created_at,updated_at) VALUES(?,(SELECT COALESCE(MAX(ordinal),0)+1 FROM studio_remote_activity),?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING',
        requestId,
        threadId,
        job.artifactVersion,
        exact ? hash(JSON.stringify(current.content)) : null,
        JSON.stringify(anchors),
        JSON.stringify(emptyRemoteStream()),
        JSON.stringify(emptyRemoteRuns()),
        stamp(),
        stamp(),
      );
    });
    return artifact;
  }
  async row(id: string) {
    return this.store.one(
      'SELECT r.*,r.status AS request_status,j.project_id,j.status AS job_status,j.artifact_version,j.fence AS job_fence,j.lease_expires,a.thread_id,a.source_version,a.source_sha256,a.anchors_json,a.stream_json,a.runs_json,a.cursor,a.event_bytes,a.updated_at FROM studio_remote_requests r JOIN studio_durable_jobs j ON j.id=r.job_id JOIN studio_remote_activity a ON a.request_id=r.id WHERE r.id=?',
      id,
    );
  }
  private live(row: any) {
    return (
      row &&
      row.request_status === 'pending' &&
      row.job_status === 'running' &&
      Number(row.fence) === Number(row.job_fence) &&
      Number(row.lease_expires) > Date.now()
    );
  }
  private async exactSource(row: any) {
    const artifact = await this.store.artifact(
      row.artifact_id,
      row.user_id,
      'write',
    );
    return (
      artifact.version === Number(row.source_version) &&
      row.source_sha256 === hash(JSON.stringify(artifact.content))
    );
  }
  private async write<T>(
    id: string,
    actor: User | undefined,
    guard: (() => Promise<unknown>) | undefined,
    work: (row: any) => Promise<T>,
  ): Promise<T> {
    const initial = await this.row(id);
    if (!initial) throw new HttpError(404, 'Remote turn not found');
    await this.store.artifact(initial.artifact_id, initial.user_id, 'write');
    if (actor)
      await this.store.artifact(initial.artifact_id, actor.id, 'write');
    return this.store.tx(async () => {
      await this.store.lock('project:' + initial.project_id);
      await this.store.lock('job:' + initial.job_id);
      for (const userId of [
        ...new Set([initial.user_id, ...(actor ? [actor.id] : [])]),
      ].sort())
        await this.store.lock('repository-identity:' + userId);
      const row = await this.row(id);
      if (!this.live(row))
        throw new HttpError(
          409,
          'This remote turn lost its active execution lease',
        );
      await this.store.artifact(row.artifact_id, row.user_id, 'write');
      if (actor) await this.store.artifact(row.artifact_id, actor.id, 'write');
      await guard?.();
      return work(row);
    });
  }
  private async record<T>(
    row: any,
    key: string,
    payload: unknown,
    operation: () => Promise<{ value: T; event?: unknown }>,
  ): Promise<{ value: T; sequence: number }> {
    const digest = hash(JSON.stringify(payload)),
      old = await this.store.one(
        'SELECT input_sha256,sequence,result_json FROM studio_remote_events WHERE request_id=? AND event_key=?',
        row.id,
        key,
      );
    if (old) {
      if (old.input_sha256 !== digest)
        throw new HttpError(
          409,
          'This event identity already describes different work',
        );
      return {
        value: JSON.parse(old.result_json),
        sequence: Number(old.sequence),
      };
    }
    if (Number(row.cursor) >= 4096)
      throw new HttpError(
        413,
        'This remote turn reached its event count budget',
      );
    const result = await operation(),
      encoded = JSON.stringify(result.event ?? payload),
      bytes = Buffer.byteLength(encoded);
    if (Number(row.event_bytes) + bytes > MAX_EVENT_BYTES)
      throw new HttpError(
        413,
        'This remote turn reached its durable event budget',
      );
    const sequence = Number(row.cursor) + 1;
    await this.store.exec(
      'INSERT INTO studio_remote_events VALUES(?,?,?,?,?,?,?)',
      row.id,
      key,
      sequence,
      digest,
      encoded,
      JSON.stringify(result.value),
      stamp(),
    );
    await this.store.exec(
      'UPDATE studio_remote_activity SET cursor=?,event_bytes=event_bytes+?,updated_at=? WHERE request_id=?',
      sequence,
      bytes,
      stamp(),
      row.id,
    );
    return { value: result.value, sequence };
  }
  private question(row: any): RemoteQuestion {
    return {
      id: row.id,
      input: JSON.parse(row.payload_json),
      status: row.status,
      revision: Number(row.revision),
      answers: JSON.parse(row.answers_json),
      value: row.value_json ? JSON.parse(row.value_json) : null,
      ...(row.answered_by ? { answeredBy: row.answered_by } : {}),
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.root_run_id ? { rootRunId: row.root_run_id } : {}),
      ...(row.stage_id ? { stageId: row.stage_id } : {}),
      ...(row.anchor_json ? { anchor: JSON.parse(row.anchor_json) } : {}),
      createdAt: row.created_at,
    };
  }
  async accept(
    message: Event,
    features: Set<RemoteFeature>,
    guard: () => Promise<unknown>,
  ) {
    return this.write(message.requestId, undefined, guard, (row) =>
      this.record(row, message.eventId, message, async () => {
        let stream = JSON.parse(row.stream_json) as RemoteStreamState,
          runs = JSON.parse(row.runs_json) as RemoteRunState,
          event: unknown = message;
        if (message.type === 'tools') {
          if (!features.has('stream-parts'))
            throw new HttpError(400, 'Stream parts were not negotiated');
          stream = declaredRemoteTools(stream, message.names);
        }
        if (message.type === 'part') {
          if (!features.has('stream-parts'))
            throw new HttpError(400, 'Stream parts were not negotiated');
          stream = applyRemotePart(stream, message.part);
          if (message.part.type === 'error')
            event = {
              ...message,
              part: { ...message.part, error: stream.error },
            };
          if (message.part.type === 'tool-result' && message.part.isError) {
            const toolCallId = message.part.toolCallId;
            event = {
              ...message,
              part: {
                ...message.part,
                result: stream.calls.find((call) => call.id === toolCallId)
                  ?.result,
              },
            };
          }
          if (stream.error) {
            await this.store.exec(
              "UPDATE studio_remote_requests SET status='failed' WHERE id=?",
              row.id,
            );
            await this.withdraw(row.id, 'cancelled');
          }
        }
        if (message.type === 'runs') {
          if (!features.has('run-cards'))
            throw new HttpError(400, 'Run cards were not negotiated');
          runs = mergeRemoteRuns(
            runs,
            message,
            features.has('run-stage-deltas'),
          );
        }
        if (message.type === 'input-request') {
          if (!features.has('questions'))
            throw new HttpError(400, 'Questions were not negotiated');
          if (Buffer.byteLength(JSON.stringify(message.input)) > 100000)
            throw new HttpError(
              413,
              'Split this question into smaller requests',
            );
          if (
            await this.store.one(
              'SELECT id FROM studio_remote_questions WHERE request_id=? AND id=?',
              row.id,
              message.questionId,
            )
          )
            throw new HttpError(409, 'Question identity was already used');
          const count = await this.store.one(
            "SELECT COUNT(*) AS n FROM studio_remote_questions WHERE request_id=? AND status='open'",
            row.id,
          );
          if (Number(count.n) >= 16)
            throw new HttpError(429, 'At most16questions may be open per turn');
          const exact = await this.exactSource(row),
            anchors = JSON.parse(row.anchors_json) as any[];
          const candidate =
              message.block &&
              anchors.find(
                (item) =>
                  item.index === message.block!.index &&
                  item.digest === message.block!.digest &&
                  !item.decision,
              ),
            anchor =
              candidate &&
              anchors.filter((item) => item.digest === candidate.digest)
                .length === 1
                ? {
                    index: candidate.index,
                    nodeId: candidate.nodeId,
                    digest: candidate.digest,
                  }
                : undefined;
          await this.store.exec(
            'INSERT INTO studio_remote_questions(request_id,id,payload_json,status,revision,answers_json,run_id,root_run_id,stage_id,anchor_json,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?,?,?,?)',
            row.id,
            message.questionId,
            JSON.stringify(message.input),
            exact ? 'open' : 'stale',
            '[]',
            message.runId ?? null,
            message.rootRunId ?? message.runId ?? null,
            message.stageId ?? null,
            anchor ? JSON.stringify(anchor) : null,
            stamp(),
            stamp(),
          );
        }
        if (message.type === 'input-cancel')
          await this.store.exec(
            "UPDATE studio_remote_questions SET status='cancelled',revision=revision+1,updated_at=? WHERE request_id=? AND id=? AND status='open'",
            stamp(),
            row.id,
            message.questionId,
          );
        if (
          Buffer.byteLength(JSON.stringify({ stream, runs })) > MAX_STATE_BYTES
        )
          throw new HttpError(
            413,
            'This remote turn reached its materialized activity budget',
          );
        await this.store.exec(
          'UPDATE studio_remote_activity SET stream_json=?,runs_json=? WHERE request_id=?',
          JSON.stringify(stream),
          JSON.stringify(runs),
          row.id,
        );
        return { value: { accepted: true }, event };
      }),
    );
  }
  async hostPart(
    id: string,
    key: string,
    part: any,
    guard: () => Promise<unknown>,
  ) {
    return this.write(id, undefined, guard, (row) =>
      this.record(row, 'host:' + key, part, async () => {
        const stream = applyRemotePart(
          JSON.parse(row.stream_json),
          part,
          'server',
        );
        await this.store.exec(
          'UPDATE studio_remote_activity SET stream_json=? WHERE request_id=?',
          JSON.stringify(stream),
          id,
        );
        const event =
          part.type === 'tool-result'
            ? {
                ...part,
                result: stream.calls.find((call) => call.id === part.toolCallId)
                  ?.result,
              }
            : part;
        return { value: { accepted: true }, event };
      }),
    );
  }
  async withdraw(id: string, status: 'cancelled' | 'stale' = 'cancelled') {
    await this.store.exec(
      "UPDATE studio_remote_questions SET status=?,revision=revision+1,updated_at=? WHERE request_id=? AND status='open'",
      status,
      stamp(),
      id,
    );
  }
  async ended(id: string) {
    await this.withdraw(id);
    await this.store.exec(
      "UPDATE studio_remote_controls SET status='failed',message='The turn ended' WHERE request_id=? AND status='pending'",
      id,
    );
  }
  private paused(row: any, question: RemoteQuestion, controls: any[]) {
    const runs = JSON.parse(row.runs_json) as RemoteRunState,
      root = question.rootRunId ?? question.runId;
    return (
      root &&
      (runs.paused.includes(root) ||
        runs.cards.some(
          (card) => card.id === root && card.status === 'paused',
        ) ||
        controls.some(
          (control) =>
            control.status === 'pending' &&
            control.action === 'pause' &&
            (!control.run_id || control.run_id === root),
        ))
    );
  }
  async deliveries(id: string) {
    const row = await this.row(id);
    if (!row || !this.live(row)) return { questions: [], controls: [] };
    if (!(await this.exactSource(row))) await this.withdraw(id, 'stale');
    await this.store.exec(
      "UPDATE studio_remote_controls SET status='failed',message='The remote client did not acknowledge this control',expires=0 WHERE request_id=? AND status='pending' AND expires<=?",
      id,
      Date.now(),
    );
    const controls = await this.store.all(
        "SELECT * FROM studio_remote_controls WHERE request_id=? AND status='pending' ORDER BY created_at",
        id,
      ),
      questions = await this.store.all(
        "SELECT * FROM studio_remote_questions WHERE request_id=? AND status<>'open' ORDER BY created_at",
        id,
      );
    return {
      controls: controls.map((control) => ({
        type: 'control',
        requestId: id,
        controlId: control.id,
        action: control.action,
        ...(control.run_id ? { runId: control.run_id } : {}),
      })),
      questions: questions
        .map((record) => this.question(record))
        .filter((question) => !this.paused(row, question, controls))
        .map((question) => ({
          type: 'input-result',
          requestId: id,
          questionId: question.id,
          revision: question.revision,
          status: question.status === 'answered' ? 'answered' : 'cancelled',
          value:
            question.input.method === 'questionnaire'
              ? {
                  answers: question.answers.map((answer) => ({
                    ...answer,
                    question:
                      question.input.method === 'questionnaire'
                        ? question.input.params.questions[answer.questionIndex]
                            .question
                        : '',
                  })),
                  cancelled: question.status !== 'answered',
                }
              : question.status === 'answered'
                ? question.value
                : question.input.method === 'confirm'
                  ? false
                  : null,
        })),
    };
  }
  async controlResult(
    message: Extract<RemoteIncoming, { type: 'control-result' }>,
    guard: () => Promise<unknown>,
  ) {
    return this.write(message.requestId, undefined, guard, async (row) => {
      const control = await this.store.one(
        'SELECT * FROM studio_remote_controls WHERE id=? AND request_id=?',
        message.controlId,
        row.id,
      );
      if (!control) throw new HttpError(404, 'Remote control not found');
      if (control.status !== 'pending') {
        if ((control.status === 'accepted') !== message.ok)
          throw new HttpError(
            409,
            'A remote control acknowledgement cannot change',
          );
        return;
      }
      if (Number(control.expires) <= Date.now())
        throw new HttpError(409, 'Remote control acknowledgement expired');
      await this.store.exec(
        'UPDATE studio_remote_controls SET status=?,message=? WHERE id=?',
        message.ok ? 'accepted' : 'failed',
        message.message ?? null,
        control.id,
      );
      if (message.ok) {
        const runs = JSON.parse(row.runs_json) as RemoteRunState,
          targets = control.run_id ? [control.run_id] : runs.active;
        for (const target of targets) {
          if (control.action === 'pause') {
            if (!runs.paused.includes(target)) runs.paused.push(target);
          } else runs.paused = runs.paused.filter((id) => id !== target);
          const card = runs.cards.find((card) => card.id === target);
          if (card && ['running', 'waiting', 'paused'].includes(card.status))
            card.status = control.action === 'pause' ? 'paused' : 'running';
        }
        await this.store.exec(
          'UPDATE studio_remote_activity SET runs_json=?,updated_at=? WHERE request_id=?',
          JSON.stringify(runs),
          stamp(),
          row.id,
        );
      }
    });
  }
  private async answer(
    user: User,
    id: string,
    questionId: string,
    raw: unknown,
  ) {
    const input = remoteAnswerActionSchema.parse(raw);
    return this.write(id, user, undefined, (row) =>
      this.record(
        row,
        'browser:' + user.id + ':' + input.idempotencyKey,
        { questionId, input },
        async () => {
          const record = await this.store.one(
            'SELECT * FROM studio_remote_questions WHERE request_id=? AND id=?',
            id,
            questionId,
          );
          if (!record) throw new HttpError(404, 'Question not found');
          if (
            record.status !== 'open' ||
            Number(record.revision) !== input.expectedRevision
          )
            throw new HttpError(
              409,
              'This question changed or was already answered',
            );
          if (!(await this.exactSource(row)))
            throw new HttpError(
              409,
              'The source changed. Start a fresh agent turn before answering.',
            );
          const question = this.question(record);
          let status = 'open',
            answers = question.answers,
            value: unknown = question.value;
          if (input.action === 'cancel') status = 'cancelled';
          else if (question.input.method === 'questionnaire') {
            if (input.value !== undefined || !input.answers?.length)
              throw new HttpError(
                400,
                'Provide one or more questionnaire answers',
              );
            const merged = new Map(
              answers.map((answer) => [answer.questionIndex, answer]),
            );
            for (const answer of input.answers) {
              const prompt =
                question.input.params.questions[answer.questionIndex];
              if (!prompt)
                throw new HttpError(400, 'Unknown questionnaire item');
              if (answer.kind === 'multi') {
                if (
                  !prompt.multiSelect ||
                  answer.answer !== null ||
                  !answer.selected?.length ||
                  new Set(answer.selected).size !== answer.selected.length ||
                  answer.selected.some(
                    (label) =>
                      !prompt.options.some((option) => option.label === label),
                  )
                )
                  throw new HttpError(
                    400,
                    'Choose valid distinct options for this multiple choice item',
                  );
              } else if (answer.kind === 'option') {
                if (
                  prompt.multiSelect ||
                  !prompt.options.some(
                    (option) => option.label === answer.answer,
                  ) ||
                  answer.selected
                )
                  throw new HttpError(400, 'Choose a valid offered option');
              } else if (!answer.answer?.trim() || answer.selected)
                throw new HttpError(400, 'Provide a written answer');
              merged.set(answer.questionIndex, answer);
            }
            answers = [...merged.values()].sort(
              (a, b) => a.questionIndex - b.questionIndex,
            );
            status =
              answers.length === question.input.params.questions.length
                ? 'answered'
                : 'open';
          } else {
            if (input.answers)
              throw new HttpError(400, 'This question expects one value');
            if (question.input.method === 'confirm')
              value = z.boolean().parse(input.value);
            else if (question.input.method === 'select') {
              value = z.string().max(4000).parse(input.value);
              if (!question.input.choices.includes(value as string))
                throw new HttpError(400, 'Choose one of the offered values');
            } else
              value = z
                .string()
                .min(1)
                .max(question.input.method === 'editor' ? 50000 : 20000)
                .parse(input.value);
            status = 'answered';
          }
          await this.store.exec(
            'UPDATE studio_remote_questions SET status=?,revision=revision+1,answers_json=?,value_json=?,answered_by=?,updated_at=? WHERE request_id=? AND id=?',
            status,
            JSON.stringify(answers),
            value === undefined ? null : JSON.stringify(value),
            user.id,
            stamp(),
            id,
            questionId,
          );
          await this.store.audit(
            row.project_id,
            row.artifact_id,
            user.name,
            'remote.question.' +
              (status === 'cancelled' ? 'cancelled' : 'answered'),
            JSON.stringify({
              requestId: id,
              questionId,
              sourceVersion: Number(row.source_version),
            }),
          );
          return { value: { status, revision: Number(record.revision) + 1 } };
        },
      ),
    );
  }
  private async control(
    user: User,
    id: string,
    input: {
      action: 'pause' | 'resume' | 'stop';
      runId?: string;
      idempotencyKey: string;
    },
  ) {
    const initial = await this.row(id);
    if (!initial) throw new HttpError(404, 'Remote turn not found');
    const role = await this.store.role(initial.project_id, user.id, 'write');
    if (user.id !== initial.user_id && role !== 'owner')
      throw new HttpError(
        403,
        'Only this turn owner or a project owner may control it',
      );
    if (input.action === 'stop') {
      if (!this.options.cancelJob)
        throw new HttpError(
          503,
          'Remote turn cancellation is unavailable on this host',
        );
      await this.options.cancelJob(initial.job_id, user);
      await this.store.exec(
        "UPDATE studio_remote_requests SET status='cancelled' WHERE id=? AND status='pending'",
        id,
      );
      await this.ended(id);
      return { status: 'cancelled' };
    }
    return this.write(id, user, undefined, (row) =>
      this.record(
        row,
        'browser:' + user.id + ':' + input.idempotencyKey,
        input,
        async () => {
          if (input.action === 'resume' && !(await this.exactSource(row)))
            throw new HttpError(
              409,
              'The source changed; a stale turn cannot resume',
            );
          const runs = JSON.parse(row.runs_json) as RemoteRunState;
          if (
            input.runId &&
            !runs.cards.some((card) => card.id === input.runId)
          )
            throw new HttpError(404, 'Reported run not found');
          if (
            await this.store.one(
              "SELECT id FROM studio_remote_controls WHERE request_id=? AND status='pending'",
              id,
            )
          )
            throw new HttpError(
              409,
              'Wait for the pending remote control acknowledgement',
            );
          const controlId = randomUUID();
          await this.store.exec(
            'INSERT INTO studio_remote_controls VALUES(?,?,?,?,?,?,?,?)',
            controlId,
            id,
            input.action,
            input.runId ?? null,
            'pending',
            null,
            stamp(),
            Date.now() + 10000,
          );
          return { value: { id: controlId, status: 'pending' } };
        },
      ),
    );
  }
  async snapshot(user: User, id: string): Promise<RemoteActivity> {
    const row = await this.row(id);
    if (!row) throw new HttpError(404, 'Remote turn not found');
    const artifact = await this.store.artifact(row.artifact_id, user.id),
      live = this.live(row),
      exact =
        artifact.version === Number(row.source_version) &&
        row.source_sha256 === hash(JSON.stringify(artifact.content));
    if (!live || !exact)
      await this.withdraw(id, !exact ? 'stale' : 'cancelled');
    const questions = (
      await this.store.all(
        'SELECT * FROM studio_remote_questions WHERE request_id=? ORDER BY created_at LIMIT 1024',
        id,
      )
    ).map((record) => this.question(record));
    const controls = (
      await this.store.all(
        'SELECT * FROM studio_remote_controls WHERE request_id=? ORDER BY created_at DESC LIMIT 100',
        id,
      )
    ).map((record) => ({
      id: record.id,
      action: record.action,
      runId: record.run_id ?? undefined,
      status: record.status,
      message: record.message ?? undefined,
      createdAt: record.created_at,
    })) as RemoteControl[];
    const membership = await this.store.one(
      'SELECT role FROM memberships WHERE project_id=? AND user_id=?',
      row.project_id,
      user.id,
    );
    return {
      id: row.id,
      jobId: row.job_id,
      threadId: row.thread_id,
      artifactVersion: Number(row.source_version),
      sourceSha256: row.source_sha256,
      status: row.request_status,
      jobStatus: row.job_status,
      cursor: Number(row.cursor),
      stream: JSON.parse(row.stream_json),
      runs: JSON.parse(row.runs_json),
      questions,
      controls,
      canAnswer: live && exact && membership?.role !== 'viewer',
      canControl:
        live && (row.user_id === user.id || membership?.role === 'owner'),
      createdAt: row.created_at,
    };
  }
  register(app: FastifyInstance) {
    const actor = async (
      request: FastifyRequest,
      artifactId: string,
      write = false,
    ) => {
      if (
        write &&
        (request.headers.authorization ||
          request.headers.origin !== this.options.origin)
      )
        throw new HttpError(
          403,
          'A signed-in person must answer or control an agent turn',
        );
      const scope = await this.options.authenticate(request);
      if (scope.artifactId && scope.artifactId !== artifactId)
        throw new HttpError(
          403,
          'This Planner credential belongs to another artifact',
        );
      await this.store.artifact(
        artifactId,
        scope.user.id,
        write ? 'write' : 'read',
      );
      return scope.user;
    };
    app.get<{ Params: { id: string }; Querystring: { threadId?: string } }>(
      '/api/artifacts/:id/planner/activity',
      async (request) => {
        const user = await actor(request, request.params.id),
          thread = request.query.threadId
            ? z.string().uuid().parse(request.query.threadId)
            : undefined;
        const rows = await this.store.all(
          'SELECT a.request_id FROM studio_remote_activity a JOIN studio_remote_requests r ON r.id=a.request_id WHERE r.artifact_id=?' +
            (thread ? ' AND a.thread_id=?' : '') +
            ' ORDER BY a.ordinal DESC LIMIT 8',
          request.params.id,
          ...(thread ? [thread] : []),
        );
        const result = [];
        for (const row of rows) {
          const value = await this.snapshot(user, row.request_id);
          value.stream.blocks = value.stream.blocks.map((block) => ({
            ...block,
            text: block.text.slice(0, 20000),
          }));
          value.runs.cards = value.runs.cards.map((card) => ({
            ...card,
            earlierStages:
              (card.earlierStages ?? 0) + Math.max(0, card.stages.length - 64),
            stages: card.stages.slice(-64),
          }));
          result.push(value);
        }
        return { requests: result };
      },
    );
    app.get<{ Params: { id: string; requestId: string } }>(
      '/api/artifacts/:id/planner/requests/:requestId',
      async (request) => {
        const user = await actor(request, request.params.id),
          row = await this.row(request.params.requestId);
        if (!row || row.artifact_id !== request.params.id)
          throw new HttpError(404, 'Remote turn not found');
        return this.snapshot(user, row.id);
      },
    );
    app.get<{
      Params: { id: string; requestId: string };
      Querystring: { after?: string };
    }>(
      '/api/artifacts/:id/planner/requests/:requestId/events',
      async (request) => {
        await actor(request, request.params.id);
        const row = await this.row(request.params.requestId);
        if (!row || row.artifact_id !== request.params.id)
          throw new HttpError(404, 'Remote turn not found');
        const after = z.coerce
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .parse(request.query.after ?? 0);
        const events = await this.store.all(
          'SELECT sequence,event_json FROM studio_remote_events WHERE request_id=? AND sequence>? ORDER BY sequence LIMIT 100',
          row.id,
          after,
        );
        return {
          events: events.map((event) => ({
            sequence: Number(event.sequence),
            event: JSON.parse(event.event_json),
          })),
          cursor: events.length ? Number(events.at(-1).sequence) : after,
        };
      },
    );
    app.post<{ Params: { id: string; requestId: string; questionId: string } }>(
      '/api/artifacts/:id/planner/requests/:requestId/questions/:questionId',
      async (request) => {
        const user = await actor(request, request.params.id, true),
          row = await this.row(request.params.requestId);
        if (!row || row.artifact_id !== request.params.id)
          throw new HttpError(404, 'Remote turn not found');
        return this.answer(
          user,
          row.id,
          request.params.questionId,
          request.body,
        );
      },
    );
    app.post<{ Params: { id: string; requestId: string } }>(
      '/api/artifacts/:id/planner/requests/:requestId/control',
      async (request) => {
        const user = await actor(request, request.params.id, true),
          row = await this.row(request.params.requestId);
        if (!row || row.artifact_id !== request.params.id)
          throw new HttpError(404, 'Remote turn not found');
        return this.control(
          user,
          row.id,
          z
            .object({
              idempotencyKey: z.string().uuid(),
              action: z.enum(['pause', 'resume', 'stop']),
              runId: z.string().min(1).max(128).optional(),
            })
            .strict()
            .parse(request.body),
        );
      },
    );
  }
  async exportPage(
    artifactId: string,
    after: number,
    cutoff: number,
    limit = 20,
    user?: User,
  ) {
    const rows = await this.store.all(
      'SELECT a.ordinal,r.id,r.user_id FROM studio_remote_activity a JOIN studio_remote_requests r ON r.id=a.request_id WHERE r.artifact_id=? AND a.ordinal>? AND a.ordinal<=? ORDER BY a.ordinal LIMIT ?',
      artifactId,
      after,
      cutoff,
      Math.max(1, Math.min(20, limit)),
    );
    return Promise.all(
      rows.map(async (row) => ({
        sequence: Number(row.ordinal),
        ...(await this.snapshot(
          user ?? (await this.store.publicUser(row.user_id)),
          row.id,
        )),
      })),
    );
  }
}
