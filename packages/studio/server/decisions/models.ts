import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { User } from '../../shared/domain.ts';
import {
  decisionProfileSchema,
  decisionQuestionsSchema,
  decisionPurposes,
  type DecisionProfile,
  type DecisionProfileView,
  type DecisionAnswer,
  type DecisionEvaluation,
} from '../../shared/decision-profile.ts';
import { HttpError, type Store } from '../store.ts';
import type {
  DecisionInvocation,
  DecisionProvider,
  DecisionSettings,
  ProviderDecision,
} from './contracts.ts';
import {
  DecisionProviderError,
  openaiDecisionProvider,
  jevDecisionProvider,
  structuredDecisionProvider,
} from './providers.ts';
const hash = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
const stamp = () => new Date().toISOString();
const promptVersion = 'studio-decision-questions-v1';
class DecisionLeaseLostError extends Error {}
const terminal = (status: string) =>
  ['completed', 'error', 'cancelled'].includes(status);
export class DecisionModels {
  readonly ready: Promise<void>;
  private readonly providers = new Map<
    DecisionProfile['provider'],
    DecisionProvider
  >();
  private readonly owner = randomUUID();
  private readonly controllers = new Set<AbortController>();
  private readonly tasks = new Set<Promise<DecisionEvaluation>>();
  private closing = false;
  constructor(
    readonly options: {
      store: Store;
      settings: DecisionSettings;
      notify?: (projectId: string, artifactId: string) => Promise<void>;
    },
  ) {
    const settings = options.settings;
    if (settings.openai)
      this.providers.set(
        'openai-decisions',
        openaiDecisionProvider(settings.openai),
      );
    if (settings.jev)
      this.providers.set('jev', jevDecisionProvider(settings.jev));
    if (settings.structured)
      this.providers.set(
        'vercel-structured',
        structuredDecisionProvider(settings.structured),
      );
    this.ready = this.initialize();
    void this.ready.catch(() => {});
  }
  private get store() {
    return this.options.store;
  }
  async initialize() {
    if (this.ready) return this.ready;
    await this.store.tx(async () => {
      await this.store.db.lock('schema:studio.decision-models');
      await this.store.db.exec(`
   CREATE TABLE IF NOT EXISTS studio_decision_profiles(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,profile_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS studio_decision_calls(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),artifact_version INTEGER NOT NULL,purpose TEXT NOT NULL,input_hash TEXT NOT NULL,request_hash TEXT NOT NULL,idempotency_key TEXT UNIQUE NOT NULL,profile_json TEXT NOT NULL,request_json TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,fence BIGINT NOT NULL DEFAULT 0,lease_owner TEXT,lease_expires BIGINT,result_json TEXT,error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS studio_decision_cache ON studio_decision_calls(project_id,artifact_id,user_id,request_hash,status,created_at);
  `);
    });
  }
  private registration(profile: Pick<DecisionProfile, 'provider'>) {
    const settings = this.options.settings;
    const config =
      profile.provider === 'openai-decisions'
        ? settings.openai
        : profile.provider === 'jev'
          ? settings.jev
          : settings.structured;
    return hash({
      provider: profile.provider,
      modelCatalog: config?.models ?? [],
      baseUrl:
        config?.baseUrl ??
        (profile.provider === 'vercel-structured'
          ? 'https://ai-gateway.vercel.sh/v3/ai'
          : null),
      adapterVersion:
        this.providers.get(profile.provider)?.version ?? 'unconfigured',
      configurationVersion: settings.configRevision ?? 'v1',
      questionPolicyVersion: 'decision-policy-v1',
    });
  }
  private captured(profile: DecisionProfile): DecisionProfile {
    return {
      ...profile,
      configRevision: this.registration(profile),
      policyVersion: 'decision-policy-v1',
    };
  }
  catalog(): DecisionProfileView['providers'] {
    const settings = this.options.settings;
    return [
      {
        id: 'openai-decisions',
        label: 'OpenAI Decisions API',
        configured: !!settings.openai,
        reason: settings.openai
          ? null
          : 'The native OpenAI Decisions API credential is not configured.',
        models: settings.openai?.models ?? ['gpt-6-luna'],
        mode: 'native-decision',
      },
      {
        id: 'jev',
        label: 'Jev / TypeSafe',
        configured: !!settings.jev,
        reason: settings.jev
          ? null
          : 'The native Jev/TypeSafe credential is not configured.',
        models: settings.jev?.models ?? ['jev-latest'],
        mode: 'native-decision',
      },
      {
        id: 'vercel-structured',
        label: 'Vercel AI SDK structured generation',
        configured: !!settings.structured,
        reason: settings.structured
          ? null
          : 'No explicit structured decision model is registered. Chat configuration does not enable this provider.',
        models: settings.structured?.models ?? [],
        mode: 'structured-generation',
      },
    ];
  }
  capabilities(profile: DecisionProfile) {
    return {
      maxInputBytes: profile.provider === 'jev' ? 32000 : 120000,
      maxQuestions: 64,
      nativeProbabilities: profile.provider !== 'vercel-structured',
    };
  }
  async profile(
    user: User,
    id: string,
    update?: DecisionProfile,
  ): Promise<DecisionProfileView> {
    await this.ready;
    const artifact = await this.store.artifact(
        id,
        user.id,
        update ? 'write' : 'read',
      ),
      outer = this.store.db.inTransaction();
    if (update) {
      const value = decisionProfileSchema.parse(update),
        provider = this.catalog().find(
          (provider) => provider.id === value.provider,
        );
      if (!provider?.models.includes(value.model))
        throw new HttpError(
          400,
          'Choose a registered decision provider and model',
        );
      const captured = this.captured(value);
      await this.store.tx(async () => {
        await this.store.db.lock('project:' + artifact.projectId);
        await this.store.artifact(id, user.id, 'write');
        await this.store.exec(
          'INSERT INTO studio_decision_profiles(artifact_id,profile_json,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET profile_json=excluded.profile_json,revision=studio_decision_profiles.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
          id,
          JSON.stringify(captured),
          user.id,
          stamp(),
        );
        await this.store.audit(
          artifact.projectId,
          id,
          user.name,
          'decision.profile.updated',
          JSON.stringify(captured),
        );
      });
      if (!outer)
        await this.options.notify?.(artifact.projectId, id).catch(() => {});
    }
    return {
      profile: await this.captureProfile(user, id),
      independentOfChat: true,
      requiresExplicitFallback: true,
      providers: this.catalog(),
    };
  }
  async captureProfile(user: User, id: string): Promise<DecisionProfile> {
    await this.ready;
    await this.store.artifact(id, user.id);
    const row = await this.store.one(
      'SELECT profile_json FROM studio_decision_profiles WHERE artifact_id=?',
      id,
    );
    return this.captured(
      decisionProfileSchema.parse(
        row
          ? JSON.parse(row.profile_json)
          : this.options.settings.defaultProfile,
      ),
    );
  }
  async readEvaluation(
    user: User,
    id: string,
  ): Promise<DecisionEvaluation | null> {
    await this.ready;
    const row = await this.store.one(
      'SELECT artifact_id,result_json FROM studio_decision_calls WHERE id=?',
      id,
    );
    if (!row) throw new HttpError(404, 'Decision evaluation not found');
    await this.store.artifact(row.artifact_id, user.id);
    return row.result_json ? JSON.parse(row.result_json) : null;
  }
  async history(user: User, id: string): Promise<DecisionEvaluation[]> {
    await this.ready;
    await this.store.artifact(id, user.id);
    const rows = await this.store.all(
      'SELECT result_json FROM studio_decision_calls WHERE artifact_id=? AND result_json IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 100',
      id,
    );
    return rows.map((row) => JSON.parse(row.result_json));
  }
  private async locked<T>(id: string, operation: (row: any) => Promise<T>) {
    const scope = await this.store.one(
      'SELECT project_id FROM studio_decision_calls WHERE id=?',
      id,
    );
    if (!scope)
      throw new DecisionLeaseLostError(
        'The decision request no longer exists',
      );
    return this.store.tx(async () => {
      await this.store.db.lock('project:' + scope.project_id);
      await this.store.db.lock('decision-call:' + id);
      const row = await this.store.one(
        'SELECT * FROM studio_decision_calls WHERE id=?',
        id,
      );
      if (!row)
        throw new DecisionLeaseLostError(
          'The decision request no longer exists',
        );
      return operation(row);
    });
  }
  private assertLease(row: any, fence: number) {
    if (
      row.status !== 'running' ||
      row.lease_owner !== this.owner ||
      Number(row.fence) !== fence ||
      Number(row.lease_expires) <= Date.now()
    )
      throw new DecisionLeaseLostError(
        'The decision attempt lost its result lease',
      );
  }
  private normalize(
    id: string,
    input: DecisionInvocation,
    result: ProviderDecision | undefined,
    startedAt: string,
    error?: DecisionAnswer['error'],
  ): DecisionEvaluation {
    const answers: DecisionAnswer[] = input.questions.map(
      (question, index) => {
        const native = result?.answers[index];
        if (error)
          return {
            questionId: question.id,
            kind: question.kind,
            status: 'error',
            value: null,
            candidate: null,
            probability: null,
            confidence: null,
            probabilities: [],
            error,
          };
        if (
          !native ||
          native.questionId !== question.id ||
          native.kind !== question.kind
        )
          throw new DecisionProviderError('invalid-response', false);
        if (native.refused)
          return {
            questionId: question.id,
            kind: question.kind,
            status: 'refused',
            value: null,
            candidate: null,
            probability: null,
            confidence: null,
            probabilities: [],
            error: 'provider-refusal',
          };
        const certainty =
          native.probability !== undefined
            ? Math.max(native.probability, 1 - native.probability)
            : native.confidence;
        const abstained =
          native.abstained ||
          (certainty !== undefined &&
            (certainty < input.profile.minimumConfidence ||
              (question.kind === 'boolean' && certainty === 0.5)));
        return {
          questionId: question.id,
          kind: question.kind,
          status: abstained ? 'abstained' : 'answered',
          value: abstained ? null : (native.value ?? null),
          candidate: native.value ?? null,
          probability: native.probability ?? null,
          confidence: native.confidence ?? null,
          probabilities: native.probabilities ?? [],
          ...(abstained ? { error: 'low-confidence' as const } : {}),
        };
      },
    );
    const statuses = new Set(answers.map((answer) => answer.status));
    const status: DecisionEvaluation['status'] =
      error === 'cancelled'
        ? 'cancelled'
        : statuses.size > 1
          ? 'partial'
          : answers[0]!.status;
    const finishedAt = stamp(),
      provider = this.providers.get(input.profile.provider);
    return {
      id,
      status,
      answers,
      provenance: {
        provider: input.profile.provider,
        requestedModel: input.profile.model,
        model: result?.model ?? input.profile.model,
        adapterVersion: provider?.version ?? 'unconfigured',
        promptVersion: input.policyVersion ?? promptVersion,
        inputHash: hash(input.input),
        requestHash: this.requestHash(input),
        artifactVersion: input.artifactVersion,
        minimumConfidence: input.profile.minimumConfidence,
        configRevision:
          input.profile.configRevision ?? this.registration(input.profile),
        purpose: input.purpose,
        modelResolution: 'provider-resolved-at-execution',
        startedAt,
        finishedAt,
        latencyMs: Date.parse(finishedAt) - Date.parse(startedAt),
        providerRequestId: result?.providerRequestId ?? null,
        usage: result?.usage ?? {
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
        },
        cachedFrom: null,
        mode:
          provider?.mode ??
          (input.profile.provider === 'vercel-structured'
            ? 'structured-generation'
            : 'native-decision'),
      },
    };
  }
  private requestHash(input: DecisionInvocation) {
    return hash({
      artifactId: input.artifactId,
      actor: input.user.id,
      artifactVersion: input.artifactVersion,
      profile: input.profile,
      purpose: input.purpose,
      policyVersion: input.policyVersion ?? promptVersion,
      input: input.input,
      questions: input.questions,
    });
  }
  async decide(input: DecisionInvocation): Promise<DecisionEvaluation> {
    await this.ready;
    if (this.closing)
      throw new HttpError(503, 'Decision models are shutting down');
    if (this.store.db.inTransaction())
      throw new Error(
        'Decision model network evaluation must run outside source SQL transactions',
      );
    const task = this.drive(input);
    this.tasks.add(task);
    try {
      return await task;
    } finally {
      this.tasks.delete(task);
    }
  }
  private async drive(
    value: DecisionInvocation,
  ): Promise<DecisionEvaluation> {
    const input: DecisionInvocation = {
      ...value,
      profile: decisionProfileSchema.parse(value.profile),
      questions: decisionQuestionsSchema.parse(value.questions),
    };
    z.enum(decisionPurposes).parse(input.purpose);
    z.number().int().positive().parse(input.artifactVersion);
    if (!input.idempotencyKey || input.idempotencyKey.length > 300)
      throw new HttpError(
        400,
        'A bounded stable decision idempotency key is required',
      );
    if (typeof input.input !== 'string' || !input.input.trim())
      throw new HttpError(
        400,
        'Decision evaluation needs immutable source input',
      );
    const limit = this.capabilities(input.profile).maxInputBytes;
    if (
      Buffer.byteLength(
        JSON.stringify({ input: input.input, questions: input.questions }),
      ) > limit
    )
      throw new HttpError(
        413,
        'The decision source and questions exceed this provider’s bounded text context; split the assessment explicitly',
      );
    if (
      input.profile.configRevision &&
      input.profile.configRevision !== this.registration(input.profile)
    )
      throw new HttpError(
        409,
        'The captured decision provider registration changed; review and resubmit this assessment',
      );
    input.profile = this.captured(input.profile);
    const registered = this.catalog().find(
      (provider) => provider.id === input.profile.provider,
    );
    if (!registered?.models.includes(input.profile.model))
      throw new HttpError(
        409,
        'The captured decision model is no longer registered',
      );
    if (!registered.configured)
      throw new HttpError(
        503,
        registered.reason ?? 'The selected decision provider is unavailable',
      );
    const provider = this.providers.get(input.profile.provider)!;
    const artifact = await this.store.artifact(
        input.artifactId,
        input.user.id,
        'write',
      ),
      fingerprint = this.requestHash(input),
      key = hash([
        artifact.projectId,
        input.artifactId,
        input.user.id,
        input.idempotencyKey,
      ]);
    const row = await this.store.tx(async () => {
      await this.store.db.lock('project:' + artifact.projectId);
      await this.store.artifact(input.artifactId, input.user.id, 'write');
      const old = await this.store.one(
        'SELECT * FROM studio_decision_calls WHERE idempotency_key=?',
        key,
      );
      if (old) {
        if (old.request_hash !== fingerprint)
          throw new HttpError(
            409,
            'This decision idempotency key already evaluated different source, questions or model settings',
          );
        return old;
      }
      const cached = await this.store.one(
        "SELECT * FROM studio_decision_calls WHERE project_id=? AND artifact_id=? AND user_id=? AND request_hash=? AND status='completed' AND created_at>=? ORDER BY created_at DESC LIMIT 1",
        artifact.projectId,
        input.artifactId,
        input.user.id,
        fingerprint,
        new Date(Date.now() - 1800000).toISOString(),
      );
      const id = randomUUID(),
        at = stamp();
      let result: string | null = null;
      if (cached?.result_json) {
        const reuse = JSON.parse(cached.result_json) as DecisionEvaluation;
        result = JSON.stringify({
          ...reuse,
          id,
          provenance: {
            ...reuse.provenance,
            cachedFrom: reuse.id,
            startedAt: at,
            finishedAt: at,
            latencyMs: 0,
            usage: {
              inputTokens: null,
              outputTokens: null,
              totalTokens: null,
            },
          },
        });
      }
      await this.store.exec(
        'INSERT INTO studio_decision_calls(id,project_id,artifact_id,user_id,artifact_version,purpose,input_hash,request_hash,idempotency_key,profile_json,request_json,status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id,
        artifact.projectId,
        input.artifactId,
        input.user.id,
        input.artifactVersion,
        input.purpose,
        hash(input.input),
        fingerprint,
        key,
        JSON.stringify(input.profile),
        JSON.stringify({
          purpose: input.purpose,
          input: input.input,
          questions: input.questions,
          policyVersion: input.policyVersion ?? promptVersion,
        }),
        result ? 'completed' : 'queued',
        result,
        at,
        at,
      );
      return await this.store.one(
        'SELECT * FROM studio_decision_calls WHERE id=?',
        id,
      );
    });
    if (row.result_json) return JSON.parse(row.result_json);
    const overall = AbortSignal.any([
      ...(input.signal ? [input.signal] : []),
      AbortSignal.timeout(this.options.settings.timeoutMs),
    ]);
    while (true) {
      overall.throwIfAborted();
      const claimed = await this.locked(row.id, async (current) => {
        await this.store.artifact(input.artifactId, input.user.id, 'write');
        if (terminal(current.status))
          return { result: JSON.parse(current.result_json) };
        if (
          current.status === 'running' &&
          Number(current.lease_expires) > Date.now()
        )
          return null;
        if (Number(current.attempts) >= 3) {
          const failed = this.normalize(
            current.id,
            input,
            undefined,
            current.created_at,
            'provider-error',
          );
          await this.store.exec(
            "UPDATE studio_decision_calls SET status='error',result_json=?,lease_owner=NULL,lease_expires=NULL,error_code='provider-error',updated_at=? WHERE id=?",
            JSON.stringify(failed),
            stamp(),
            current.id,
          );
          return { result: failed };
        }
        const lease = this.options.settings.leaseMs ?? 45000;
        await this.store.exec(
          "UPDATE studio_decision_calls SET status='running',attempts=attempts+1,fence=fence+1,lease_owner=?,lease_expires=?,updated_at=? WHERE id=?",
          this.owner,
          Date.now() + lease,
          stamp(),
          current.id,
        );
        return { fence: Number(current.fence) + 1 };
      });
      if (claimed && 'result' in claimed) return claimed.result;
      if (!claimed) {
        await delay(25, undefined, { signal: overall });
        continue;
      }
      const controller = new AbortController();
      this.controllers.add(controller);
      const signal = AbortSignal.any([overall, controller.signal]);
      let heartbeat: Promise<void> | undefined;
      const timer = setInterval(
        () => {
          if (heartbeat) return;
          heartbeat = this.locked(row.id, async (current) => {
            this.assertLease(current, claimed.fence!);
            await this.store.artifact(
              input.artifactId,
              input.user.id,
              'write',
            );
            await this.store.exec(
              'UPDATE studio_decision_calls SET lease_expires=? WHERE id=? AND fence=?',
              Date.now() + (this.options.settings.leaseMs ?? 45000),
              row.id,
              claimed.fence!,
            );
          })
            .catch((error) => controller.abort(error))
            .finally(() => {
              heartbeat = undefined;
            });
        },
        Math.max(
          25,
          Math.floor((this.options.settings.leaseMs ?? 45000) / 3),
        ),
      );
      timer.unref();
      let response: ProviderDecision | undefined,
        error: unknown,
        started = stamp();
      try {
        response = await provider.evaluate({
          profile: input.profile,
          input: input.input,
          questions: input.questions,
          idempotencyKey: key,
          signal,
        });
        signal.throwIfAborted();
      } catch (caught) {
        error = caught;
      }
      clearInterval(timer);
      await heartbeat;
      this.controllers.delete(controller);
      const retry =
        error instanceof DecisionProviderError &&
        error.retryable &&
        !signal.aborted;
      const errorCode: DecisionAnswer['error'] | undefined = error
        ? signal.aborted
          ? 'cancelled'
          : error instanceof z.ZodError ||
              (error instanceof DecisionProviderError &&
                error.code === 'invalid-response')
            ? 'invalid-response'
            : 'provider-error'
        : undefined;
      const evaluation = this.normalize(
        row.id,
        input,
        response,
        started,
        errorCode,
      );
      const published = await this.locked(row.id, async (current) => {
        this.assertLease(current, claimed.fence!);
        await this.store.artifact(input.artifactId, input.user.id, 'write');
        if (retry && Number(current.attempts) < 3) {
          await this.store.exec(
            "UPDATE studio_decision_calls SET status='queued',lease_owner=NULL,lease_expires=NULL,error_code='provider-error',updated_at=? WHERE id=? AND fence=?",
            stamp(),
            row.id,
            claimed.fence!,
          );
          return false;
        }
        await this.store.exec(
          'UPDATE studio_decision_calls SET status=?,result_json=?,lease_owner=NULL,lease_expires=NULL,error_code=?,updated_at=? WHERE id=? AND fence=?',
          evaluation.status === 'error'
            ? 'error'
            : evaluation.status === 'cancelled'
              ? 'cancelled'
              : 'completed',
          JSON.stringify(evaluation),
          errorCode ?? null,
          stamp(),
          row.id,
          claimed.fence!,
        );
        return true;
      });
      if (published) {
        await this.options
          .notify?.(artifact.projectId, input.artifactId)
          .catch(() => {});
        return evaluation;
      }
      await delay(200, undefined, { signal: overall });
    }
  }
  async close() {
    this.closing = true;
    for (const controller of this.controllers)
      controller.abort(new Error('Decision model service is shutting down'));
    await Promise.allSettled([...this.tasks]);
    await this.ready.catch(() => {});
  }
}
