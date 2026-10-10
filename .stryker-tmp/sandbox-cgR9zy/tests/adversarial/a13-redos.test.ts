// @ts-nocheck
// Attack 13: ReDoS / algorithmic blow-up in directive parsing and volatile patterns, plus the other places where untrusted
// text meets a regular expression or a quadratic loop (R-AS2, R-AS3, R-EX1).
import { describe, expect, it } from 'vitest';
import { createChunker, createExtractor, createJudge, createRedactor, resolveConfig } from '@ai-bdd/sdk';
import type { ChatModel, ModelRequest, ModelResponse } from '@ai-bdd/sdk/contracts';
import { findVolatile } from '../../packages/sdk/src/assert/volatile.ts';
import { isVolatileText } from '../../packages/sdk/src/recording/volatile.ts';
import { applyDirectiveEntry, emptyDirectiveSet, parseDirectiveText, tokenizeDirective } from '../../packages/sdk/src/markdown/directives.ts';

const config = resolveConfig({}, { projectRoot: '/tmp/x', env: {} });

/** Best of `reps` wall-clock milliseconds. */
function best(fn: () => void, reps = 3): number {
  let b = Infinity;
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    fn();
    b = Math.min(b, performance.now() - t);
  }
  return b;
}

const chunk = (text: string): unknown => createChunker().chunk({ uri: 'docs/x.md', absolutePath: '/x', text, sha256: '0'.repeat(64) }, { sectionDepth: 2, maxSectionChars: 12000 });

/** time(4n) / time(n): about 4 for a linear algorithm, 16 for a quadratic one. */
function growth(make: (n: number) => () => void, small: number): { ratio: number; big: number } {
  const a = best(make(small), 3);
  const b = best(make(small * 4), 2);
  return { ratio: b / Math.max(a, 0.05), big: b };
}

describe('A13 R-AS2 volatile patterns are linear time', () => {
  const families: [string, (n: number) => string][] = [
    ['clock fragments', (n) => '1:'.repeat(n)],
    ['clock fragments with seconds', (n) => '1:23:45.'.repeat(n)],
    ['digits and spaces', (n) => '1 '.repeat(n)],
    ['digit then a long space run then a non-match', (n) => `1${' '.repeat(n)}x`],
    ['relative time prefix repeated', (n) => '1 minute '.repeat(n)],
    ['"just " repeated', (n) => 'just '.repeat(n)],
    ['long word of hex letters then a non-hex letter', (n) => `${'a'.repeat(n)}g`],
    ['hex then digit then non-hex tail', (n) => `${'0123456789abcdef'.repeat(Math.ceil(n / 16))}g`],
    ['uuid fragments', (n) => 'aaaaaaaa-aaaa-aaaa-aaaa-'.repeat(Math.ceil(n / 24))],
    ['dates', (n) => '2026-10-1'.repeat(Math.ceil(n / 9))],
    ['slashes', (n) => '1/2/3/'.repeat(Math.ceil(n / 6))],
    ['long number', (n) => '9'.repeat(n)],
    ['non-breaking spaces run', (n) => `1${' '.repeat(n)}minutes`],
    ['alternating word and separator characters', (n) => 'a-'.repeat(n)],
  ];
  for (const [label, make] of families) {
    it(`A13 R-AS2: ${label}: both implementations stay linear (4x input costs about 4x, never 16x) and finish fast`, () => {
      for (const [name, run] of [['findVolatile', (s: string) => findVolatile(s)], ['isVolatileText', (s: string) => isVolatileText(s)]] as const) {
        const g = growth((n) => {
          const s = make(n);
          return () => void run(s);
        }, 60_000);
        expect(g.big, `${name} on 240k chars`).toBeLessThan(6000);
        expect(g.ratio, `${name} growth ratio`).toBeLessThan(10);
      }
    });
  }
});

