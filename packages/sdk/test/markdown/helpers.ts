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
