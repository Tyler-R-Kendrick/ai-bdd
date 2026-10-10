// @ts-nocheck
import type { CompileOptions, CompileResult, Diagnostic, ExitCode } from '@ai-bdd/sdk/contracts';
import { withEngine, type Ctx } from '../context.ts';

export interface CompileFlags {
  docs: string[];
  full?: boolean | undefined;
  dryRun?: boolean | undefined;
  check?: boolean | undefined;
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.uri ? ` (${d.uri}${d.range ? `:${d.range.startLine}` : ''})` : '';
  return `${d.severity} ${d.code}: ${d.message}${where}`;
}

/** Final compile exit code: the engine's, plus the guarantees of §5.1 for check mode and extraction errors. */
export function compileExitCode(result: CompileResult, check: boolean): ExitCode {
  let code = result.exitCode;
  if (code === 0 && result.docs.some((d) => d.failedSections.length > 0 || d.diagnostics.some((x) => x.severity === 'error'))) code = 1;
  if (check && (code === 0 || code === 1) && result.docs.some((d) => d.state !== 'fresh')) code = 4;
  return code;
}

export function printCompile(ctx: Ctx, result: CompileResult, flags: { check: boolean; dryRun: boolean }): void {
  for (const d of result.docs) {
    const parts = [`+${d.added.length}`, `~${d.updated.length}`, `-${d.removed.length}`];
    const extracted = d.extractedSections.length > 0 ? `, ${d.extractedSections.length} section(s) extracted` : '';
    const failed = d.failedSections.length > 0 ? `, ${d.failedSections.length} FAILED` : '';
    ctx.out(`${d.docUri}  [${d.state}]  ${parts.join(' ')}${extracted}${failed}`);
    for (const id of d.added) ctx.out(`    + ${id}`);
    for (const id of d.updated) ctx.out(`    ~ ${id}`);
    for (const id of d.removed) ctx.out(`    - ${id}`);
    for (const s of d.failedSections) ctx.out(`    failed section: ${s}`);
    for (const diag of d.diagnostics) ctx.out(`    ${formatDiagnostic(diag)}`);
  }
  if (result.docs.length === 0) ctx.out('No documents found.');
  const u = result.usage;
  ctx.out(`Model calls: ${u.modelCalls} (${u.inputTokens} input / ${u.outputTokens} output tokens)`);
  if (flags.check) {
    const stale = result.docs.filter((d) => d.state !== 'fresh').length;
    ctx.out(stale > 0 ? `Check failed: ${stale} document(s) are not fresh. Run \`ai-bdd compile\`.` : 'Check passed: all plans are fresh.');
  } else if (flags.dryRun) {
    ctx.out('Dry run: no plan files were written.');
  }
}

export async function runCompile(ctx: Ctx, flags: CompileFlags): Promise<ExitCode> {
  return withEngine(ctx, {}, async ({ engine }) => {
    const opts: CompileOptions = {
      ...(flags.docs.length > 0 ? { docs: flags.docs } : {}),
      full: flags.full === true,
      dryRun: flags.dryRun === true,
      check: flags.check === true,
      ...(ctx.deps.signal ? { signal: ctx.deps.signal } : {}),
    };
    const result = await engine.compile(opts);
    printCompile(ctx, result, { check: flags.check === true, dryRun: flags.dryRun === true });
    return compileExitCode(result, flags.check === true);
  });
}
