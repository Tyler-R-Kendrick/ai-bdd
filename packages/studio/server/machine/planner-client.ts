import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { AcpClient } from '../machine-worker.ts';
import { readMachineJson } from './http.ts';
import {
  remoteFeatures,
  remoteQuestionInputSchema,
  remoteQuestionValue,
  remoteStreamPartSchema,
  type RemoteActivity,
  type RemoteQuestionInput,
  type RemoteRuns,
  type RemoteStreamPart,
  type RemoteFeature,
} from '../../shared/remote-agent.ts';
import type {
  PlannerOutput,
  RemoteTurn,
} from '../integrations/remote-planner.ts';
export type RemoteInputResult = {
  status: 'answered' | 'cancelled' | 'failed';
  value?: unknown;
  message?: string;
};
export type RemotePlannerClientContext = {
  requestId: string;
  features: Set<RemoteFeature>;
  resume?: RemoteActivity;
  sendPart: (part: RemoteStreamPart, eventId?: string) => Promise<void>;
  declareTools: (names: string[]) => Promise<void>;
  reportRuns: (report: RemoteRuns) => Promise<void>;
  ask: (
    questionId: string,
    input: RemoteQuestionInput,
    scope?: {
      runId?: string;
      rootRunId?: string;
      stageId?: string;
      block?: { index: number; digest: string };
    },
  ) => Promise<RemoteInputResult>;
  onControl: (
    callback: (
      control: { action: 'pause' | 'resume'; runId?: string },
      signal: AbortSignal,
    ) => Promise<{ ok: boolean; message?: string }>,
  ) => void;
};
export type PlannerClientOptions = {
  origin: string;
  token: string;
  artifactId: string;
  signal: AbortSignal;
  getToken?: () => Promise<string>;
  run: (
    turn: RemoteTurn,
    signal: AbortSignal,
    context: RemotePlannerClientContext,
  ) => Promise<PlannerOutput>;
  onAttached?: () => void;
  activeTurnMs?: number;
  resumeSession?: (
    turn: RemoteTurn,
    signal: AbortSignal,
    context: RemotePlannerClientContext,
  ) => Promise<void>;
  onActivity?: (event: {
    requestId: string;
    status: 'running' | 'waiting' | 'paused' | 'finished';
  }) => void;
};
/** Client-only protocol runtime. No server Store/Auth/provider modules enter the portable connector. */
export async function connectRemotePlanner(options: PlannerClientOptions) {
  const origin = new URL(options.origin);
  if (
    origin.origin !== options.origin ||
    origin.username ||
    origin.password ||
    (origin.protocol !== 'https:' &&
      !(
        origin.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      ))
  )
    throw new Error(
      'Planner origin must use HTTPS; local development may use loopback HTTP',
    );
  let failures = 0;
  while (!options.signal.aborted) {
    const token = await (options.getToken?.() ??
      Promise.resolve(options.token));
    const socket = new WebSocket(
      options.origin.replace(/^http/, 'ws') + '/api/planner/connect',
      'studio.planner.v1',
      {
        headers: {
          Authorization: 'Bearer ' + token,
          'Studio-Planner-Features': remoteFeatures.join(','),
        },
        maxPayload: 512000,
      },
    );
    const tasks = new Set<Promise<void>>(),
      controllers = new Map<string, AbortController>(),
      contexts = new Map<
        string,
        {
          context: RemotePlannerClientContext;
          control?: (
            control: { action: 'pause' | 'resume'; runId?: string },
            signal: AbortSignal,
          ) => Promise<{ ok: boolean; message?: string }>;
        }
      >(),
      acks = new Map<
        string,
        {
          resolve: () => void;
          reject: (error: unknown) => void;
          requestId: string;
        }
      >(),
      questions = new Map<
        string,
        { resolve: (result: RemoteInputResult) => void; requestId: string }
      >();
    let attached = false,
      terminal = false,
      features = new Set<RemoteFeature>();
    const send = (value: unknown) => {
      const data = JSON.stringify(value);
      if (Buffer.byteLength(data) > 512000 || socket.bufferedAmount > 1024000)
        throw new Error('Planner frame exceeds its bounded send budget');
      if (socket.readyState !== 1) throw new Error('Planner connection closed');
      socket.send(data);
    };
    const publish = (
      requestId: string,
      value: Record<string, unknown>,
      eventId: string = crypto.randomUUID(),
    ) =>
      new Promise<void>((resolve, reject) => {
        if (acks.size >= 64) {
          reject(new Error('Too many unacknowledged Planner events'));
          return;
        }
        acks.set(eventId, { resolve, reject, requestId });
        try {
          send({ requestId, eventId, ...value });
        } catch (error) {
          acks.delete(eventId);
          reject(error);
        }
      });
    const endRequest = (requestId: string, reason: unknown) => {
      controllers.get(requestId)?.abort(reason);
      controllers.delete(requestId);
      contexts.delete(requestId);
      for (const [id, ack] of acks)
        if (ack.requestId === requestId) {
          acks.delete(id);
          ack.reject(reason);
        }
      for (const [id, question] of questions)
        if (question.requestId === requestId) {
          questions.delete(id);
          question.resolve({
            status: 'cancelled',
            message: 'The turn ended or disconnected',
          });
        }
    };
    const abort = () => socket.terminate();
    options.signal.addEventListener('abort', abort, { once: true });
    const ended = new Promise<void>((resolve) => {
      socket.on('error', () => {});
      socket.on('open', () =>
        send({ type: 'attach', version: 1, artifactId: options.artifactId }),
      );
      socket.on('message', (data, binary) => {
        try {
          if (binary) throw new Error('Expected Planner JSON');
          const message = JSON.parse(data.toString());
          if (message.type === 'attached') {
            attached = true;
            failures = 0;
            features = new Set(
              (message.features ?? []).filter((feature: RemoteFeature) =>
                remoteFeatures.includes(feature),
              ),
            );
            options.onAttached?.();
            return;
          }
          if (message.type === 'event-accepted') {
            const ack = acks.get(message.eventId);
            if (ack) {
              acks.delete(message.eventId);
              ack.resolve();
            }
            return;
          }
          if (message.type === 'input-result') {
            const key = message.requestId + ':' + message.questionId,
              pending = questions.get(key);
            if (pending) {
              questions.delete(key);
              pending.resolve({
                status: message.status,
                value: message.value,
                message: message.message,
              });
              options.onActivity?.({
                requestId: message.requestId,
                status: 'running',
              });
            }
            return;
          }
          if (message.type === 'abort' || message.type === 'request-closed') {
            endRequest(
              message.requestId,
              new Error('The server ended this remote turn'),
            );
            return;
          }
          if (message.type === 'control') {
            const entry = contexts.get(message.requestId),
              controller = controllers.get(message.requestId);
            void (async () => {
              let result: { ok: boolean; message?: string } = {
                ok: false,
                message:
                  'This backend does not support pausing its workflow runtime',
              };
              if (entry?.control && controller && !controller.signal.aborted)
                try {
                  result = await entry.control(
                    { action: message.action, runId: message.runId },
                    controller.signal,
                  );
                } catch {
                  result = {
                    ok: false,
                    message: 'The backend could not apply this control',
                  };
                }
              if (socket.readyState === 1)
                send({
                  type: 'control-result',
                  requestId: message.requestId,
                  controlId: message.controlId,
                  ...result,
                });
              if (result.ok)
                options.onActivity?.({
                  requestId: message.requestId,
                  status: message.action === 'pause' ? 'paused' : 'running',
                });
            })();
            return;
          }
          if (message.type !== 'turn' && message.type !== 'resume-session')
            return;
          if (controllers.has(message.requestId)) return;
          if (tasks.size >= 4)
            throw new Error('Planner concurrency limit exceeded');
          const controller = new AbortController(),
            requestId = String(message.requestId);
          controllers.set(requestId, controller);
          const limit = new AbortController();
          const signal = AbortSignal.any([
            options.signal,
            controller.signal,
            limit.signal,
          ]);
          let remaining = options.activeTurnMs ?? 120000,
            started = Date.now(),
            waiters = 0,
            finished = false,
            timer: ReturnType<typeof setTimeout> | undefined;
          if (
            !Number.isSafeInteger(remaining) ||
            remaining < 100 ||
            remaining > 600000
          )
            throw new Error(
              'Choose an active turn budget between100 and600000ms',
            );
          const schedule = () => {
            if (finished || waiters || signal.aborted) return;
            started = Date.now();
            timer = setTimeout(
              () =>
                limit.abort(
                  new Error(
                    'Active remote model work exceeded its time budget',
                  ),
                ),
              Math.max(1, remaining),
            );
            timer.unref();
          };
          const hold = () => {
            if (waiters++ === 0) {
              clearTimeout(timer);
              remaining -= Date.now() - started;
            }
          };
          const release = () => {
            waiters = Math.max(0, waiters - 1);
            if (!waiters) schedule();
          };
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              if (limit.signal.aborted && socket.readyState === 1)
                send({
                  type: 'failed',
                  requestId,
                  ...(features.size
                    ? {
                        message:
                          'Active remote model work exceeded its time budget',
                      }
                    : {}),
                });
              endRequest(requestId, signal.reason);
            },
            { once: true },
          );
          schedule();
          const task = (async () => {
            try {
              let resume: RemoteActivity | undefined;
              if (message.resume) {
                const currentToken = await (options.getToken?.() ??
                    Promise.resolve(options.token)),
                  response = await fetch(
                    options.origin +
                      `/api/artifacts/${options.artifactId}/planner/requests/${encodeURIComponent(requestId)}`,
                    {
                      headers: { Authorization: 'Bearer ' + currentToken },
                      redirect: 'error',
                      signal,
                    },
                  );
                if (!response.ok)
                  throw new Error(
                    'The remote turn could not resume its persisted state',
                  );
                resume = await readMachineJson(
                  response,
                  signal,
                  3 * 1024 * 1024,
                );
                if (
                  resume?.id !== requestId ||
                  resume.threadId !== message.input.threadId
                )
                  throw new Error('Remote resume scope changed');
              }
              const entry: {
                context: RemotePlannerClientContext;
                control?: (
                  control: { action: 'pause' | 'resume'; runId?: string },
                  signal: AbortSignal,
                ) => Promise<{ ok: boolean; message?: string }>;
              } = { context: null as any };
              const context: RemotePlannerClientContext = {
                requestId,
                features,
                resume,
                sendPart: (part, eventId) =>
                  publish(
                    requestId,
                    { type: 'part', part: remoteStreamPartSchema.parse(part) },
                    eventId,
                  ),
                declareTools: (names) =>
                  publish(requestId, { type: 'tools', names }),
                reportRuns: (report) =>
                  publish(requestId, { type: 'runs', ...report }),
                ask: async (questionId, input, scope = {}) => {
                  if (!features.has('questions'))
                    return {
                      status: 'failed',
                      message:
                        'This server did not negotiate interactive questions',
                    };
                  const parsed = remoteQuestionInputSchema.parse(input),
                    old = resume?.questions.find(
                      (question) => question.id === questionId,
                    );
                  if (
                    old &&
                    JSON.stringify(old.input) !== JSON.stringify(parsed)
                  )
                    throw new Error(
                      'A resumed question cannot change its input',
                    );
                  if (old && old.status !== 'open')
                    return {
                      status:
                        old.status === 'answered' ? 'answered' : 'cancelled',
                      value: remoteQuestionValue(old),
                    };
                  const key = requestId + ':' + questionId;
                  if (questions.has(key))
                    throw new Error('Question identity is already waiting');
                  const waiting = new Promise<RemoteInputResult>((resolve) =>
                    questions.set(key, { resolve, requestId }),
                  );
                  try {
                    if (!old)
                      await publish(requestId, {
                        type: 'input-request',
                        questionId,
                        input: parsed,
                        ...scope,
                      });
                    hold();
                    options.onActivity?.({ requestId, status: 'waiting' });
                    try {
                      return await waiting;
                    } finally {
                      release();
                    }
                  } catch (error) {
                    questions.delete(key);
                    throw error;
                  }
                },
                onControl: (callback) => {
                  entry.control = callback;
                },
              };
              entry.context = context;
              contexts.set(requestId, entry);
              options.onActivity?.({ requestId, status: 'running' });
              if (message.type === 'resume-session') {
                if (options.resumeSession)
                  await options.resumeSession(message.input, signal, context);
                else if (resume)
                  await context.reportRuns({
                    active: [],
                    paused: [],
                    cards: resume.runs.cards.map((card) => ({
                      ...card,
                      status: ['running', 'waiting', 'paused'].includes(
                        card.status,
                      )
                        ? 'stopped'
                        : card.status,
                      updated: Math.floor(Date.now() / 1000),
                      stagesDelta: true,
                      earlierStages: undefined,
                      stages: [],
                    })),
                  });
                return;
              }
              const output = await options.run(message.input, signal, context);
              signal.throwIfAborted();
              send({ type: 'result', requestId, output });
              options.onActivity?.({ requestId, status: 'finished' });
            } catch (error) {
              if (socket.readyState === 1 && !signal.aborted)
                send({
                  type: 'failed',
                  requestId,
                  message:
                    error instanceof Error
                      ? error.message.slice(0, 4000)
                      : 'Remote Planner failed',
                });
            }
          })().finally(() => {
            finished = true;
            clearTimeout(timer);
            tasks.delete(task);
          });
          tasks.add(task);
        } catch {
          socket.close(1002, 'Invalid Planner protocol frame');
        }
      });
      socket.on('close', (code) => {
        terminal = [4401, 4403, 4406, 1002].includes(code);
        resolve();
      });
    });
    await ended;
    options.signal.removeEventListener('abort', abort);
    for (const id of controllers.keys())
      endRequest(id, new Error('Remote connection closed'));
    await Promise.allSettled([...tasks]);
    if (options.signal.aborted) return;
    if (terminal)
      throw new Error(
        'Planner authorization, ownership or protocol changed; reconnect after resolving it',
      );
    await delay(
      Math.min(30000, 250 * 2 ** Math.min(7, failures++)),
      undefined,
      { signal: options.signal },
    ).catch(() => {});
    if (!attached && failures >= 8)
      throw new Error('Could not establish the remote Planner connection');
  }
}
/** Operator-selected ACP runtime: supplied model identity is intent, actual model remains unknown unless reported by the backend. */
export function runRemotePlanner(
  options: Omit<PlannerClientOptions, 'run'> & {
    command: string;
    args: string[];
    cwd: string;
    allowPermissions?: string[];
  },
) {
  return connectRemotePlanner({
    ...options,
    run: async (turn, signal, context) => {
      let pending = Promise.resolve(),
        started = context.resume?.stream.started ?? false,
        textId: string | undefined;
      const emit = (text: string) => {
        pending = pending.then(async () => {
          if (!context.features.has('stream-parts')) return;
          if (!started) {
            await context.sendPart({ type: 'stream-start' });
            started = true;
          }
          if (!textId) {
            textId = crypto.randomUUID();
            await context.sendPart({ type: 'text-start', id: textId });
          }
          for (let at = 0; at < text.length; at += 20000)
            await context.sendPart({
              type: 'text-delta',
              id: textId,
              delta: text.slice(at, at + 20000),
            });
        });
        void pending.catch(() => {});
      };
      const acp = new AcpClient({
        command: options.command,
        args: options.args,
        cwd: options.cwd,
        signal,
        allowPermissions: options.allowPermissions,
        onSessionUpdate: (update) => {
          const value = update as any;
          if (
            value?.sessionUpdate === 'agent_message_chunk' &&
            value.content?.type === 'text'
          )
            emit(value.content.text);
        },
        requestInput: async (value) => {
          const params = value as Record<string, any>,
            {
              sessionId: _sessionId,
              questionId,
              runId,
              rootRunId,
              stageId,
              block,
              ...rest
            } = params;
          return context.ask(
            typeof questionId === 'string' ? questionId : crypto.randomUUID(),
            remoteQuestionInputSchema.parse(params.input ?? rest),
            { runId, rootRunId, stageId, block },
          );
        },
      });
      try {
        const result = await acp.run({
          kind: 'planner',
          ...turn,
          runtimeModel: { selection: 'operator-controlled', actualModel: null },
          resume: context.resume
            ? {
                cursor: context.resume.cursor,
                questions: context.resume.questions,
                stream: context.resume.stream,
              }
            : undefined,
        });
        await pending;
        if (textId) await context.sendPart({ type: 'text-end', id: textId });
        return { text: result.summary, content: result.content ?? null };
      } finally {
        acp.close();
      }
    },
  });
}
