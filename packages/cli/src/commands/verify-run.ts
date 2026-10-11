import { isAbsolute, resolve } from 'node:path';
import type { ExitCode } from '@ai-bdd/sdk/contracts';
import { resolveVerifyRun, withEngine, type Ctx } from '../context.ts';
import { asAiBddError, hasErrorCode } from '../exit.ts';

export async function runVerifyRun(ctx: Ctx, runDirArg: string): Promise<ExitCode> {
  const runDir = isAbsolute(runDirArg) ? runDirArg : resolve(ctx.io.cwd, runDirArg);
  let result: { ok: boolean; problems: string[] };
  try {
    result = await withEngine(ctx, {}, ({ engine }) => engine.verifyRun(runDir));
  } catch (e) {
    // Without a default config the run can still be verified through the standalone SDK function; an explicit
    // `--config` that does not exist stays a usage error (exit 2).
    if (hasErrorCode(e, 'CONFIG_NOT_FOUND') && ctx.configPath === undefined) {
      result = await (await resolveVerifyRun(ctx.deps))(runDir);
    } else if (hasErrorCode(e, 'EVIDENCE_CORRUPT')) {
      result = { ok: false, problems: [asAiBddError(e)?.message ?? 'evidence is corrupt'] };
    } else {
      throw e;
    }
  }
  if (result.ok) {
    ctx.out(`OK: ${runDirArg} verified.`);
    return 0;
  }
  ctx.out(`FAILED: ${runDirArg} has ${result.problems.length} problem(s):`);
  for (const p of result.problems) ctx.out(`  - ${p}`);
  return 1;
}