describe('A13 R-EX1 directive parsing is linear time', () => {
  it('A13: the directive tokenizer is bounded and linear on hostile bodies (unterminated quotes, escape runs, separators, long keys)', () => {
    const bodies: [string, (n: number) => string][] = [
      ['unterminated quote with escapes', (n) => `x="${'\\\\'.repeat(n)}`],
      ['quote escapes that never close', (n) => `x='${'\\\''.repeat(n)}`],
      ['many keys', (n) => 'k=v '.repeat(n)],
      ['one huge key', (n) => 'k'.repeat(n)],
      ['equals runs', (n) => '='.repeat(n)],
      ['quotes runs', (n) => '"'.repeat(n)],
      ['whitespace run', (n) => `a${' '.repeat(n)}b`],
    ];
    for (const [label, make] of bodies) {
      const g = growth((n) => {
        const s = make(n);
        return () => void tokenizeDirective(s);
      }, 50_000);
      expect(g.big, label).toBeLessThan(4000);
      expect(g.ratio, label).toBeLessThan(10);
    }
    // and the documented size limit refuses outright (no unbounded work)
    const huge = parseDirectiveText('a'.repeat(5000), () => undefined);
    expect(huge.tags).toEqual([]);
  });

  it('A13: a directive comment inside a document is bounded and a document full of directive comments parses in linear time', () => {
    const doc = (n: number): string => `# T\n\n<!-- ai-bdd: x="${'\\\\'.repeat(n)}\n\ntext\n`;
    const g1 = growth((n) => {
      const s = doc(n);
      return () => void chunk(s);
    }, 20_000);
    expect(g1.big).toBeLessThan(6000);
    const many = (n: number): string => `# T\n\n${Array.from({ length: n }, () => '<!-- ai-bdd: tags=a,b -->\n\ntext\n\n').join('')}`;
    const g2 = growth((n) => {
      const s = many(n);
      return () => void chunk(s);
    }, 2_000);
    expect(g2.ratio).toBeLessThan(10);
  });

  it('A13: the frontmatter `ai-bdd.tags` list is processed in linear time (no O(n^2) duplicate scan)', () => {
    const g = growth((n) => {
      const tags = Array.from({ length: n }, (_, i) => `tag${i}`);
      return () => {
        const set = emptyDirectiveSet();
        applyDirectiveEntry(set, 'tags', tags, () => undefined);
      };
    }, 15_000);
    expect(g.ratio, `4x tags cost ${g.ratio.toFixed(1)}x`).toBeLessThan(10);
  });

  it('A13: nesting a list marker on one line (`- - - - ...`) or a block quote (`> > > ...`) 8k deep is neutralized and fast', () => {
    for (const marker of ['- ', '> ', '1. ', '* ']) {
      const text = `# T\n\n${marker.repeat(8000)}x\n`;
      expect(best(() => void chunk(text), 1), JSON.stringify(marker)).toBeLessThan(5000);
    }
  });
});

describe('A13 R-EX1 the markdown parser must not be a CPU bomb for hostile documents', () => {
  const cases: [string, (n: number) => string][] = [
    ['unclosed brackets', (n) => `# T\n\n${'['.repeat(n)}text${']'.repeat(n)}\n`],
    ['emphasis delimiters', (n) => `# T\n\n${'*a'.repeat(n)}\n`],
    ['link openers', (n) => `# T\n\n${'[a](b '.repeat(n)}\n`],
    ['image openers', (n) => `# T\n\n${'![a]('.repeat(n)}\n`],
  ];
  for (const [label, make] of cases) {
    it(`A13: ${label}: a 40 KB single-paragraph document is parsed in under 2 seconds`, () => {
      const text = make(20_000);
      const ms = best(() => void chunk(text), 1);
      expect(ms, `${text.length} chars took ${Math.round(ms)} ms`).toBeLessThan(2000);
    }, 60_000);
  }

  it('A13: 400 levels of indented list nesting (160 KB) are parsed in under 2 seconds', () => {
    const text = `# T\n\n${Array.from({ length: 400 }, (_, i) => `${' '.repeat(i * 2)}- item ${i}`).join('\n')}\n`;
    const ms = best(() => void chunk(text), 1);
    expect(ms, `${text.length} chars took ${Math.round(ms)} ms`).toBeLessThan(2000);
  }, 60_000);
});

describe('A13 R-EX1 regular expressions that meet model output', () => {
  const okModel = (text: string): ChatModel => ({
    id: 'text-model',
    async generate(_req: ModelRequest): Promise<ModelResponse> {
      return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop', modelId: 'text-model' };
    },
  });

  it('A13: a model answering with 60k characters of whitespace inside its JSON does not stall extraction parsing (fence-stripping regexes are linear)', async () => {
    const redactor = createRedactor({});
    const extractor = createExtractor({ model: okModel(`{"features": [], "notTestable": [], "pad": "${' '.repeat(60_000)}x"}`), redactor, config });
    const doc = createChunker().chunk({ uri: 'docs/x.md', absolutePath: '/x', text: '# T\n\n## S\n\nSome text of the section here.\n', sha256: '0'.repeat(64) }, { sectionDepth: 2, maxSectionChars: 12000 });
    const section = doc.sections[doc.sections.length - 1];
    if (section === undefined) throw new Error('no section');
    const t = performance.now();
    const res = await extractor.extractSection({ doc, section, fixtures: [], secretNames: [], previousTitles: [], rejected: [] });
    const ms = performance.now() - t;
    expect(res.failed).toBe(true);
    expect(ms, `extraction parse took ${Math.round(ms)} ms`).toBeLessThan(5000);
  }, 60_000);

  it('A13: a judge sample with 60k characters of whitespace in its text does not stall the judge (fence-stripping regexes are linear)', async () => {
    const judge = createJudge({ model: okModel(`{"probability": 0.9, "verdict": "holds", "explanation": "${' '.repeat(60_000)}x", "observed": "o"}`), config, cacheDir: null });
    const ev = { treeText: '- heading "x"' };
    const t = performance.now();
    await judge.judge({ criterion: 'c', params: {}, before: ev, after: ev, actionPreceded: false, appContext: '' }).catch(() => undefined);
    const ms = performance.now() - t;
    expect(ms, `judge parse took ${Math.round(ms)} ms`).toBeLessThan(1000);
  }, 60_000);
});
