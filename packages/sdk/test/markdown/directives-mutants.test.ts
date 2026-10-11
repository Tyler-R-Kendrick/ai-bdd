import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyDirectiveEntry,
  emptyDirectiveSet,
  findComments,
  mergeInto,
  tokenizeDirective,
  type DirectiveReport,
  type DirectiveSet,
} from '../../src/markdown/directives.ts';
import type { JsonValue } from '../../src/contracts/index.ts';

interface Reported {
  code: string;
  message: string;
  details?: JsonValue;
}

function collect(): { report: DirectiveReport; seen: Reported[] } {
  const seen: Reported[] = [];
  return {
    seen,
    report: (code, message, details) => void seen.push(details === undefined ? { code, message } : { code, message, details }),
  };
}

function apply(key: string, value: unknown, set: DirectiveSet = emptyDirectiveSet()): { set: DirectiveSet; seen: Reported[] } {
  const { report, seen } = collect();
  applyDirectiveEntry(set, key, value, report);
  return { set, seen };
}

const flag = (key: string) => ({ key, value: true as const });

describe('findComments', () => {
  it('resumes scanning after the closing marker, so a "<!--" sharing dashes with it is not a new comment', () => {
    expect(findComments('<!--<!-->')).toEqual([{ body: '<!', terminated: true }]);
  });

  it('finds adjacent comments and an empty comment body', () => {
    expect(findComments('<!---->x<!-- b -->')).toEqual([
      { body: '', terminated: true },
      { body: ' b ', terminated: true },
    ]);
  });
});

describe('tokenizeDirective: whitespace', () => {
  it.each([
    ['space', ' '],
    ['tab', '\t'],
    ['line feed', '\n'],
    ['carriage return', '\r'],
    ['form feed', '\f'],
    ['vertical tab', '\v'],
  ])('a %s separates tokens, ends a bare value and ends a quoted value', (_name, ws) => {
    expect(tokenizeDirective(`${ws}a${ws}b${ws}`)).toEqual({ entries: [flag('a'), flag('b')], errors: [] });
    expect(tokenizeDirective(`k=v${ws}j=w`)).toEqual({
      entries: [
        { key: 'k', value: 'v' },
        { key: 'j', value: 'w' },
      ],
      errors: [],
    });
    expect(tokenizeDirective(`k="v w"${ws}j`)).toEqual({ entries: [{ key: 'k', value: 'v w' }, flag('j')], errors: [] });
    expect(tokenizeDirective(`k=${ws}j`)).toEqual({ entries: [flag('j')], errors: ['key "k" has an empty value'] });
  });

  it.each([
    ['non-breaking space', ' '],
    ['line separator', ' '],
    ['ideographic space', '　'],
  ])('a %s is not whitespace of the grammar', (_name, ch) => {
    expect(tokenizeDirective(`a${ch}b`)).toEqual({ entries: [], errors: [`unexpected token ${JSON.stringify(`a${ch}b`)}`] });
  });
});

describe('tokenizeDirective: key characters', () => {
  it.each(['0', '9', 'A', 'Z', 'a', 'z', '-', '_'])('%s is a key character (both as a whole key and inside one)', (ch) => {
    expect(tokenizeDirective(ch)).toEqual({ entries: [flag(ch)], errors: [] });
    expect(tokenizeDirective(`x${ch}y=1`)).toEqual({ entries: [{ key: `x${ch}y`, value: '1' }], errors: [] });
  });

  it.each(['/', ':', ';', '<', '>', '?', '@', '[', '\\', ']', '^', '`', '{', '|', '}', '~', '.', '+', '$', '!', '\u007f', 'é', 'ß', '中'])(
    '%j is not a key character',
    (ch) => {
      expect(tokenizeDirective(ch)).toEqual({ entries: [], errors: [`unexpected token ${JSON.stringify(ch)}`] });
      expect(tokenizeDirective(`k${ch}`)).toEqual({ entries: [], errors: [`unexpected token ${JSON.stringify(`k${ch}`)}`] });
    },
  );
});

