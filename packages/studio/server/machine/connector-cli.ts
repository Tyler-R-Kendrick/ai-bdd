import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { selectAgent } from './agent-launch.ts';
import { canonicalCloneRepository } from './clone-registry.ts';
import {
  connectorServiceAction,
  installConnectorService,
  readServiceConfiguration,
  ServiceSetupError,
} from './service-install.ts';

export const connectorHelp = `Studio connected-machine connector (Node 22+, Git, installed ACP agent)

  node studio-connector.mjs connect --agent copilot --checkout /absolute/repository
  node studio-connector.mjs connect --agent atomic --clone https://github.com/owner/repo
  node studio-connector.mjs connect --clone-attached -- /absolute/acp-agent [args]
  node studio-connector.mjs connect --agent copilot --clone-attached --install-service
  node studio-connector.mjs service status
  node studio-connector.mjs service uninstall

--agent copilot|atomic     Installed Copilot (--acp --stdio) or Atomic ACP.
--checkout PATH            Register an existing checkout; repeat for multiple repos.
--clone HTTPS_URL          Explicitly permit a managed GitHub clone; repeat as needed.
--clone-attached           Opt in to cloning currently authorized attached project repos.
--managed-root PATH        Absolute private directory for managed clones.
--install-service          Explicit user service: Linux systemd or macOS LaunchAgent.
--once                     Poll once, then exit; cannot be installed as a service.
-- COMMAND [ARGS]          Use another installed stdio ACP agent without a shell.

Set STUDIO_API_URL and a one-time STUDIO_MACHINE_PAIR_CODE for initial pairing.
Credentials, reports and clones stay private. Pairing codes/provider tokens are
never stored in service definitions. Services reuse the paired credential file.
Install and sign in to the agent yourself. T3 uses Studio's thread/MCP integration;
it is not a stdio ACP preset. No agent download or service install happens by default.
`;

export class ConnectorUsageError extends Error {}
async function serviceOperation<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ServiceSetupError)
      throw new ConnectorUsageError(error.message);
    throw error;
  }
}
export async function runConnectorCLI(options: {
  args: string[];
  env: NodeJS.ProcessEnv;
  entryFile: string;
  runWorker: (env: NodeJS.ProcessEnv, once?: boolean) => Promise<unknown>;
  prepareCredentials: (env: NodeJS.ProcessEnv) => Promise<unknown>;
  write?: (value: string) => void;
}) {
  const write =
    options.write ?? ((value: string) => process.stdout.write(value));
  const args = [...options.args];
  if (args[0] === '--service-run') {
    if (args.length !== 2)
      throw new ConnectorUsageError(
        'A service run requires its private configuration file',
      );
    const config = await readServiceConfiguration(args[1]!);
    const env = { ...options.env };
    for (const key of Object.keys(env))
      if (key.startsWith('STUDIO_')) delete env[key];
    return options.runWorker({ ...env, ...config.environment }, false);
  }
  if (args.includes('--help') || args[0] === 'help') {
    write(connectorHelp);
    return;
  }
  const env = { ...options.env };
  const command = args[0];
  if (command === 'connect') {
    args.shift();
    env.STUDIO_MACHINE_SCOPE ??= 'account';
  }
  const freshDefaults =
    ['connect', 'service'].includes(command ?? '') &&
    !env.STUDIO_MACHINE_CREDENTIALS;
  const stateBase =
    env.XDG_STATE_HOME && resolve(env.XDG_STATE_HOME) === env.XDG_STATE_HOME
      ? env.XDG_STATE_HOME
      : join(homedir(), '.local', 'state');
  if (freshDefaults)
    env.STUDIO_MACHINE_CREDENTIALS = join(
      stateBase,
      'studio',
      'connector',
      'device.json',
    );
  env.STUDIO_MACHINE_CREDENTIALS = resolve(
    env.STUDIO_MACHINE_CREDENTIALS ?? '.studio-machine.json',
  );
  env.STUDIO_MACHINE_STATE_DIR = resolve(
    env.STUDIO_MACHINE_STATE_DIR ??
      join(
        resolve(env.STUDIO_MACHINE_CREDENTIALS, '..'),
        'studio-machine-state',
      ),
  );
  if (args[0] === 'service') {
    if (args.length !== 2 || !['status', 'uninstall'].includes(args[1]!))
      throw new ConnectorUsageError('Use service status or service uninstall');
    write(
      JSON.stringify(
        await serviceOperation(() =>
          connectorServiceAction(args[1] as 'status' | 'uninstall', env),
        ),
      ) + '\n',
    );
    return;
  }
  let preset: string | undefined, custom: string[] | undefined;
  let once = false,
    install = false;
  const checkouts: { key: string; path: string }[] = [],
    clones: string[] = [];
  const value = (index: number, flag: string) => {
    const next = args[index + 1];
    if (!next || next.startsWith('--'))
      throw new ConnectorUsageError(flag + ' requires a value');
    return next;
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') {
      custom = args.slice(index + 1);
      if (!custom.length)
        throw new ConnectorUsageError(
          'Supply an installed ACP command after --',
        );
      break;
    }
    if (arg === '--agent') {
      preset = value(index, arg);
      index++;
    } else if (arg === '--checkout') {
      checkouts.push({
        key: 'checkout-' + checkouts.length,
        path: resolve(value(index, arg)),
      });
      index++;
    } else if (arg.startsWith('--checkout='))
      checkouts.push({
        key: 'checkout-' + checkouts.length,
        path: resolve(arg.slice(11)),
      });
    else if (arg === '--clone') {
      clones.push(canonicalCloneRepository(value(index, arg)));
      index++;
    } else if (arg === '--clone-attached')
      env.STUDIO_MACHINE_CLONE_ATTACHED = 'true';
    else if (arg === '--managed-root') {
      env.STUDIO_MACHINE_MANAGED_ROOT = resolve(value(index, arg));
      index++;
    } else if (arg === '--install-service') install = true;
    else if (arg === '--once') once = true;
    else throw new ConnectorUsageError('Unknown connector option; use --help');
  }
  if (install && once)
    throw new ConnectorUsageError('--once cannot be installed as a service');
  if (checkouts.length)
    env.STUDIO_MACHINE_CHECKOUTS = JSON.stringify(checkouts);
  if (clones.length)
    env.STUDIO_MACHINE_CLONE_REPOSITORIES = JSON.stringify(clones);
  if (clones.length || env.STUDIO_MACHINE_CLONE_ATTACHED === 'true') {
    if (env.STUDIO_MACHINE_SCOPE && env.STUDIO_MACHINE_SCOPE !== 'account')
      throw new ConnectorUsageError(
        'Managed clone discovery requires account-scoped pairing',
      );
    env.STUDIO_MACHINE_SCOPE = 'account';
  }
  const agent = await selectAgent({ preset, custom }, env).catch((error) => {
    throw new ConnectorUsageError((error as Error).message);
  });
  env.STUDIO_MACHINE_AGENT_COMMAND = agent.command;
  env.STUDIO_MACHINE_AGENT_ARGS = JSON.stringify(agent.args);
  if (install) {
    await options.prepareCredentials(env);
    delete env.STUDIO_MACHINE_PAIR_CODE;
    write(
      JSON.stringify(
        await serviceOperation(() =>
          installConnectorService({ env, entryFile: options.entryFile }),
        ),
      ) + '\n',
    );
    return;
  }
  return options.runWorker(env, once);
}
