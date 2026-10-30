import { runRebuildOnce, resumeRebuildRuns } from './rebuild-worker.ts';
import { resolve, join, isAbsolute } from 'node:path';
import { realpath, mkdir, open, rm } from 'node:fs/promises';
import { z } from 'zod';
import { canonicalCloneRepository, managedClone } from './clone-registry.ts';
import {
  accountCredentialsSchema,
  type AccountMachineCredentials,
  type CheckoutRegistration,
} from '../../shared/account-machines.ts';
import {
  machineApi,
  runMachineOnce,
  runInvestigationOnce,
  resumeInvestigationReports,
  type MachineCredentials,
} from '../machine-worker.ts';
import {
  runImplementationOnce,
  resumeImplementationRuns,
} from './implementation-worker.ts';
import {
  privateJson,
  readPrivateJson,
  inspectCheckout,
  reconnect,
  pause,
  retryable,
  MachineTransportError,
  reasonCode,
} from './runtime.ts';
const pathsSchema = z
  .array(
    z
      .object({
        key: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
        path: z.string().min(1),
      })
      .strict(),
  )
  .min(1)
  .max(16);
export async function connectAccountMachine(
  origin: string,
  code: string,
  file: string,
) {
  const credentials = accountCredentialsSchema.parse({
    ...(await machineApi(origin, '/account-machines/pair', undefined, {
      code,
    })),
    origin,
  });
  await privateJson(file, credentials);
  return credentials;
}
export async function readAccountMachineCredentials(file: string) {
  const credentials = accountCredentialsSchema.parse(
    await readPrivateJson(file),
  );
  if (
    !Number.isFinite(Date.parse(credentials.expiresAt)) ||
    Date.parse(credentials.expiresAt) <= Date.now()
  )
    throw new Error('The account machine credential expired; pair it again');
  return credentials;
}
export async function explicitCheckoutRegistry(
  env: NodeJS.ProcessEnv,
  args: string[] = process.argv.slice(2),
  attached: string[] = [],
  signal?: AbortSignal,
) {
  const flags: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--checkout') {
      const path = args[++index];
      if (!path || path.startsWith('--'))
        throw new Error(
          '--checkout requires an explicit local repository path',
        );
      flags.push(path);
    } else if (args[index]!.startsWith('--checkout='))
      flags.push(args[index]!.slice(11));
  }
  const configured = env.STUDIO_MACHINE_CHECKOUTS
    ? pathsSchema.parse(JSON.parse(env.STUDIO_MACHINE_CHECKOUTS))
    : flags.length
      ? flags.map((path, index) => ({ key: 'checkout-' + index, path }))
      : env.STUDIO_MACHINE_CWD
        ? [{ key: 'default', path: env.STUDIO_MACHINE_CWD }]
        : [];
  const cloneURLs = z
    .array(z.string())
    .max(16)
    .parse(JSON.parse(env.STUDIO_MACHINE_CLONE_REPOSITORIES ?? '[]'));
  const repositories = [
    ...new Set([...cloneURLs, ...attached].map(canonicalCloneRepository)),
  ];
  if (repositories.length > 16)
    throw new Error('At most sixteen repositories may be registered');
  const entries = configured.length ? pathsSchema.parse(configured) : [];
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length)
    throw new Error('Checkout registry keys must be unique');
  const result = [];
  for (const entry of entries) {
    const checkout = await inspectCheckout(await realpath(entry.path));
    result.push({
      key: entry.key,
      path: checkout.root,
      registration: {
        checkoutKey: entry.key,
        repository: checkout.repository,
        sourceCommit: checkout.sourceCommit,
        branch: checkout.branch,
      } satisfies CheckoutRegistration,
    });
  }
  for (const repository of repositories) {
    if (result.some((entry) => entry.registration.repository === repository))
      continue;
    if (result.length >= 16)
      throw new Error('At most sixteen repositories may be registered');
    const clone = await managedClone(
      repository,
      resolve(
        env.STUDIO_MACHINE_MANAGED_ROOT ??
          join(
            env.STUDIO_MACHINE_STATE_DIR ?? 'studio-machine-state',
            'repositories',
          ),
      ),
      env,
      signal,
    );
    result.push({
      key: clone.key,
      path: clone.path,
      registration: {
        checkoutKey: clone.key,
        repository: clone.checkout.repository,
        sourceCommit: clone.checkout.sourceCommit,
        branch: clone.checkout.branch,
      },
    });
  }
  if (!result.length && env.STUDIO_MACHINE_CLONE_ATTACHED !== 'true')
    throw new Error(
      'Register --checkout, --clone, or opt in with --clone-attached to authorized attached repositories',
    );
  if (
    new Set(result.map((entry) => entry.registration.repository)).size !==
    result.length
  )
    throw new Error(
      'Register one explicit checkout per repository; duplicate repository paths are ambiguous',
    );
  return result;
}
const assignmentSchema = z
  .object({
    projectId: z.string().uuid(),
    projectTitle: z.string(),
    checkoutKey: z.string(),
    repository: z.string(),
    credential: z
      .object({
        id: z.string().uuid(),
        token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        projectId: z.string().uuid(),
        expiresAt: z.string(),
      })
      .strict(),
  })
  .strict();
