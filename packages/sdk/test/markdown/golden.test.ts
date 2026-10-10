import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChunkOptions, JsonValue } from '../../src/contracts/index.ts';
import { createChunker } from '../../src/markdown/index.ts';
import { stableJson } from '../../src/util/index.ts';
import { DEFAULT_OPTS, makeDoc } from './helpers.ts';

const dir = fileURLToPath(new URL('./golden/', import.meta.url));
const update = process.env['UPDATE_GOLDEN'] === '1';

interface CaseOpts extends Partial<ChunkOptions> {
  /** Line-ending / BOM transform applied to the fixture text before chunking. */
  transform?: 'crlf' | 'cr' | 'bom' | 'bom+crlf';
  /** Requirement ids this case proves; they are part of the test name. */
  req?: string[];
}

function transformText(text: string, how: CaseOpts['transform']): string {
  switch (how) {
    case 'crlf':
      return text.replace(/\n/g, '\r\n');
    case 'cr':
      return text.replace(/\n/g, '\r');
    case 'bom':
      return `﻿${text}`;
    case 'bom+crlf':
      return `﻿${text.replace(/\n/g, '\r\n')}`;
    default:
      return text;
  }
}

const names = readdirSync(dir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3))
  .sort();

describe('markdown golden cases', () => {
  it('has at least 30 golden fixtures', () => {
    expect(names.length).toBeGreaterThanOrEqual(30);
  });

  for (const name of names) {
    const optsPath = `${dir}${name}.opts.json`;
    const caseOpts: CaseOpts = existsSync(optsPath) ? (JSON.parse(readFileSync(optsPath, 'utf8')) as CaseOpts) : {};
    const req = (caseOpts.req ?? ['G1']).join(' ');
    it(`${req}: golden ${name}`, () => {
      const base = readFileSync(`${dir}${name}.md`, 'utf8');
      const doc = makeDoc(transformText(base, caseOpts.transform), `docs/${name}.md`, base);
      const opts: ChunkOptions = {
        sectionDepth: caseOpts.sectionDepth ?? DEFAULT_OPTS.sectionDepth,
        maxSectionChars: caseOpts.maxSectionChars ?? DEFAULT_OPTS.maxSectionChars,
      };
      const actual = stableJson(createChunker().chunk(doc, opts) as unknown as JsonValue);
      const goldenPath = `${dir}${name}.chunks.json`;
      if (update) {
        writeFileSync(goldenPath, actual);
        return;
      }
      expect(existsSync(goldenPath), `missing golden ${name}.chunks.json (run with UPDATE_GOLDEN=1)`).toBe(true);
      expect(actual).toBe(readFileSync(goldenPath, 'utf8'));
    });
  }
});