describe('tokenizeDirective: error reporting', () => {
  it.each([
    ['a key containing a non key character', 'a,b', [], ['unexpected token "a,b"']],
    ['the same, followed by more tokens', 'x a,b y', [flag('x'), flag('y')], ['unexpected token "a,b"']],
    ['a token that does not start with a key character', '$$$ ok', [flag('ok')], ['unexpected token "$$$"']],
    ['a leading equals sign', '=oops', [], ['unexpected token "=oops"']],
    ['a token that is not a key and stops at whitespace', '$ a', [flag('a')], ['unexpected token "$"']],
    ['an empty value at the end', 'key=', [], ['key "key" has an empty value']],
    ['an empty value before another token', 'key= other', [flag('other')], ['key "key" has an empty value']],
    ['an unterminated quoted value (everything after it is dropped)', 'k="open v=1', [], ['unterminated quoted value for key "k"']],
    ['an unterminated single quoted value', "k='open", [], ['unterminated quoted value for key "k"']],
    ['an escaped closing quote that leaves the value unterminated', String.raw`k="x\"`, [], ['unterminated quoted value for key "k"']],
    ['characters glued to a closing quote', 'a="b"cd e', [flag('e')], ['unexpected characters "cd" after quoted value of "a"']],
    ['characters glued to a closing single quote, at the end', "a='b'cd", [], ['unexpected characters "cd" after quoted value of "a"']],
    ['a quoted value directly followed by another quoted value', 'a="b""c" d', [flag('d')], ['unexpected characters "\\"c\\"" after quoted value of "a"']],
  ])('%s', (_name, input, entries, errors) => {
    expect(tokenizeDirective(input)).toEqual({ entries, errors });
  });

  it('collects several errors in order and keeps tokenizing after each', () => {
    expect(tokenizeDirective('a,b k= $x z="q"r ok')).toEqual({
      entries: [flag('ok')],
      errors: ['unexpected token "a,b"', 'key "k" has an empty value', 'unexpected token "$x"', 'unexpected characters "r" after quoted value of "z"'],
    });
  });

  it('a bare value running to the end of the text is kept whole', () => {
    expect(tokenizeDirective('a=b')).toEqual({ entries: [{ key: 'a', value: 'b' }], errors: [] });
    expect(tokenizeDirective('a=b=c,d')).toEqual({ entries: [{ key: 'a', value: 'b=c,d' }], errors: [] });
  });

  it('a quoted value running to the end of the text is accepted', () => {
    expect(tokenizeDirective('a="b c"')).toEqual({ entries: [{ key: 'a', value: 'b c' }], errors: [] });
    expect(tokenizeDirective('a=""')).toEqual({ entries: [{ key: 'a', value: '' }], errors: [] });
  });
});

describe('tokenizeDirective: excerpts of offending text are cut at 40 characters', () => {
  const at40 = '$'.repeat(40);
  const at41 = '$'.repeat(41);

  it('text of exactly 40 characters is kept whole, longer text is cut to 40 plus an ellipsis, at every site that quotes input', () => {
    expect(tokenizeDirective(at40).errors).toEqual([`unexpected token "${at40}"`]);
    expect(tokenizeDirective(at41).errors).toEqual([`unexpected token "${at40}..."`]);
    expect(tokenizeDirective(`k${'$'.repeat(39)}`).errors).toEqual([`unexpected token "k${'$'.repeat(39)}"`]);
    expect(tokenizeDirective(`k${at40}`).errors).toEqual([`unexpected token "k${'$'.repeat(39)}..."`]);
    expect(tokenizeDirective(`a="b"${'x'.repeat(40)}`).errors).toEqual([`unexpected characters "${'x'.repeat(40)}" after quoted value of "a"`]);
    expect(tokenizeDirective(`a="b"${'x'.repeat(41)}`).errors).toEqual([`unexpected characters "${'x'.repeat(40)}..." after quoted value of "a"`]);
  });
});

describe('tokenizeDirective: quoted values and escapes', () => {
  it.each([
    ['a backslash before an ordinary character is kept literally', String.raw`a="x\yz"`, String.raw`x\yz`],
    ['a backslash before a letter n is not a newline', String.raw`a="x\ny"`, String.raw`x\ny`],
    ['an escaped double quote', String.raw`a="x\"y"`, 'x"y'],
    ['an escaped single quote inside single quotes', String.raw`a='x\'y'`, "x'y"],
    ['a backslash before the other quote kind is literal', String.raw`a="x\'y"`, String.raw`x\'y`],
    ['an escaped backslash', String.raw`a="p\\q"`, String.raw`p\q`],
    ['an escaped backslash right before the closing quote', String.raw`a="p\\"`, 'p\\'],
    ['two escaped backslashes', String.raw`a="\\\\"`, '\\\\'],
    ['an escaped backslash then an escaped quote', String.raw`a="\\\""`, '\\"'],
    ['a backslash as the first character, before a quote', String.raw`a="\"x"`, '"x'],
    ['a lone backslash value', String.raw`a="\q"`, String.raw`\q`],
  ])('%s', (_name, input, value) => {
    expect(tokenizeDirective(input)).toEqual({ entries: [{ key: 'a', value }], errors: [] });
  });

  it('a trailing backslash with nothing after it leaves the value unterminated', () => {
    expect(tokenizeDirective('a="x\\')).toEqual({ entries: [], errors: ['unterminated quoted value for key "a"'] });
  });
});

