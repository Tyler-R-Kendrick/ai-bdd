import { mkdir, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  AcpClient,
  machineApi,
  type AcpOptions,
  type MachineCredentials,
} from '../machine-worker.ts';
import {
  prepareWorktree,
  inspectCheckout,
  privateJson,
  readPrivateJson,
  reconnect,
  MachineTransportError,
} from './runtime.ts';
import {
  resumeImplementationReports,
  type ImplementationBridgeState,
} from './implementation-bridge.ts';
import type { ImplementationRun } from '../../shared/implementation.ts';
const execute = promisify(execFile);
const activeSchema = z
  .object({
    version: z.literal(1),
    queueId: z.string().uuid(),
    generation: z.number().int().positive(),
    leaseToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    machineId: z.string().uuid(),
    origin: z.string().url(),
    phase: z.enum(['executing', 'completed']),
    worktree: z.string(),
  })
  .strict();
export async function resumeImplementationRuns(
  credentials: MachineCredentials,
  stateDirectory: string,
  signal?: AbortSignal,
) {
  await resumeImplementationReports(
    credentials,
    join(stateDirectory, 'graph-reports'),
    signal,
  );
  const directory = join(stateDirectory, 'graph-runs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of (await readdir(directory))
    .filter((file) => /^[0-9a-f-]{36}\.json$/.test(file))
    .slice(0, 100)) {
    const path = join(directory, file),
      active = activeSchema.parse(await readPrivateJson(path));
    if (
      active.origin !== credentials.origin ||
      active.machineId !== credentials.id
    )
      throw new Error('A retained graph run belongs to another machine');
    if (active.phase === 'executing') {
      try {
        await reconnect(
          () =>
            machineApi(
              credentials.origin,
              `/machines/${credentials.id}/implementation/${active.queueId}/stop`,
              credentials.token,
              {
                leaseToken: active.leaseToken,
                generation: active.generation,
                reason:
                  'The connector process ended during execution. The retained checkout requires review; no agent work was repeated.',
              },
              signal,
            ),
          { signal, maxDelayMs: 10000 },
        );
      } catch (error) {
        if (
          !(
            error instanceof MachineTransportError &&
            [404, 409].includes(error.status)
          )
        )
          throw error;
      }
    }
    await rm(path, { force: true });
  }
}
export async function runImplementationOnce(
  credentials: MachineCredentials,
  options: Omit<AcpOptions, 'signal'> & {
    signal?: AbortSignal;
    stateDirectory: string;
    bridgeEntry?: string;
  },
) {
  const checkout = await inspectCheckout(options.cwd);
  await machineApi(
    credentials.origin,
    `/machines/${credentials.id}/investigations/checkout`,
    credentials.token,
    {
      repository: checkout.repository,
      sourceCommit: checkout.sourceCommit,
      branch: checkout.branch,
    },
    options.signal,
  );
  const claimed = await machineApi(
    credentials.origin,
    `/machines/${credentials.id}/implementation/claim`,
    credentials.token,
    undefined,
    options.signal,
  );
  if (!claimed.work) return { claimed: false };
  const work = claimed.work,
    queueId = z.string().uuid().parse(work.id),
    generation = z.number().int().positive().parse(work.generation),
    leaseToken = z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .parse(claimed.leaseToken),
    route = `/machines/${credentials.id}/implementation/${queueId}`,
    activePath = join(options.stateDirectory, 'graph-runs', queueId + '.json');
  const controller = new AbortController(),
    signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(4 * 3600000),
      ...(options.signal ? [options.signal] : []),
    ]);
  let client: AcpClient | undefined,
    heartbeat: NodeJS.Timeout | undefined,
    beating = false,
    tree: Awaited<ReturnType<typeof prepareWorktree>> | undefined,
    completed = false;
  const active = {
    version: 1 as const,
    queueId,
    generation,
    leaseToken,
    machineId: credentials.id,
    origin: credentials.origin,
    phase: 'executing' as const,
    worktree: '',
  };
  await privateJson(activePath, active);
  const call = (
    action: string,
    body: unknown,
    callSignal: AbortSignal = signal,
  ) =>
    reconnect(
      () =>
        machineApi(
          credentials.origin,
          route + '/' + action,
          credentials.token,
          body,
          callSignal,
        ),
      { signal: callSignal, maxDelayMs: 10000 },
    );
  try {
    tree = await prepareWorktree({
      cwd: options.cwd,
      stateDirectory: options.stateDirectory,
      workId: queueId,
      generation,
      repository: work.repository,
      sourceCommit: work.sourceCommit,
    });
    await execute('git', ['checkout', '-b', work.branch], {
      cwd: tree.path,
      timeout: 15000,
      maxBuffer: 8192,
    });
    active.worktree = tree.path;
    await privateJson(activePath, active);
    const actual = await inspectCheckout(tree.path);
    const run = (await call('start', {
      leaseToken,
      generation,
      checkout: {
        expected: work.expected,
        repository: actual.repository,
        commit: actual.sourceCommit,
        branch: actual.branch,
      },
    })) as ImplementationRun;
    heartbeat = setInterval(() => {
      if (beating) return;
      beating = true;
      void call('heartbeat', { leaseToken, generation })
        .catch(() => controller.abort())
        .finally(() => {
          beating = false;
        });
    }, 10000);
    heartbeat.unref();
    const entry = resolve(options.bridgeEntry ?? process.argv[1] ?? '');
    const base: ImplementationBridgeState = {
      version: 1,
      origin: credentials.origin,
      machineId: credentials.id,
      token: credentials.token,
      queueId,
      generation,
      leaseToken,
      runId: run.id,
      outboxDirectory: join(options.stateDirectory, 'graph-reports'),
    };
    const read = () => call('read', { leaseToken, generation });
    const phase = async (
      role: 'implementer' | 'verifier',
      iteration: number,
      verifierToken?: string,
    ) => {
      const stateFile = join(
        options.stateDirectory,
        'runs',
        queueId,
        role + '-' + iteration + '.json',
      );
      await privateJson(stateFile, {
        ...base,
        ...(verifierToken ? { verifierToken } : {}),
      });
      client = new AcpClient({
        ...options,
        cwd: tree!.path,
        signal,
        mcpServers: [
          {
            name: 'studio-implementation',
            command: process.execPath,
            args: [
              '--experimental-transform-types',
              entry,
              '--implementation-mcp',
              stateFile,
            ],
            env: [],
          },
        ],
        promptPrefix:
          role === 'verifier'
            ? 'Perform an independent whole-graph review in this fresh ACP session. Read the approved graph through read_implementation. Inspect the actual checkout and independently collect evidence for every task acceptance criterion. Only report_verification is available: do not change tasks or fabricate test evidence. Your observations are attributed external evidence, distinct from server-executed tests.'
            : 'Implement only the exact human-approved dependency graph. First use read_implementation. Start only dependency-ready tasks, report real PRs or explicit no-change evidence, and complete every task with the scoped lifecycle tools. Request revision when the approved graph cannot be fulfilled. Never replace lifecycle reporting with a summary.',
        readResult: async () => ({
          summary: 'ACP turn finished; the durable lifecycle is authoritative.',
        }),
      });
      try {
        await client.run({
          kind: role,
          queueId,
          runId: run.id,
          sealedSourceSha256: work.sourceSha256,
        });
      } finally {
        client.close();
        client = undefined;
      }
    };
    for (let iteration = 1; iteration <= 3; iteration++) {
      await phase('implementer', iteration);
      let current = await read(),
        state = (current.snapshot.runs as ImplementationRun[]).find(
          (run) => run.id === base.runId,
        )!;
      if (state.status === 'revision_requested') {
        completed = true;
        await privateJson(activePath, { ...active, phase: 'completed' });
        return { claimed: true, workId: queueId, status: 'revision_requested' };
      }
      if (state.tasks.some((task) => task.status !== 'complete'))
        throw new Error(
          'The implementer ended without completing the approved task graph',
        );
      const verifier = await call('verifier', { leaseToken, generation });
      await phase('verifier', iteration, verifier.verifierToken);
      current = await read();
      state = (current.snapshot.runs as ImplementationRun[]).find(
        (run) => run.id === base.runId,
      )!;
      if (['implemented', 'delivered'].includes(state.status)) {
        completed = true;
        await privateJson(activePath, { ...active, phase: 'completed' });
        await rm(activePath, { force: true });
        return { claimed: true, workId: queueId, status: state.status };
      }
      if (state.status === 'revision_requested') {
        completed = true;
        return { claimed: true, workId: queueId, status: 'revision_requested' };
      }
    }
    throw new Error(
      'Three independent review cycles did not complete verification; review the retained checkout before retrying',
    );
  } catch (error) {
    client?.close();
    try {
      await machineApi(
        credentials.origin,
        route + '/stop',
        credentials.token,
        {
          leaseToken,
          generation,
          reason:
            'The local connector did not complete the approved graph and independent review. Review its retained checkout before explicitly retrying.',
        },
        AbortSignal.timeout(5000),
      );
      await rm(activePath, { force: true });
    } catch {}
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    controller.abort();
    client?.close();
    if (completed) await rm(activePath, { force: true });
    await tree?.cleanup();
  }
}
