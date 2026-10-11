import { join } from 'node:path';
import { AiBddError, type CreateReporters, type JsonValue, type Reporter, type ReporterName, type RunReport } from '../contracts/index.ts';
import { atomicWriteFile, stableJson } from '../util/index.ts';
import { renderJunit } from './junit.ts';
import { renderMarkdown } from './markdown.ts';

function fileReporter(name: ReporterName, file: string, build: (report: RunReport, plans: Parameters<Reporter['render']>[1]['plans']) => string): Reporter {
  return {
    name,
    async render(report, ctx) {
      const path = join(ctx.outDir, file);
      await atomicWriteFile(path, build(report, ctx.plans));
      return [{ path }];
    },
  };
}

const FACTORIES: Record<ReporterName, () => Reporter> = {
  json: () => fileReporter('json', 'report.json', (report) => stableJson(report as unknown as JsonValue)),
  junit: () => fileReporter('junit', 'junit.xml', (report) => renderJunit(report)),
  markdown: () => fileReporter('markdown', 'summary.md', (report, plans) => renderMarkdown(report, plans)),
};

/** Reporters in the order requested; duplicates are collapsed. Output is a pure function of (report, plans). */
export const createReporters: CreateReporters = (names) => {
  const seen = new Set<ReporterName>();
  const out: Reporter[] = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    const factory = FACTORIES[n] as (() => Reporter) | undefined;
    if (factory === undefined) throw new AiBddError('USAGE', `unknown reporter "${String(n)}" (expected json, junit or markdown)`);
    out.push(factory());
  }
  return out;
};
