import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { privateJson, readPrivateJson } from './runtime.ts';
const execute = promisify(execFile);
export class ServiceSetupError extends Error {}
const configSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-f0-9]{16}$/),
    entry: z.string(),
    entrySha256: z.string().regex(/^[a-f0-9]{64}$/),
    node: z.string(),
    environment: z.record(z.string(), z.string()),
    platform: z.enum(['linux', 'darwin']),
    unitPath: z.string(),
  })
  .strict();
type Config = z.infer<typeof configSchema>;
type Manager = (
  command: string,
  args: string[],
) => Promise<{ stdout?: string }>;
const allowed = new Set([
  'PATH',
  'STUDIO_API_URL',
  'STUDIO_MACHINE_SCOPE',
  'STUDIO_MACHINE_CREDENTIALS',
  'STUDIO_MACHINE_STATE_DIR',
  'STUDIO_MACHINE_CWD',
  'STUDIO_MACHINE_CHECKOUTS',
  'STUDIO_MACHINE_AGENT_COMMAND',
  'STUDIO_MACHINE_AGENT_ARGS',
  'STUDIO_MACHINE_ALLOW_PERMISSIONS',
  'STUDIO_MACHINE_CLONE_REPOSITORIES',
  'STUDIO_MACHINE_CLONE_ATTACHED',
  'STUDIO_MACHINE_MANAGED_ROOT',
]);
const digest = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
const safePath = (path: string) => {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path))
    throw new ServiceSetupError(
      'Service paths must be absolute single-line paths',
    );
  return path;
};
const systemdArg = (value: string) =>
  '"' +
  safePath(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('$', () => '$$') +
  '"';
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
export function serviceTemplate(
  config: Pick<Config, 'id' | 'node' | 'entry' | 'platform'>,
  configPath: string,
) {
  if (config.platform === 'linux')
    return `[Unit]\nDescription=Studio connector ${config.id}\nStartLimitIntervalSec=120\nStartLimitBurst=3\n\n[Service]\nType=simple\nExecStart=${systemdArg(config.node)} ${systemdArg(config.entry)} --service-run ${systemdArg(configPath)}\nRestart=on-failure\nRestartSec=10\nKillMode=control-group\nTimeoutStopSec=15\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>dev.studio.connector.${config.id}</string><key>ProgramArguments</key><array>${[config.node, config.entry, '--service-run', configPath].map((value) => '<string>' + xml(value) + '</string>').join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string><key>Umask</key><integer>63</integer></dict></plist>\n`;
}
export function serviceLocation(
  env: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform; home?: string } = {},
) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'darwin')
    throw new ServiceSetupError(
      'Service installation supports Linux user systemd and macOS LaunchAgents; run the connector in the foreground on this platform',
    );
  const state = resolve(env.STUDIO_MACHINE_STATE_DIR ?? 'studio-machine-state');
  const id = digest(
    (env.STUDIO_API_URL ?? '') +
      '\0' +
      resolve(env.STUDIO_MACHINE_CREDENTIALS ?? '.studio-machine.json'),
  ).slice(0, 16);
  const directory = join(state, 'service-' + id);
  const configPath = join(directory, 'service.json');
  const home = options.home ?? homedir();
  const unitPath =
    platform === 'linux'
      ? join(
          env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
            ? env.XDG_CONFIG_HOME
            : join(home, '.config'),
          'systemd',
          'user',
          'studio-connector-' + id + '.service',
        )
      : join(
          home,
          'Library',
          'LaunchAgents',
          'dev.studio.connector.' + id + '.plist',
        );
  return { platform, directory, configPath, unitPath, id } as const;
}
const manager: Manager = (command, args) =>
  execute(command, args, { timeout: 15000, maxBuffer: 8192 });
