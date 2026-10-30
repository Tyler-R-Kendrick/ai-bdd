import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { AcpClient } from './machine-worker.ts';
import type {
  PlannerOutput,
  RemoteTurn,
} from './integrations/remote-planner.ts';

export type PlannerClientOptions = {
  origin: string;
  token: string;
  artifactId: string;
  signal: AbortSignal;
  run: (turn: RemoteTurn, signal: AbortSignal) => Promise<PlannerOutput>;
  onAttached?: () => void;
};
/** A reconnecting external model client. Server tools remain available over studio.planner.v1. */
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
    const socket = new WebSocket(
      options.origin.replace(/^http/, 'ws') + '/api/planner/connect',
      'studio.planner.v1',
      {
        headers: { Authorization: 'Bearer ' + options.token },
        maxPayload: 512000,
      },
    );
    const tasks = new Set<Promise<void>>(),
      controllers = new Set<AbortController>();
    let attached = false,
      terminal = false;
    const abort = () => {
      socket.terminate();
    };
    options.signal.addEventListener('abort', abort, { once: true });
    const ended = new Promise<void>((resolve) => {
      socket.on('error', () => {});
      socket.on('open', () =>
        socket.send(
          JSON.stringify({
            type: 'attach',
            version: 1,
            artifactId: options.artifactId,
          }),
        ),
      );
      socket.on('message', (data, binary) => {
        try {
          if (binary) throw new Error('Expected Planner JSON');
          const message = JSON.parse(data.toString());
          if (message.type === 'attached') {
            attached = true;
            failures = 0;
            options.onAttached?.();
            return;
          }
          if (message.type !== 'turn') return;
          if (tasks.size >= 4)
            throw new Error('Planner concurrency limit exceeded');
          const controller = new AbortController();
          controllers.add(controller);
          const task = (async () => {
            try {
              const output = await options.run(
                message.input,
                AbortSignal.any([
                  options.signal,
                  controller.signal,
                  AbortSignal.timeout(120000),
                ]),
              );
              if (socket.readyState === 1)
                socket.send(
                  JSON.stringify({
                    type: 'result',
                    requestId: message.requestId,
                    output,
                  }),
                );
            } catch {
              if (socket.readyState === 1)
                socket.send(
                  JSON.stringify({
                    type: 'failed',
                    requestId: message.requestId,
                  }),
                );
            }
          })().finally(() => {
            tasks.delete(task);
            controllers.delete(controller);
          });
          tasks.add(task);
        } catch {
          socket.close(1002, 'Invalid Planner protocol frame');
        }
      });
      socket.on('close', (code) => {
        terminal = [4401, 4403, 4406].includes(code);
        resolve();
      });
    });
    await ended;
    options.signal.removeEventListener('abort', abort);
    for (const controller of controllers) controller.abort();
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
/** Execute explicit Planner turns with the operator-selected ACP agent. Credentials never enter the child environment. */
export function runRemotePlanner(
  options: Omit<PlannerClientOptions, 'run'> & {
    command: string;
    args: string[];
    cwd: string;
  },
) {
  return connectRemotePlanner({
    ...options,
    run: async (turn, signal) => {
      const acp = new AcpClient({
        command: options.command,
        args: options.args,
        cwd: options.cwd,
        signal,
      });
      try {
        const result = await acp.run({ kind: 'planner', ...turn });
        return { text: result.summary, content: result.content ?? null };
      } finally {
        await acp.close();
      }
    },
  });
}

async function main() {
  const { mcpSettings } = await import('./mcp.ts');
  const { isAbsolute } = await import('node:path');
  const args = process.argv.slice(2);
  if (
    !/^[0-9a-f-]{36}$/.test(args[0] ?? '') ||
    args[1] !== '--checkout' ||
    !isAbsolute(args[2] ?? '') ||
    args[3] !== '--' ||
    !isAbsolute(args[4] ?? '')
  )
    throw new Error(
      'Usage: planner-worker <artifact-uuid> --checkout /absolute/checkout -- /absolute/acp-agent [args]',
    );
  const { origin, token } = mcpSettings(process.env),
    controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runRemotePlanner({
      origin,
      token,
      artifactId: args[0]!,
      cwd: args[2]!,
      command: args[4]!,
      args: args.slice(5),
      signal: controller.signal,
      onAttached: () =>
        process.stdout.write(
          'Remote Planner attached. Model output remains subject to server publication and review guards.\n',
        ),
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
const { pathToFileURL } = await import('node:url');
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      (error instanceof Error ? error.message : 'Remote Planner stopped') +
        '\n',
    );
    process.exitCode = 1;
  });
}
