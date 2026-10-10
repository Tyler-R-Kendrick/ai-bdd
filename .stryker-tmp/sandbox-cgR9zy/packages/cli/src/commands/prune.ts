// @ts-nocheck
import type { ExitCode } from '@ai-bdd/sdk/contracts';
import { withEngine, type Ctx } from '../context.ts';

export async function runPrune(ctx: Ctx, flags: { dryRun?: boolean | undefined }): Promise<ExitCode> {
  return withEngine<ExitCode>(ctx, {}, async ({ engine }) => {
    const dryRun = flags.dryRun === true;
    const { removed } = await engine.prune({ dryRun });
    for (const r of removed) ctx.out(`${dryRun ? 'would remove' : 'removed'} ${r}`);
    ctx.out(
      removed.length === 0
        ? 'Nothing to prune.'
        : `${dryRun ? 'Would remove' : 'Removed'} ${removed.length} orphaned recording(s).`,
    );
    return 0;
  });
}
