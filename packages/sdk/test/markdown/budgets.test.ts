import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/contracts/index.ts';
import { createChunker } from '../../src/markdown/index.ts';
import { MAX_DOC_CHARS, MAX_INDENT_COLUMNS, MAX_RUN_DELIMITERS, neutralizeHostile } from '../../src/markdown/normalize.ts';
import { applyDirectiveEntry, emptyDirectiveSet } from '../../src/markdown/directives.ts';
import { discoverDocs } from '../../src/markdown/discover.ts';
import { atomicWriteFile, stableJson } from '../../src/util/index.ts';
import { chunkText, cpuMs, makeDoc } from './helpers.ts';

const chunker = createChunker();
const opts = { sectionDepth: 2, maxSectionChars: 12000 };
// CPU-time budgets only need to separate linear from quadratic behaviour (seconds), so they are generous; CPU time (not wall time) keeps a busy or instrumented machine from failing them.
const BUDGET_MS = 6000;
chunker.chunk(makeDoc('# warm up\n\n- a\n  - b\n'), opts);

describe('F-12 input budgets', () => {
  it('documents within the budgets are returned untouched', () => {
    const text = '# T\n\nSome *emphasis* and [a link](http://x) and ~~strike~~.\n\n- a\n  - b\n';
    const n = neutralizeHostile(text);
    expect(n.text).toBe(text);
    expect(n.restore.size).toBe(0);
  });

  it('excess delimiters become literal text and the original characters are restored in chunk text', () => {
    const body = '*a'.repeat(MAX_RUN_DELIMITERS * 3);
    const doc = chunker.chunk(makeDoc(`# T\n\n${body}\n`), opts);
    const para = doc.chunks.find((c) => c.kind === 'paragraph');
    expect(para).toBeDefined();
    expect(para?.text.includes('')).toBe(false);
    expect(para?.text.length).toBeGreaterThan(MAX_RUN_DELIMITERS * 2);
    expect(doc.diagnostics.some((d) => d.severity === 'warning' && d.message.includes('delimiter'))).toBe(true);
  });

  it('hostile single-paragraph inputs are parsed quickly', () => {
    for (const make of [(n: number) => '['.repeat(n), (n: number) => '*a'.repeat(n), (n: number) => '[a](b '.repeat(n), (n: number) => ']'.repeat(n), (n: number) => '~~a'.repeat(n)]) {
      expect(cpuMs(() => chunker.chunk(makeDoc(`# T\n\n${make(30_000)}\n`), opts))).toBeLessThan(BUDGET_MS);
    }
  });

  it('deep indentation is neutralized, shallow indentation is untouched, whitespace-only lines stay blank', () => {
    const deep = `${' '.repeat(MAX_INDENT_COLUMNS + 30)}- x`;
    const n = neutralizeHostile(`a\n${deep}\n${' '.repeat(500)}\nb\n`);
    expect(n.indented).toEqual([2]);
    expect(n.text.split('\n')[2]).toBe(' '.repeat(500));
    const text = `# T\n\n${Array.from({ length: 400 }, (_, i) => `${' '.repeat(i * 2)}- item ${i}`).join('\n')}\n`;
    expect(cpuMs(() => chunker.chunk(makeDoc(text), opts))).toBeLessThan(BUDGET_MS);
  });

  it('a code block containing deep indentation keeps its text exactly', () => {
    const code = `${' '.repeat(MAX_INDENT_COLUMNS + 10)}wide line`;
    const plain = chunkText('# T\n\n```\n  wide line\n```\n').chunks.find((c) => c.kind === 'code')?.text;
    const doc = chunker.chunk(makeDoc(`# T\n\n\`\`\`\n${code}\n\`\`\`\n`), opts);
    expect(doc.chunks.find((c) => c.kind === 'code')?.text).toBe(plain);
  });

  it('a document over the size cap is an error for that document only', () => {
    const doc = chunker.chunk(makeDoc(`# T\n\n${'x'.repeat(MAX_DOC_CHARS + 1)}\n`), opts);
    expect(doc.chunks).toEqual([]);
    expect(doc.diagnostics).toMatchObject([{ code: 'DOC_READ_FAILED', severity: 'error' }]);
    expect(chunkText('# T\n\nfine\n').chunks.length).toBeGreaterThan(0);
  });
});

describe('F-11 tags', () => {
  it('duplicates are dropped and order is kept, with many tags', () => {
    const set = emptyDirectiveSet();
    const tags = [...Array.from({ length: 20000 }, (_, i) => `t${i}`), 't0', 't5'];
    applyDirectiveEntry(set, 'tags', tags, () => undefined);
    expect(set.tags.length).toBe(20000);
    expect(set.tags.slice(0, 3)).toEqual(['t0', 't1', 't2']);
  });
});

describe('F-16 docUri normalization', () => {
  it('an NFD file name gets an NFC uri and is still read through its real path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'md-nfc-'));
    try {
      const nfd = 'café.md';
      writeFileSync(join(root, nfd), '# T\n');
      const docs = await discoverDocs({ projectRoot: root, docs: ['*.md'], exclude: [] } as never);
      expect(docs.map((d) => d.uri)).toEqual(['café.md']);
      expect(docs[0]?.text).toBe('# T\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('F-17 stableJson and F-09 atomicWriteFile', () => {
  it('keeps an own __proto__ key and the same bytes for ordinary inputs', () => {
    const v = JSON.parse('{"b":1,"__proto__":{"x":1},"a":[{"d":1,"c":2}]}') as JsonValue;
    expect(stableJson(v)).toBe('{\n  "__proto__": {\n    "x": 1\n  },\n  "a": [\n    {\n      "c": 2,\n      "d": 1\n    }\n  ],\n  "b": 1\n}\n');
  });

  it('refuses to write through a symlink that leaves the root, and writes normally inside it', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aw-'));
    const root = join(base, 'project');
    const outside = join(base, 'outside');
    try {
      mkdirSync(join(root, '.ai-bdd'), { recursive: true });
      mkdirSync(outside);
      symlinkSync(outside, join(root, '.ai-bdd', 'runs'));
      await expect(atomicWriteFile(join(root, '.ai-bdd', 'runs', 'r1', 'm.json'), '{}')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await expect(atomicWriteFile(join(root, 'plans', 'x', 'm.json'), '{}', { root })).resolves.toBeUndefined();
      await expect(atomicWriteFile(join(root, 'link', 'm.json'), '{}', { root: join(root, 'plans') })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
