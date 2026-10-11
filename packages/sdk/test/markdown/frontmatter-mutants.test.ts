import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentOptions, ParseOptions, SchemaOptions, ToJSOptions } from 'yaml';
import type { JsonValue } from '../../src/contracts/index.ts';

const yamlParse = vi.hoisted(() => ({ override: undefined as undefined | ((source: string) => unknown) }));

vi.mock('yaml', async (importOriginal) => {
  const actual = await importOriginal<typeof import('yaml')>();
  return {
    ...actual,
    parse: (source: string, options?: ParseOptions & DocumentOptions & SchemaOptions & ToJSOptions) =>
      yamlParse.override !== undefined ? yamlParse.override(source) : actual.parse(source, options),
  };
});

const { parseFrontmatter, toJsonValue } = await import('../../src/markdown/frontmatter.ts');

afterEach(() => {
  yamlParse.override = undefined;
  vi.restoreAllMocks();
});

/** Number of container levels before the value stops being a container, and what it stopped at. */
function descend(value: JsonValue): { levels: number; end: JsonValue } {
  let cur = value;
  let levels = 0;
  while (typeof cur === 'object' && cur !== null) {
    cur = Array.isArray(cur) ? (cur[0] as JsonValue) : (Object.values(cur)[0] as JsonValue);
    levels++;
  }
  return { levels, end: cur };
}

describe('toJsonValue nesting limit applies to every container kind', () => {
  const wrappers: [string, (inner: unknown) => unknown][] = [
    ['arrays', (inner) => [inner]],
    ['plain objects', (inner) => ({ k: inner })],
    ['Maps', (inner) => new Map([['k', inner]])],
  ];

  it.each(wrappers)('%s nested 70 levels deep are cut to null after 64 levels', (_name, wrap) => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 70; i++) deep = wrap(deep);
    expect(descend(toJsonValue(deep))).toEqual({ levels: 64, end: null });
  });

  it.each(wrappers)('%s nested 63 levels deep are kept whole', (_name, wrap) => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 63; i++) deep = wrap(deep);
    expect(descend(toJsonValue(deep))).toEqual({ levels: 63, end: 'leaf' });
  });

  it.each(wrappers)('%s nested exactly 64 levels deep are kept whole (a scalar is never cut), one more level is cut', (_name, wrap) => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 64; i++) deep = wrap(deep);
    expect(descend(toJsonValue(deep))).toEqual({ levels: 64, end: 'leaf' });
    expect(descend(toJsonValue(wrap(deep)))).toEqual({ levels: 64, end: null });
  });

  it('the depth argument is the starting level', () => {
    expect(toJsonValue(['x'], 63)).toEqual(['x']);
    expect(toJsonValue([['x']], 63)).toEqual([null]);
    expect(toJsonValue({ a: { b: 'x' } }, 63)).toEqual({ a: null });
    expect(toJsonValue(new Map([['a', new Map([['b', 'x']])]]), 63)).toEqual({ a: null });
    expect(toJsonValue(['x'], 64)).toBeNull();
    expect(toJsonValue({ a: 'x' }, 64)).toBeNull();
    expect(toJsonValue(new Map(), 64)).toBeNull();
    expect(toJsonValue('x', 64)).toBe('x');
  });

  it('mixed containers count one level each', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 70; i++) deep = i % 3 === 0 ? [deep] : i % 3 === 1 ? { k: deep } : new Map([['k', deep]]);
    expect(descend(toJsonValue(deep))).toEqual({ levels: 64, end: null });
  });
});

describe('parseFrontmatter parser options', () => {
  it('is strict: a comment glued to a quoted value is an error, not accepted', () => {
    expect(parseFrontmatter('a: "b"#c')).toEqual({ ok: false, error: 'Comments must be separated from other tokens by white space characters at line 1, column 7' });
  });

  it('never emits warnings: an unresolved tag parses to its plain value silently', () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseFrontmatter('a: !foo bar')).toEqual({ ok: true, value: { a: 'bar' } });
    expect(emit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('parseFrontmatter error text', () => {
  it.each([
    ['a colon', 'boom:', 'boom'],
    ['several colons and spaces', 'boom: : :  ', 'boom'],
    ['two trailing colons', 'boom::', 'boom'],
    ['trailing whitespace only', 'boom \t ', 'boom'],
    ['a colon after spaces', 'boom  :', 'boom'],
    ['interior colons and spaces are kept', 'a: b : c', 'a: b : c'],
    ['no trailing characters', 'plain', 'plain'],
  ])('trailing separators are removed from the first line: %s', (_name, message, expected) => {
    yamlParse.override = () => {
      throw new Error(`${message}\n\nsecond line\n^`);
    };
    expect(parseFrontmatter('x')).toEqual({ ok: false, error: expected });
  });

  it('only the first line of a message is used', () => {
    yamlParse.override = () => {
      throw new Error('first\nsecond: line\nthird');
    };
    expect(parseFrontmatter('x')).toEqual({ ok: false, error: 'first' });
  });

  it('a message of only separators becomes the empty string', () => {
    yamlParse.override = () => {
      throw new Error(' : :\nnext');
    };
    expect(parseFrontmatter('x')).toEqual({ ok: false, error: '' });
  });

  it('an empty message stays empty', () => {
    yamlParse.override = () => {
      throw new Error('');
    };
    expect(parseFrontmatter('x')).toEqual({ ok: false, error: '' });
  });

  it('a thrown value that is not an Error is converted with String()', () => {
    yamlParse.override = () => {
      throw 'plain failure: \nmore';
    };
    expect(parseFrontmatter('x')).toEqual({ ok: false, error: 'plain failure' });
  });

  it('the cut at 300 characters is applied after the trailing separators are removed', () => {
    yamlParse.override = () => {
      throw new Error(`${'e'.repeat(299)}: : \n`);
    };
    expect(parseFrontmatter('x')).toEqual({ ok: false, error: 'e'.repeat(299) });
    yamlParse.override = () => {
      throw new Error(`${'e'.repeat(301)}:\n`);
    };
    expect(parseFrontmatter('x')).toEqual({ ok: false, error: 'e'.repeat(300) });
  });
});
