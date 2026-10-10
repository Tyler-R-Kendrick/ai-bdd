// @ts-nocheck
import type { DocStatus, ExitCode, PlanStatus } from '@ai-bdd/sdk/contracts';
import { withEngine, type Ctx } from '../context.ts';

export function printStatus(ctx: Ctx, status: PlanStatus): void {
  if (status.docs.length === 0) {
    ctx.out('No documents found.');
    return;
  }
  for (const d of status.docs) {
    ctx.out(`${d.docUri}  [${d.state}]`);
    ctx.out(`    dirty sections: ${d.dirtySections.length}  stale features: ${d.staleFeatures.length}  uncovered: ${d.uncovered.length}  not testable: ${d.notTestable.length}  unreviewed scenarios: ${d.unreviewedScenarios.length}`);
    for (const s of d.dirtySections) ctx.out(`    dirty: ${s}`);
    for (const f of d.staleFeatures) ctx.out(`    stale: ${f}`);
  }
  const count = (state: DocStatus['state']) => status.docs.filter((d) => d.state === state).length;
  ctx.out(`Docs: ${count('fresh')} fresh, ${count('stale')} stale, ${count('new')} new, ${count('orphaned')} orphaned`);
}

export async function runStatus(ctx: Ctx, flags: { json?: boolean | undefined }): Promise<ExitCode> {
  return withEngine<ExitCode>(ctx, {}, async ({ engine }) => {
    const status = await engine.status();
    if (flags.json === true) ctx.out(JSON.stringify(status, null, 2));
    else printStatus(ctx, status);
    return 0;
  });
}