export async function accountAssignments(
  credentials: AccountMachineCredentials,
  env: NodeJS.ProcessEnv,
  args?: string[],
  signal?: AbortSignal,
) {
  const attached =
    env.STUDIO_MACHINE_CLONE_ATTACHED === 'true'
      ? z
          .object({ repositories: z.array(z.string()).max(16) })
          .strict()
          .parse(
            await reconnect(
              () =>
                machineApi(
                  credentials.origin,
                  `/account-machines/${credentials.id}/repositories`,
                  credentials.token,
                  undefined,
                  signal,
                  'GET',
                ),
              { signal, maxDelayMs: 10000 },
            ),
          ).repositories
      : [];
  const registry = await explicitCheckoutRegistry(env, args, attached, signal);
  const response = await reconnect(
    () =>
      machineApi(
        credentials.origin,
        `/account-machines/${credentials.id}/assignments`,
        credentials.token,
        { checkouts: registry.map((entry) => entry.registration) },
        signal,
      ),
    { signal, maxDelayMs: 10000 },
  );
  const result = z
    .object({
      assignments: z.array(assignmentSchema).max(100),
      blocked: z
        .array(
          z.object({ projectId: z.string().uuid(), code: z.string() }).strict(),
        )
        .max(500),
    })
    .strict()
    .parse(response);
  const assignments = result.assignments.map((assignment) => {
    const checkout = registry.find(
      (entry) => entry.key === assignment.checkoutKey,
    );
    if (
      !checkout ||
      checkout.registration.repository.toLowerCase() !==
        assignment.repository.toLowerCase()
    )
      throw new Error(
        'The server selected a repository outside the explicit local checkout registry',
      );
    return {
      ...assignment,
      cwd: checkout.path,
      credentials: {
        ...assignment.credential,
        origin: credentials.origin,
      } as MachineCredentials,
    };
  });
  return { ...result, assignments };
}
export async function runAccountMachineWorker(
  credentials: AccountMachineCredentials,
  env: NodeJS.ProcessEnv,
  once = false,
) {
  const command = env.STUDIO_MACHINE_AGENT_COMMAND;
  if (!command || !isAbsolute(command))
    throw new Error(
      'Select an installed ACP executable with STUDIO_MACHINE_AGENT_COMMAND',
    );
  const args = z
      .array(z.string().max(2000))
      .max(30)
      .parse(JSON.parse(env.STUDIO_MACHINE_AGENT_ARGS ?? '[]')),
    allowPermissions = (env.STUDIO_MACHINE_ALLOW_PERMISSIONS ?? '')
      .split(',')
      .filter(Boolean);
  if (
    allowPermissions.some(
      (kind) =>
        ![
          'read',
          'edit',
          'delete',
          'move',
          'search',
          'execute',
          'fetch',
          'other',
        ].includes(kind),
    )
  )
    throw new Error('Select known ACP permission kinds');
  const stateDirectory = resolve(
    env.STUDIO_MACHINE_STATE_DIR ?? 'studio-machine-state',
  );
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const lockFile = join(stateDirectory, '.lock'),
    lock = await open(lockFile, 'wx', 0o600).catch(() => {
      throw new Error(
        'This connector state directory is locked; verify no process is using it before removing .lock',
      );
    });
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) +
      '\n',
  );
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void reconnect(
      () =>
        machineApi(
          credentials.origin,
          `/account-machines/${credentials.id}/heartbeat`,
          credentials.token,
          {},
          controller.signal,
        ),
      { signal: controller.signal, maxDelayMs: 10000 },
    )
      .catch(() => controller.abort())
      .finally(() => {
        heartbeatBusy = false;
      });
  }, 20000);
  heartbeat.unref();
  let cursor = 0,
    lastBlocked = '';
  try {
    do {
      const connected = await accountAssignments(
          credentials,
          env,
          undefined,
          controller.signal,
        ),
        codes = connected.blocked
          .map((b) => b.projectId + ':' + b.code)
          .join(',');
      if (codes && codes !== lastBlocked)
        process.stderr.write(
          'Some project assignments are blocked: ' + codes + '\n',
        );
      lastBlocked = codes;
      let result: { claimed: boolean; status?: string; workId?: string } = {
        claimed: false,
      };
      for (let offset = 0; offset < connected.assignments.length; offset++) {
        const index = (cursor + offset) % connected.assignments.length,
          assignment = connected.assignments[index]!,
          projectState = join(stateDirectory, 'projects', assignment.projectId);
        const options = {
          command,
          args,
          cwd: assignment.cwd,
          allowPermissions,
          stateDirectory: projectState,
          signal: controller.signal,
        };
        try {
          await resumeRebuildRuns(
            assignment.credentials,
            projectState,
            controller.signal,
          );
          await resumeImplementationRuns(
            assignment.credentials,
            projectState,
            controller.signal,
          );
          await resumeInvestigationReports(
            assignment.credentials,
            projectState,
            controller.signal,
          );
          result = await runRebuildOnce(assignment.credentials, options);
          if (!result.claimed)
            result = await runImplementationOnce(
              assignment.credentials,
              options,
            );
          if (!result.claimed)
            result = await runInvestigationOnce(
              assignment.credentials,
              options,
            );
          if (!result.claimed)
            result = await runMachineOnce(assignment.credentials, options);
          if (result.claimed) {
            cursor = (index + 1) % connected.assignments.length;
            break;
          }
        } catch (error) {
          if (
            error instanceof MachineTransportError &&
            [401, 403, 409].includes(error.status)
          ) {
            process.stderr.write(
              'A project rejected local work (' +
                reasonCode(error) +
                '); its permission and lease must be reviewed.\n',
            );
            if (once) throw error;
            continue;
          }
          if (once) throw error;
          process.stderr.write(
            retryable(error)
              ? 'Lost project contact (' +
                  reasonCode(error) +
                  '); pending reports remain private for reconnect.\n'
              : 'Local work stopped; review its retained checkout before explicitly retrying.\n',
          );
          break;
        }
      }
      process.stdout.write(JSON.stringify(result) + '\n');
      if (!once) await pause(2000, controller.signal);
    } while (!once && !controller.signal.aborted);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearInterval(heartbeat);
    controller.abort();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await lock.close();
    await rm(lockFile, { force: true });
  }
}
