import type { ChunkedDoc, ChunkOptions, SourceDoc } from '../../src/contracts/index.ts';
import { createChunker } from '../../src/markdown/index.ts';
import { sha256Hex } from '../../src/util/index.ts';

export const DEFAULT_OPTS: ChunkOptions = { sectionDepth: 2, maxSectionChars: 12000 };

export function makeDoc(text: string, uri = 'docs/test.md', shaSource: string = text): SourceDoc {
  return { uri, absolutePath: `/project/${uri}`, text, sha256: sha256Hex(shaSource) };
}

export function chunkText(text: string, opts: Partial<ChunkOptions> = {}, uri = 'docs/test.md'): ChunkedDoc {
  return createChunker().chunk(makeDoc(text, uri), { ...DEFAULT_OPTS, ...opts });
}

/** Number of lines and the length of each line, using the same line-ending rules as the parser. */
export function lineLengths(text: string): number[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return body.split(/\r\n|\r|\n/).map((l) => l.length);
}

/**
 * CPU time (user + system, milliseconds) a synchronous call consumes. Budget tests use it instead of wall-clock time: on a
 * loaded or instrumented machine the wall clock includes time the process spent waiting for a core, the CPU clock does not.
 */
export function cpuMs(fn: () => void): number {
  const before = process.cpuUsage();
  fn();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}