describe('tokenizeDirective: the 4096 character cap', () => {
  it('accepts text of exactly 4096 characters', () => {
    const key = 'a'.repeat(4096);
    expect(tokenizeDirective(key)).toEqual({ entries: [flag(key)], errors: [] });
  });

  it('rejects text of 4097 characters with one error and no entries', () => {
    expect(tokenizeDirective('a'.repeat(4097))).toEqual({ entries: [], errors: ['directive is longer than 4096 characters'] });
    expect(tokenizeDirective(`ignore ${' '.repeat(4089)}`)).toEqual({ entries: [flag('ignore')], errors: [] });
    expect(tokenizeDirective(`ignore ${' '.repeat(4090)}`)).toEqual({ entries: [], errors: ['directive is longer than 4096 characters'] });
  });
});

describe('applyDirectiveEntry: flags', () => {
  it.each([
    ['ignore', true, true],
    ['ignore', false, false],
    ['context', true, true],
    ['context', false, false],
    ['fuzzy', true, true],
    ['fuzzy', false, false],
    ['ignore', 'true', true],
    ['context', 'false', false],
    ['fuzzy', 'TRUE', true],
    ['ignore', 'False', false],
    ['context', 'tRuE', true],
  ] as const)('%s with %j sets the flag to %j and reports nothing', (key, value, expected) => {
    const { set, seen } = apply(key, value);
    expect(set[key]).toBe(expected);
    expect(seen).toEqual([]);
  });

  it.each([['yes'], [''], ['1'], ['truee'], [' true'], [1], [0], [null], [undefined], [['true']], [{}]])('%j is not a flag value', (value) => {
    const { set, seen } = apply('fuzzy', value);
    expect(set).toEqual({ tags: [] });
    expect(seen).toEqual([{ code: 'DIRECTIVE_INVALID', message: '"fuzzy" is a flag; expected no value, true or false', details: { key: 'fuzzy' } }]);
  });

  it('an invalid flag value leaves an earlier value untouched', () => {
    const set: DirectiveSet = { tags: [], ignore: true };
    apply('ignore', 'nope', set);
    expect(set.ignore).toBe(true);
  });
});

describe('applyDirectiveEntry: driver', () => {
  it.each([['web'], ['a'], ['0'], ['playwright-2.x_y'], ['a'.repeat(64)]])('%j is a driver name', (name) => {
    const { set, seen } = apply('driver', name);
    expect(set.driver).toBe(name);
    expect(seen).toEqual([]);
  });

  it.each([['bad name'], [''], ['-a'], ['.a'], ['a'.repeat(65)], [3], [true], [null], [['web']]])('%j is not a driver name', (value) => {
    const { set, seen } = apply('driver', value);
    expect(set.driver).toBeUndefined();
    expect(seen).toEqual([{ code: 'DIRECTIVE_INVALID', message: '"driver" requires a driver name (letters, digits, ".", "_", "-")', details: { key: 'driver' } }]);
  });
});

describe('applyDirectiveEntry: start', () => {
  it.each([
    ['/billing', '/billing'],
    ['  /billing  ', '/billing'],
    ['   /x y\u00a0', '/x y'],
    ['https://example.test/a?b=c#d', 'https://example.test/a?b=c#d'],
    ['a'.repeat(2048), 'a'.repeat(2048)],
    [` ${'a'.repeat(2047)}`, 'a'.repeat(2047)],
    ['\u0080', '\u0080'],
  ])('%j is accepted and stored trimmed as %j', (value, expected) => {
    const { set, seen } = apply('start', value);
    expect(set.start).toBe(expected);
    expect(seen).toEqual([]);
  });

  it.each([[''], ['   '], ['\t'], ['a'.repeat(2049)], ['a\nb'], ['a\u001fb'], ['a\u007fb'], ['\u007f'], ['a\tb'], ['\t/x\t'], [5], [true], [null], [['/x']]])(
    '%j is rejected',
    (value) => {
      const { set, seen } = apply('start', value);
      expect(set.start).toBeUndefined();
      expect(seen).toEqual([{ code: 'DIRECTIVE_INVALID', message: '"start" requires a non-empty path or URL', details: { key: 'start' } }]);
    },
  );
});