const target = (config: Config) => 'dev.studio.connector.' + config.id;
const domain = () => {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new ServiceSetupError('A user service requires a user session');
  return 'gui/' + uid;
};
export async function installConnectorService(input: {
  env: NodeJS.ProcessEnv;
  entryFile: string;
  platform?: NodeJS.Platform;
  home?: string;
  manager?: Manager;
}) {
  const location = serviceLocation(input.env, input);
  // Install a copy of the portable first-party bundle, not a source checkout,
  // downloaded agent, shell script or module with unresolved local imports.
  const source = await readFile(await realpath(input.entryFile));
  if (
    source.length > 12 * 1024 * 1024 ||
    !source.includes(Buffer.from('Studio connector redistribution notices'))
  )
    throw new ServiceSetupError(
      'Install services using the downloaded standalone studio-connector.mjs bundle',
    );
  const credential = input.env.STUDIO_MACHINE_CREDENTIALS;
  if (!credential || !isAbsolute(credential))
    throw new ServiceSetupError(
      'Pair first and select an absolute private credential file',
    );
  await readPrivateJson(credential);
  await mkdir(dirname(location.directory), { recursive: true, mode: 0o700 });
  await mkdir(location.directory, { mode: 0o700 }).catch(() => {
    throw new ServiceSetupError(
      'This service profile already exists; inspect status and uninstall it before reinstalling',
    );
  });
  const directoryInfo = await lstat(location.directory);
  if (
    directoryInfo.isSymbolicLink() ||
    (await realpath(location.directory)) !== location.directory
  )
    throw new ServiceSetupError('A service profile cannot traverse symlinks');
  const environment: Record<string, string> = {};
  for (const key of allowed)
    if (input.env[key] !== undefined) environment[key] = input.env[key]!;
  const config: Config = {
    version: 1,
    id: location.id,
    entry: join(location.directory, 'connector.mjs'),
    entrySha256: digest(source),
    node: await realpath(process.execPath),
    environment,
    platform: location.platform,
    unitPath: location.unitPath,
  };
  let createdUnit = false;
  const run = input.manager ?? manager;
  try {
    await writeFile(config.entry, source, { mode: 0o700, flag: 'wx' });
    await privateJson(location.configPath, config);
    await mkdir(dirname(config.unitPath), { recursive: true, mode: 0o700 });
    await writeFile(
      config.unitPath,
      serviceTemplate(config, location.configPath),
      { mode: 0o600, flag: 'wx' },
    );
    createdUnit = true;
    if (config.platform === 'linux') {
      await run('systemctl', ['--user', 'daemon-reload']);
      await run('systemctl', [
        '--user',
        'enable',
        '--now',
        'studio-connector-' + config.id + '.service',
      ]);
    } else await run('launchctl', ['bootstrap', domain(), config.unitPath]);
    return { installed: true, id: config.id, platform: config.platform };
  } catch {
    if (createdUnit) {
      try {
        if (config.platform === 'linux')
          await run('systemctl', [
            '--user',
            'disable',
            '--now',
            'studio-connector-' + config.id + '.service',
          ]);
        else
          await run('launchctl', ['bootout', domain() + '/' + target(config)]);
      } catch {
        throw new ServiceSetupError(
          'Service activation is uncertain; its private profile was retained. Inspect service status and explicitly uninstall before retrying',
        );
      }
      await rm(config.unitPath, { force: true });
      if (config.platform === 'linux')
        await run('systemctl', ['--user', 'daemon-reload']).catch(() => {});
    }
    await rm(location.directory, { recursive: true, force: true });
    throw new ServiceSetupError(
      'The user service could not be installed; no service profile was retained. Check the user service manager and run in the foreground',
    );
  }
}
export async function readServiceConfiguration(path: string) {
  const config = configSchema.parse(await readPrivateJson(safePath(path)));
  if (
    config.entry !== join(dirname(path), 'connector.mjs') ||
    digest(await readFile(config.entry)) !== config.entrySha256
  )
    throw new ServiceSetupError(
      'The installed connector bundle changed; uninstall and reinstall the service',
    );
  if (Object.keys(config.environment).some((key) => !allowed.has(key)))
    throw new ServiceSetupError('Unexpected service environment key');
  return config;
}
export async function connectorServiceAction(
  action: 'status' | 'uninstall',
  env: NodeJS.ProcessEnv,
  options: {
    platform?: NodeJS.Platform;
    home?: string;
    manager?: Manager;
  } = {},
) {
  const location = serviceLocation(env, options);
  let config: Config;
  try {
    config = configSchema.parse(await readPrivateJson(location.configPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { installed: false, active: false };
    throw error;
  }
  if (
    config.id !== location.id ||
    config.unitPath !== location.unitPath ||
    config.platform !== location.platform
  )
    throw new ServiceSetupError(
      'The service profile does not match this operator configuration',
    );
  if (
    (await readFile(config.unitPath, 'utf8')) !==
    serviceTemplate(config, location.configPath)
  )
    throw new ServiceSetupError(
      'The service definition changed; review it before removing it',
    );
  const run = options.manager ?? manager;
  if (action === 'status') {
    try {
      const result =
        config.platform === 'linux'
          ? await run('systemctl', [
              '--user',
              'is-active',
              'studio-connector-' + config.id + '.service',
            ])
          : await run('launchctl', ['print', domain() + '/' + target(config)]);
      return {
        installed: true,
        active:
          config.platform === 'linux'
            ? result.stdout?.trim() === 'active'
            : /state = running/.test(result.stdout ?? ''),
        managerAvailable: true,
      };
    } catch (error) {
      return {
        installed: true,
        active: false,
        managerAvailable: [3, 4].includes((error as any).code),
      };
    }
  }
  if (config.platform === 'linux')
    await run('systemctl', [
      '--user',
      'disable',
      '--now',
      'studio-connector-' + config.id + '.service',
    ]);
  else await run('launchctl', ['bootout', domain() + '/' + target(config)]);
  await rm(config.unitPath);
  if (config.platform === 'linux')
    await run('systemctl', ['--user', 'daemon-reload']);
  await rm(location.directory, { recursive: true, force: true });
  return { installed: false, active: false };
}
