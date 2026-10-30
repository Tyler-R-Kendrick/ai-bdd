import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  AccountMachineCredentials,
  CheckoutRegistration,
} from '../../shared/account-machines.ts';
import { agentProfileSchema } from '../../shared/agent-profile.ts';
import { machineApi } from '../machine-worker.ts';
import { canonicalCloneRepository } from './clone-registry.ts';
import {
  MachineTransportError,
  permanentRejection,
  privateJson,
  readPrivateJson,
  reconnect,
} from './runtime.ts';

const assignment = z
  .object({
    id: z.string().uuid(),
    artifactId: z.string().uuid(),
    projectId: z.string().uuid(),
    repository: z.string(),
    checkoutKey: z.string(),
    epoch: z.number().int().positive(),
    status: z.string(),
    artifactVersion: z.number().int().positive(),
    sourceHash: z.string(),
    profile: agentProfileSchema,
  })
  .strict();
const claimed = z
  .object({
    assignmentId: z.string().uuid(),
    epoch: z.number().int().positive(),
    artifactId: z.string().uuid(),
    projectId: z.string().uuid(),
    repository: z.string(),
    checkoutKey: z.string(),
    profile: agentProfileSchema,
    artifactVersion: z.number().int().positive(),
    sourceHash: z.string(),
    token: z.string().min(32).max(300),
    expiresAt: z.string().datetime(),
  })
  .strict();
const pending = z
  .object({
    version: z.literal(1),
    accountMachineId: z.string().uuid(),
    origin: z.string(),
    assignmentId: z.string().uuid(),
    epoch: z.number().int().positive(),
    phase: z.enum(['claiming', 'running', 'release']),
    reason: z.enum(['idle', 'stopped', 'failed']),
  })
  .strict();
type Pending = z.infer<typeof pending>;
export type PlannerCheckout = {
  key: string;
  path: string;
  registration: CheckoutRegistration;
};
export type AccountPlannerRunner = (options: {
  origin: string;
  artifactId: string;
  token: string;
  getToken: () => Promise<string>;
  command: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
  allowPermissions?: string[];
}) => Promise<void>;

async function release(
  credentials: AccountMachineCredentials,
  state: Pending,
  file: string,
) {
  try {
    await reconnect(
      () =>
        machineApi(
          credentials.origin,
          `/account-machines/${credentials.id}/planners/${state.assignmentId}/release`,
          credentials.token,
          { epoch: state.epoch, reason: state.reason },
          AbortSignal.timeout(5000),
        ),
      { maxElapsedMs: 5000, maxDelayMs: 500 },
    );
  } catch (error) {
    if (!permanentRejection(error)) throw error;
  }
  await rm(file, { force: true });
}
/** Restart replays only a release receipt, never an uncertain model turn. */
export async function resumeAccountPlanners(
  credentials: AccountMachineCredentials,
  stateDirectory: string,
) {
  const directory = join(stateDirectory, 'account-planners');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of (await readdir(directory))
    .filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))
    .slice(0, 100)) {
    const file = join(directory, name);
    const state = pending.parse(await readPrivateJson(file));
    if (
      state.accountMachineId !== credentials.id ||
      state.origin !== credentials.origin ||
      name !== state.assignmentId + '.json'
    )
      throw new Error(
        'A retained Planner receipt belongs to another account device',
      );
    await release(
      credentials,
      {
        ...state,
        phase: 'release',
        reason: state.phase === 'release' ? state.reason : 'failed',
      },
      file,
    );
  }
}

