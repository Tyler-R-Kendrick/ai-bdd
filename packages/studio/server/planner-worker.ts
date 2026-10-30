import { runRemotePlanner } from './machine/planner-client.ts';
export {
  connectRemotePlanner,
  runRemotePlanner,
} from './machine/planner-client.ts';
export type {
  PlannerClientOptions,
  RemotePlannerClientContext,
  RemoteInputResult,
} from './machine/planner-client.ts';
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
