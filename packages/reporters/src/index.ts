/**
 * @ai-bdd/reporters — the four run reporters.
 *
 * A reporter consumes the runtime's `RunEvent` stream as the run progresses and
 * writes its artifacts in `finish(report)`. Evidence is attached **by reference**
 * (id, relative path, sha256, media type), never inlined, so reports stay small
 * and diffable.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { PriceTable, ReporterName, RunEvent, RunReport } from '@ai-bdd/contracts';
import { junitReport, markdownSummary, messagesReport } from '@ai-bdd/runtime';

export interface Reporter {
  name: ReporterName;
  onEvent(event: RunEvent): void;
  finish(report: RunReport): Promise<{ files: string[] }>;
}

export interface ReporterOptions {
  outDir: string;
  prices?: PriceTable;
  version?: string;
  /** Run directory, referenced by the markdown summary. */
  evidenceRunDir?: string;
}

/**
 * Builds the configured reporters. Each one buffers only what it needs, so a long
 * run does not hold the whole event stream in memory.
 */
export function createReporters(names: ReporterName[], options: ReporterOptions): Reporter[] {
  return names.map((name) => createReporter(name, options));
}

export function createReporter(name: ReporterName, options: ReporterOptions): Reporter {
  let healed = 0;
  let events = 0;
  return {
    name,
    onEvent(event: RunEvent): void {
      events += 1;
      if (event.type === 'scenario:end' && event.result.status === 'healed') healed += 1;
    },
    async finish(report: RunReport): Promise<{ files: string[] }> {
      const files: string[] = [];
      switch (name) {
        case 'json': {
          files.push(write(options.outDir, 'report.json', `${JSON.stringify(report, null, 2)}\n`));
          break;
        }
        case 'markdown': {
          files.push(
            write(
              options.outDir,
              'summary.md',
              markdownSummary(report, options.evidenceRunDir ?? join(options.outDir, 'runs')),
            ),
          );
          break;
        }
        case 'junit': {
          files.push(write(options.outDir, 'junit.xml', junitReport(report)));
          break;
        }
        case 'cucumber-messages': {
          files.push(write(options.outDir, 'messages.ndjson', messagesReport(report)));
          break;
        }
        default:
          break;
      }
      void events;
      void healed;
      return { files };
    },
  };
}

/** The evidence index a report can link to: id, relative path, media type. */
export function evidenceIndex(report: RunReport, outDir: string): Array<{ id: string; path: string; mediaType: string; sha256?: string }> {
  const index: Array<{ id: string; path: string; mediaType: string; sha256?: string }> = [];
  for (const scenario of report.scenarios) {
    for (const step of scenario.steps) {
      for (const ref of step.evidence) {
        index.push({
          id: ref.evidenceId,
          path: ref.path ? relative(outDir, ref.path) : '',
          mediaType: mediaTypeFor(ref.kind),
          ...(ref.sha256 !== undefined ? { sha256: ref.sha256 } : {}),
        });
      }
    }
  }
  return index;
}

function mediaTypeFor(kind: string): string {
  switch (kind) {
    case 'screenshot':
      return 'image/png';
    case 'video':
      return 'video/webm';
    case 'observation':
    case 'tree':
    case 'judge-request':
    case 'judge-response':
    case 'check-result':
    case 'act-program':
    case 'check-program':
      return 'application/json';
    default:
      return 'text/plain';
  }
}

function write(outDir: string, name: string, contents: string): string {
  const path = join(outDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

export { junitReport, markdownSummary, messagesReport };
