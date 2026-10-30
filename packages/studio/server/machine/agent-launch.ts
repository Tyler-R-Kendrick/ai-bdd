import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export const agentPresets = {
  copilot: { command: 'copilot', args: ['--acp', '--stdio'] },
  atomic: { command: 'atomic-acp', args: [] },
} as const;

/** Resolve only an operator-selected installed executable, never a project command. */
export async function installedExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
) {
  if (!command || command.includes('\0'))
    throw new Error('Select an installed agent executable');
  const candidates = isAbsolute(command)
    ? [command]
    : command.includes('/') || command.includes('\\')
      ? [resolve(command)]
      : (env.PATH ?? '')
          .split(delimiter)
          .filter(isAbsolute)
          .flatMap((directory) =>
            process.platform === 'win32'
              ? [join(directory, command + '.exe'), join(directory, command)]
              : [join(directory, command)],
          );
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate);
      if (!(await stat(path)).isFile()) continue;
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(path)) continue;
      await access(
        path,
        process.platform === 'win32' ? constants.F_OK : constants.X_OK,
      );
      return path;
    } catch {}
  }
  throw new Error(
    'The selected agent executable is not installed or executable; install and sign in to it first',
  );
}

export async function selectAgent(
  input: { preset?: string; custom?: string[] },
  env: NodeJS.ProcessEnv,
) {
  if (input.preset && input.custom?.length)
    throw new Error('Choose --agent or a command after --');
  if (input.preset && !Object.hasOwn(agentPresets, input.preset))
    throw new Error(
      'Supported ACP presets: copilot, atomic. T3 uses Studio’s thread/MCP adapter, not an invented ACP command',
    );
  const preset = input.preset
    ? agentPresets[input.preset as keyof typeof agentPresets]
    : undefined;
  const command =
    input.custom?.[0] ?? preset?.command ?? env.STUDIO_MACHINE_AGENT_COMMAND;
  const args: unknown =
    input.custom?.slice(1) ??
    (preset
      ? [...preset.args]
      : JSON.parse(env.STUDIO_MACHINE_AGENT_ARGS ?? '[]'));
  if (
    !Array.isArray(args) ||
    args.length > 30 ||
    args.some(
      (arg) =>
        typeof arg !== 'string' || arg.length > 2000 || arg.includes('\0'),
    )
  )
    throw new Error('Agent arguments must be at most thirty bounded strings');
  // Keep the selected entrypoint stable when a run switches to its sealed Git
  // worktree. A relative operator script must not resolve to repository code.
  if (args[0] && !(args[0] as string).startsWith('-')) {
    const entry = resolve(env.STUDIO_MACHINE_CWD ?? process.cwd(), args[0]);
    try {
      if ((await stat(entry)).isFile()) args[0] = await realpath(entry);
      else if (/\.(?:[cm]?js|tsx?|py|rb)$/i.test(args[0]))
        throw new Error('The selected entrypoint is not a regular file');
    } catch {
      if (/\.(?:[cm]?js|tsx?|py|rb)$/i.test(args[0]))
        throw new Error(
          'The operator-selected agent entrypoint is missing or unreadable',
        );
    }
  }
  return {
    command: await installedExecutable(command ?? '', env),
    args: args as string[],
  };
}
