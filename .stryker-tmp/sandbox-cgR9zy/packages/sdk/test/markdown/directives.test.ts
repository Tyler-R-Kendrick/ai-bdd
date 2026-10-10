// @ts-nocheck
import { describe, expect, it } from 'vitest';
import {
  applyDirectiveEntry,
  directiveBody,
  emptyDirectiveSet,
  findComments,
  mergeInto,
  parseDirectiveText,
  parseFrontmatterDirectives,
  resolveDirectives,
  tokenizeDirective,
  type DirectiveReport,
} from '../../src/markdown/directives.ts';
import { chunkText } from './helpers.ts';

function collect(): { report: DirectiveReport; seen: { code: string; message: string }[] } {
  const seen: { code: string; message: string }[] = [];
  return { seen, report: (code, message) => void seen.push({ code, message }) };
}

describe('directive grammar', () => {
  it('R-EX4: tokenizes flags, bare values, double and single quoted values', () => {
    const { entries, errors } = tokenizeDirective(` ignore key=value other="v w" third='x y' `);
    expect(errors).toEqual([]);
    expect(entries).toEqual([
      { key: 'ignore', value: true },
      { key: 'key', value: 'value' },
      { key: 'other', value: 'v w' },
      { key: 'third', value: 'x y' },
    ]);
  });

  it('R-EX4: supports backslash escapes for quotes and backslashes inside quoted values', () => {
    const { entries, errors } = tokenizeDirective(String.raw`a="x\"y" b='it\'s' c="p\\q"`);
    expect(errors).toEqual([]);
    expect(entries.map((e) => e.value)).toEqual(['x"y', "it's", 'p\\q']);
  });

  it('R-EX4: reports malformed tokens as errors without throwing', () => {
    const cases = ['key=', 'key="open', 'key="a"b', '$$$', '=oops', 'a,b', 'x=y z='];
    for (const c of cases) {
      const { errors } = tokenizeDirective(c);
      expect(errors.length, c).toBeGreaterThan(0);
    }
  });

  it('R-EX4: only comments whose body starts with "ai-bdd:" are directives', () => {
    expect(directiveBody(' ai-bdd: ignore ')).toBe(' ignore ');
    expect(directiveBody('ai-bdd:ignore')).toBe('ignore');
    expect(directiveBody('  ai-bdd :  fuzzy')).toBe('  fuzzy');
    expect(directiveBody('ai-bdd is documented')).toBeNull();
    expect(directiveBody('AI-BDD: ignore')).toBeNull();
    expect(directiveBody(' other: ignore')).toBeNull();
  });

  it('R-EX4: finds every comment in an html block and flags unterminated ones', () => {
    const found = findComments('<!-- a --> text <!-- b --><!-- c');
    expect(found).toEqual([
      { body: ' a ', terminated: true },
      { body: ' b ', terminated: true },
      { body: ' c', terminated: false },
    ]);
  });

  it('R-EX4: flag values accept true/false and reject anything else with DIRECTIVE_INVALID', () => {
    const { report, seen } = collect();
    const set = emptyDirectiveSet();
    applyDirectiveEntry(set, 'ignore', true, report);
    applyDirectiveEntry(set, 'context', 'false', report);
    applyDirectiveEntry(set, 'fuzzy', 'maybe', report);
    applyDirectiveEntry(set, 'fuzzy', 3, report);
    expect(set.ignore).toBe(true);
    expect(set.context).toBe(false);
    expect(set.fuzzy).toBeUndefined();
    expect(seen.map((s) => s.code)).toEqual(['DIRECTIVE_INVALID', 'DIRECTIVE_INVALID']);
  });

  it('R-EX4: value keys validate driver, start and tags', () => {
    const { report, seen } = collect();
    const set = emptyDirectiveSet();
    applyDirectiveEntry(set, 'driver', 'web', report);
    applyDirectiveEntry(set, 'driver', 'bad name', report);
    applyDirectiveEntry(set, 'driver', true, report);
    applyDirectiveEntry(set, 'start', '/billing', report);
    applyDirectiveEntry(set, 'start', '   ', report);
    applyDirectiveEntry(set, 'start', 'a\nb', report);
    applyDirectiveEntry(set, 'tags', ' a, @b ,,a', report);
    applyDirectiveEntry(set, 'tags', ['c', 'd e'], report);
    applyDirectiveEntry(set, 'tags', 7, report);
    expect(set.driver).toBe('web');
    expect(set.start).toBe('/billing');
    expect(set.tags).toEqual(['a', 'b', 'c']);
    expect(seen.every((s) => s.code === 'DIRECTIVE_INVALID')).toBe(true);
    expect(seen).toHaveLength(6);
  });

  it('R-EX4: unknown keys give DIRECTIVE_UNKNOWN_KEY (including prototype-ish names) and are ignored', () => {
    const { report, seen } = collect();
    const set = emptyDirectiveSet();
    for (const key of ['color', '__proto__', 'constructor', 'toString']) applyDirectiveEntry(set, key, 'x', report);
    expect(seen.map((s) => s.code)).toEqual(Array(4).fill('DIRECTIVE_UNKNOWN_KEY'));
    expect(set).toEqual({ tags: [] });
  });

  it('R-EX4: an empty directive is DIRECTIVE_INVALID', () => {
    const { report, seen } = collect();
    parseDirectiveText('   ', report);
    expect(seen).toEqual([{ code: 'DIRECTIVE_INVALID', message: 'empty directive' }]);
  });

  it('R-EX4: frontmatter mapping must be an object', () => {
    for (const bad of ['ignore', ['ignore'], null, 3]) {
      const { report, seen } = collect();
      parseFrontmatterDirectives(bad, report);
      expect(seen.map((s) => s.code)).toEqual(['DIRECTIVE_INVALID']);
    }
    const { report, seen } = collect();
    const set = parseFrontmatterDirectives({ ignore: true, tags: ['a'], zzz: 1 }, report);
    expect(set.ignore).toBe(true);
    expect(set.tags).toEqual(['a']);
    expect(seen.map((s) => s.code)).toEqual(['DIRECTIVE_UNKNOWN_KEY']);
  });

  it('R-EX4: nested scopes override key by key and tags merge; explicit false turns a flag off', () => {
    const outer = { ...emptyDirectiveSet(), ignore: true, driver: 'a', tags: ['x'] };
    const inner = { ...emptyDirectiveSet(), ignore: false, start: '/s', tags: ['y', 'x'] };
    const merged = resolveDirectives([outer, inner]);
    expect(merged).toEqual({ driver: 'a', start: '/s', tags: ['x', 'y'] });
    const target = emptyDirectiveSet();
    mergeInto(target, outer);
    mergeInto(target, inner);
    expect(target.ignore).toBe(false);
  });

  it('R-EX4: ReDoS: pathological directive text is processed in linear time', () => {
    const inputs = [
      `${'a='.repeat(50_000)}`,
      `key="${'\\'.repeat(100_000)}`,
      `${' '.repeat(100_000)}x`,
      `${'"'.repeat(100_000)}`,
      `${'a=b '.repeat(20_000)}`,
    ];
    for (const input of inputs) {
      const t0 = performance.now();
      tokenizeDirective(input);
      const html = `<!-- ai-bdd: ${input} -->`;
      chunkText(`# H\n\n${html}\n\ntext\n`);
      expect(performance.now() - t0, 'elapsed ms').toBeLessThan(5000);
    }
    const t1 = performance.now();
    findComments('<!--'.repeat(100_000));
    expect(performance.now() - t1).toBeLessThan(3000);
  });

  it('R-EX4: directive comments beyond the length cap are rejected, not parsed', () => {
    const doc = chunkText(`# H\n\ntext\n\n<!-- ai-bdd: tags=${'a'.repeat(5000)} -->\nnext\n`);
    expect(doc.diagnostics.map((d) => d.code)).toEqual(['DIRECTIVE_INVALID']);
    expect(doc.chunks.at(-1)?.directives.tags).toBeUndefined();
  });
});
