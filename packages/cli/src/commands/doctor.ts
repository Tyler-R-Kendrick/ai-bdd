import type { ExitCode } from '@ai-bdd/sdk/contracts';
import { openEngine, type Ctx } from '../context.ts';
import { asAiBddError, exitCodeForError } from '../exit.ts';

const MIN_NODE = { major: 22, minor: 18 };

interface Check { name: string; ok: boolean; detail: string }

export function checkNode(version: string): Check {
  const [major = 0, minor = 0] = version.split('.').map((n) => Number.parseInt(n, 10));
  const ok = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
  return { name: 'node', ok, detail: ok ? `Node ${version}` : `Node ${version} is too old; ai-bdd needs >= ${MIN_NODE.major}.${MIN_NODE.minor}` };
}

function print(ctx: Ctx, c: Check): void {
  ctx.out(`${c.ok ? '[ok]  ' : '[FAIL]'} ${c.name}: ${c.detail}`);
}

export async function runDoctor(ctx: Ctx, flags: { offline?: boolean | undefined }): Promise<ExitCode> {
  const checks: Check[] = [checkNode(ctx.deps.nodeVersion ?? process.versions.node)];
  let exit: ExitCode = 0;

  let engineHandle: Awaited<ReturnType<typeof openEngine>> | undefined;
  try {
    engineHandle = await openEngine(ctx);
    checks.push({ name: 'config', ok: true, detail: engineHandle.config.configPath ?? 'defaults (no config file)' });
  } catch (e) {
    const err = asAiBddError(e);
    checks.push({ name: 'config', ok: false, detail: err ? `[${err.code}] ${err.message}` : e instanceof Error ? e.message : String(e) });
    exit = exitCodeForError(e);
  }

  if (engineHandle) {
    try {
      const report = await engineHandle.engine.doctor({ offline: flags.offline === true });
      for (const c of report.checks) checks.push({ name: c.name, ok: c.ok, detail: c.detail });
    } catch (e) {
      const err = asAiBddError(e);
      checks.push({ name: 'doctor', ok: false, detail: err ? `[${err.code}] ${err.message}` : e instanceof Error ? e.message : String(e) });
      exit = exitCodeForError(e);
    } finally {
      try {
        await engineHandle.engine.close();
      } catch {
        // closing a half-initialized engine must not hide the report
      }
    }
  }

  for (const c of checks) print(ctx, c);
  if (flags.offline === true) ctx.out('(model reachability skipped: --offline)');
  const failed = checks.filter((c) => !c.ok).length;
  ctx.out(failed === 0 ? 'All checks passed.' : `${failed} check(s) failed.`);
  if (exit === 0 && failed > 0) exit = 1;
  return exit;
}