describe('applyDirectiveEntry: tags', () => {
  const listMessage = '"tags" requires a comma separated list';

  it.each([[''], [' '], [','], [' , '], [',,,'], ['\t, \n']])('the string %j holds no tag and is reported once', (value) => {
    const { set, seen } = apply('tags', value);
    expect(set.tags).toEqual([]);
    expect(seen).toEqual([{ code: 'DIRECTIVE_INVALID', message: listMessage, details: { key: 'tags' } }]);
  });

  it.each([[7], [true], [null], [{ a: 1 }], [undefined]])('the non-string, non-array value %j is reported once', (value) => {
    const { set, seen } = apply('tags', value);
    expect(set.tags).toEqual([]);
    expect(seen).toEqual([{ code: 'DIRECTIVE_INVALID', message: listMessage, details: { key: 'tags' } }]);
  });

  it.each([[['a', 7]], [[7]], [[null, 'a']], [[['a']]], [['a', undefined]]])('the array %j contains a non-string and is rejected as a whole', (value) => {
    const { set, seen } = apply('tags', value);
    expect(set.tags).toEqual([]);
    expect(seen).toEqual([{ code: 'DIRECTIVE_INVALID', message: listMessage, details: { key: 'tags' } }]);
  });

  it('an empty array adds no tags and reports nothing', () => {
    const { set, seen } = apply('tags', []);
    expect(set.tags).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('blank entries inside an array or list are skipped silently', () => {
    expect(apply('tags', ['a', '', '  ', 'b']).set.tags).toEqual(['a', 'b']);
    expect(apply('tags', 'a, ,b').seen).toEqual([]);
  });

  it.each([
    ['a,b', ['a', 'b']],
    [' a , @b ,,a ', ['a', 'b']],
    ['@a', ['a']],
    ['x/y:z.w_v-u,0', ['x/y:z.w_v-u', '0']],
    ['b,a,b,a', ['b', 'a']],
  ])('the string %j gives the tags %j', (value, tags) => {
    const { set, seen } = apply('tags', value);
    expect(set.tags).toEqual(tags);
    expect(seen).toEqual([]);
  });

  it('only one leading @ is removed, and only at the start of the trimmed entry', () => {
    const { set, seen } = apply('tags', '@@a, a@b, @ c,x@');
    expect(set.tags).toEqual([]);
    expect(seen).toEqual([
      { code: 'DIRECTIVE_INVALID', message: 'invalid tag "@@a"', details: { key: 'tags' } },
      { code: 'DIRECTIVE_INVALID', message: 'invalid tag "a@b"', details: { key: 'tags' } },
      { code: 'DIRECTIVE_INVALID', message: 'invalid tag "@ c"', details: { key: 'tags' } },
      { code: 'DIRECTIVE_INVALID', message: 'invalid tag "x@"', details: { key: 'tags' } },
    ]);
  });

  it('an invalid tag is reported with its trimmed text and the valid ones around it are kept', () => {
    const { set, seen } = apply('tags', '  ok ,  b d  , fine');
    expect(set.tags).toEqual(['ok', 'fine']);
    expect(seen).toEqual([{ code: 'DIRECTIVE_INVALID', message: 'invalid tag "b d"', details: { key: 'tags' } }]);
  });

  it('a tag of 64 characters is valid and one of 65 is reported with a 40 character excerpt', () => {
    const ok = 'a'.repeat(64);
    const { set, seen } = apply('tags', [ok, 'a'.repeat(65), 'b'.repeat(40) + '#', 'c'.repeat(39) + '#']);
    expect(set.tags).toEqual([ok]);
    expect(seen.map((s) => s.message)).toEqual([`invalid tag "${'a'.repeat(40)}..."`, `invalid tag "${'b'.repeat(40)}..."`, `invalid tag "${'c'.repeat(39)}#"`]);
  });

  it('tags accumulate across entries and are never duplicated', () => {
    const set = emptyDirectiveSet();
    apply('tags', 'a,b', set);
    apply('tags', ['b', 'c'], set);
    apply('tags', '@a,d', set);
    expect(set.tags).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('applyDirectiveEntry: unknown keys', () => {
  it('reports the key (cut at 40 characters) with DIRECTIVE_UNKNOWN_KEY and the whole key in the details', () => {
    expect(apply('color', 'red')).toEqual({
      set: { tags: [] },
      seen: [{ code: 'DIRECTIVE_UNKNOWN_KEY', message: 'unknown directive key "color" (ignored)', details: { key: 'color' } }],
    });
    const at40 = 'k'.repeat(40);
    const at41 = 'k'.repeat(41);
    expect(apply(at40, 1).seen).toEqual([{ code: 'DIRECTIVE_UNKNOWN_KEY', message: `unknown directive key "${at40}" (ignored)`, details: { key: at40 } }]);
    expect(apply(at41, 1).seen).toEqual([{ code: 'DIRECTIVE_UNKNOWN_KEY', message: `unknown directive key "${at40}..." (ignored)`, details: { key: at41 } }]);
  });

  it('recognises exactly the six keys', () => {
    for (const key of ['ignore', 'context', 'fuzzy', 'driver', 'start', 'tags']) {
      expect(apply(key, 'x').seen.map((s) => s.code)).not.toContain('DIRECTIVE_UNKNOWN_KEY');
    }
    for (const key of ['Ignore', 'ignore ', 'tag', 'drivers', '']) {
      expect(apply(key, 'x').seen.map((s) => s.code)).toEqual(['DIRECTIVE_UNKNOWN_KEY']);
    }
  });
});

describe('tag de-duplication keeps working when the array is changed from outside', () => {
  it('re-reads an array that grew behind its back', () => {
    const set = emptyDirectiveSet();
    apply('tags', 'a', set);
    set.tags.push('b');
    apply('tags', 'b,c', set);
    expect(set.tags).toEqual(['a', 'b', 'c']);
  });

  it('re-reads an array that shrank behind its back', () => {
    const set = emptyDirectiveSet();
    apply('tags', 'a,b', set);
    set.tags.length = 0;
    apply('tags', 'a', set);
    expect(set.tags).toEqual(['a']);
  });

  it('mergeInto de-duplicates against tags added directly to the target', () => {
    const target = emptyDirectiveSet();
    mergeInto(target, { tags: ['a'] });
    target.tags.push('b');
    mergeInto(target, { tags: ['b', 'c', 'a'] });
    expect(target.tags).toEqual(['a', 'b', 'c']);
  });
});

describe('tag de-duplication keeps one lookup set per array', () => {
  const realSet = globalThis.Set;
  afterEach(() => {
    globalThis.Set = realSet;
    vi.restoreAllMocks();
  });

  /** Counts how many elements are copied into new Sets (a rebuild per added tag would make the cost grow with the square of the list). */
  function copiedIntoSets(run: () => void): number {
    let copied = 0;
    class CountingSet<T> extends realSet<T> {
      constructor(iterable?: Iterable<T> | null) {
        super(iterable);
        copied += this.size;
      }
    }
    globalThis.Set = CountingSet as unknown as SetConstructor;
    try {
      run();
    } finally {
      globalThis.Set = realSet;
    }
    return copied;
  }

  it('applyDirectiveEntry adding 300 distinct tags one by one never rebuilds the lookup set from the array', () => {
    const set = emptyDirectiveSet();
    const { report } = collect();
    const copied = copiedIntoSets(() => {
      for (let i = 0; i < 300; i++) applyDirectiveEntry(set, 'tags', `t${i}`, report);
    });
    expect(set.tags).toHaveLength(300);
    expect(copied).toBe(0);
  });

  it('mergeInto of 300 tags never rebuilds the lookup set from the array either', () => {
    const target = emptyDirectiveSet();
    const over: DirectiveSet = { tags: Array.from({ length: 300 }, (_, i) => `t${i}`) };
    const copied = copiedIntoSets(() => {
      mergeInto(target, over);
      mergeInto(target, over);
    });
    expect(target.tags).toEqual(over.tags);
    expect(copied).toBe(0);
  });
});