export async function runAccountPlannerOnce(
  credentials: AccountMachineCredentials,
  checkouts: PlannerCheckout[],
  options: {
    command: string;
    args: string[];
    stateDirectory: string;
    signal: AbortSignal;
    allowPermissions?: string[];
    run: AccountPlannerRunner;
    renewMs?: number;
  },
) {
  await resumeAccountPlanners(credentials, options.stateDirectory);
  const response = z
    .object({ assignments: z.array(assignment).max(100) })
    .strict()
    .parse(
      await machineApi(
        credentials.origin,
        `/account-machines/${credentials.id}/planners/poll`,
        credentials.token,
        { checkouts: checkouts.map((entry) => entry.registration) },
        options.signal,
      ),
    );
  const next = response.assignments.find((value) => value.status === 'queued');
  if (!next) return { claimed: false };
  const local = checkouts.find(
    (entry) =>
      entry.key === next.checkoutKey &&
      entry.registration.repository ===
        canonicalCloneRepository(next.repository),
  );
  if (!local || next.profile.harness !== 'remote-planner')
    throw new Error(
      'The Planner assignment is outside the registered repository or selected harness',
    );
  const file = join(
    options.stateDirectory,
    'account-planners',
    next.id + '.json',
  );
  let state: Pending = {
    version: 1,
    accountMachineId: credentials.id,
    origin: credentials.origin,
    assignmentId: next.id,
    epoch: next.epoch,
    phase: 'claiming',
    reason: 'failed',
  };
  // Save before claim: losing the response is an uncertain claim, not permission
  // to repeat the agent automatically after a process restart.
  await privateJson(file, state);
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome: { reason: Pending['reason'] } = { reason: 'failed' };
  let renewal: Promise<void> | undefined;
  try {
    const lease = claimed.parse(
      await machineApi(
        credentials.origin,
        `/account-machines/${credentials.id}/planners/${next.id}/claim`,
        credentials.token,
        { epoch: next.epoch },
        signal,
      ),
    );
    if (
      lease.assignmentId !== next.id ||
      lease.epoch !== next.epoch ||
      lease.artifactId !== next.artifactId ||
      lease.projectId !== next.projectId ||
      lease.checkoutKey !== local.key ||
      canonicalCloneRepository(lease.repository) !==
        local.registration.repository ||
      lease.artifactVersion !== next.artifactVersion ||
      lease.sourceHash !== next.sourceHash ||
      JSON.stringify(lease.profile) !== JSON.stringify(next.profile)
    )
      throw new Error('The claimed Planner identity or frozen source changed');
    let expires = Date.parse(lease.expiresAt);
    if (expires <= Date.now())
      throw new Error('The Planner scoped credential already expired');
    const renew = () => {
      timer = setTimeout(
        () => {
          renewal = (async () => {
            try {
              const value = z
                .object({
                  expiresAt: z.string().datetime(),
                  idle: z.boolean().optional(),
                })
                .strict()
                .parse(
                  await reconnect(
                    () =>
                      machineApi(
                        credentials.origin,
                        `/account-machines/${credentials.id}/planners/${next.id}/renew`,
                        credentials.token,
                        { epoch: next.epoch },
                        signal,
                      ),
                    {
                      signal,
                      maxElapsedMs: Math.max(
                        1,
                        Math.min(20000, expires - Date.now() - 5000),
                      ),
                      maxDelayMs: 1000,
                    },
                  ),
                );
              if (value.idle) {
                outcome.reason = 'idle';
                controller.abort();
                return;
              }
              expires = Date.parse(value.expiresAt);
              if (expires <= Date.now())
                throw new Error('The renewed Planner credential expired');
              if (!signal.aborted) renew();
            } catch {
              controller.abort();
            }
          })();
        },
        Math.max(
          10,
          Math.min(options.renewMs ?? 15000, expires - Date.now() - 5000),
        ),
      );
      timer.unref();
    };
    state = { ...state, phase: 'running' };
    await privateJson(file, state);
    renew();
    await options.run({
      origin: credentials.origin,
      token: lease.token,
      getToken: async () => {
        signal.throwIfAborted();
        if (Date.now() >= expires)
          throw new Error('The Planner scoped credential expired');
        return lease.token;
      },
      artifactId: lease.artifactId,
      command: options.command,
      args: options.args,
      cwd: local.path,
      signal,
      allowPermissions: options.allowPermissions,
    });
    if (outcome.reason !== 'idle')
      outcome.reason = options.signal.aborted ? 'stopped' : 'failed';
  } catch (error) {
    if (options.signal.aborted) outcome.reason = 'stopped';
    // A missing endpoint is visible; never fall back to a broad operator token.
    if (
      error instanceof MachineTransportError &&
      error.status === 404 &&
      state.phase === 'claiming'
    )
      outcome.reason = 'failed';
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    await renewal;
    state = { ...state, phase: 'release', reason: outcome.reason };
    await privateJson(file, state);
    await release(credentials, state, file);
  }
  return { claimed: true, workId: next.id, status: outcome.reason };
}
