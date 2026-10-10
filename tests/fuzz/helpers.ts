import fc from 'fast-check';

/**
 * Shared infrastructure of the fuzz suite (`pnpm test:fuzz`).
 *
 *  - `FC_RUNS`  number of cases per property (default 300). `scale` shrinks it for expensive properties (never below 25).
 *  - `FC_SEED`  replays a failing run. Without it fast-check picks a random seed and prints it, together with the shrunk
 *               counterexample and its replay path, when a property fails.
 */

const DEFAULT_RUNS = 300;

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

const SEED = envInt('FC_SEED');
if (SEED !== undefined) console.info(`[fuzz] FC_SEED=${SEED}: replaying with a fixed seed`);

export function runCount(scale = 1): number {
  const base = envInt('FC_RUNS') ?? DEFAULT_RUNS;
  return Math.max(Math.min(base, 25), Math.round(base * scale));
}

/** fast-check parameters for `fc.assert(..., params())`. */
export function params<T = unknown>(opts: { scale?: number; maxSkips?: number } = {}): fc.Parameters<T> {
  return {
    numRuns: runCount(opts.scale ?? 1),
    ...(SEED === undefined ? {} : { seed: SEED }),
    maxSkipsPerRun: opts.maxSkips ?? 100,
  };
}

/** CPU time (user + system, ms) a synchronous call consumes: unaffected by a busy machine, unlike the wall clock. */
export function cpuMs(fn: () => void): number {
  const before = process.cpuUsage();
  fn();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}

// ───────────────────────── hostile strings

/** Property names that break naive `obj[key]` code. */
export const PROTO_KEYS = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf', '__defineGetter__', 'isPrototypeOf'] as const;

const NASTY_TOKENS: readonly string[] = [
  '\0', '\u0001', '\u001f', '\u007f', '\u0085', '\u00a0', '\u00ad', '\u200b', '\u200c', '\u200d', '\u2060', '\u2028', '\u2029', '\ufeff', '\ufffd', '\ufff9',
  '\u202e', '\u202d', '\u2066', '\u2069', '\u061c', 'שלום', 'مرحبا',
  '\ud800', '\udc00', '\udbff', '\udfff', '\ud83d', '\ude00',
  '😀', '👨\u200d👩\u200d👧\u200d👦', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢', '\u{10ffff}', 'e\u0301', '\u00e9', 'ﬁ', 'ǅ', 'İ', 'ß', 'Σ', '日本語', 'ｆｕｌｌｗｉｄｔｈ',
  '\u001b[31m', '\u001b[0m', '\u001b[2J', '\u001b]0;title\u0007', '\u009b31m', '\u001b[?25l',
  '\r\n', '\r', '\n', '\t', ' ', '  ', '\n\n', '\v', '\f',
  '../', '..\\', '../../etc/passwd', '..%2f', '%2e%2e%2f', '%00', '/', '\\', 'C:\\', '~', '//',
  '.*', '.*+?^${}()|[]\\', '(a+)+$', '(?<x>', '[a-', '\\p{L}', '$&', '$1', '$`',
  '<!-- ai-bdd: ignore -->', '<!-- ai-bdd: context -->', '<!-- ai-bdd:', '<!--', '-->', '<script>alert(1)</script>', '<b>', '&amp;', '&#x0;', '&#xD800;',
  '```', '~~~', '    ', '> ', '>>>', '# ', '###### ', '- ', '* ', '+ ', '1. ', '1) ', '---', '***', '___', '| a | b |', '|---|---|', ':---:',
  '[', ']', '](', '[x](y)', '![', '[^1]', '**', '__', '*', '_', '~~', '`', '``', '\\', '<', '>', '&', '"', "'", '{', '}', '{{', '}}', '${', '%s', '%n',
  ...PROTO_KEYS, '__proto__.polluted', 'constructor.prototype',
  'true', 'false', 'null', 'NaN', 'Infinity', '-0', '1e999', '0x10', 'undefined',
  'http://', 'https://evil.example/', '@', ':', ';', '=', '?', '#',
];

const nastyToken = fc.constantFrom(...NASTY_TOKENS);

const ordinaryText = fc.oneof(
  fc.string({ unit: 'grapheme', maxLength: 12 }),
  fc.string({ unit: 'binary', maxLength: 8 }),
  fc.stringMatching(/^[A-Za-z0-9 ]{0,12}$/),
);

/** A long run of one token (delimiter bombs, whitespace walls, nested openers). */
const runOf = fc
  .tuple(fc.constantFrom('*', '_', '[', ']', '(', ')', '~', '`', '<', '>', '-', '#', '|', ' ', '\t', '\n', 'a', 'é', '😀', '\\', '"', '&', '*a', '[a](b ', '> ', '- ', '  - ', '1. '), fc.integer({ min: 2, max: 400 }))
  .map(([token, n]) => token.repeat(n));

/**
 * Unicode- and syntax-hostile text: astral planes, lone surrogates, RTL and bidi controls, zero-width characters, NUL, ANSI escapes,
 * line-terminator variants, very long runs, markdown/HTML delimiter bombs, regex metacharacters, path traversal and
 * prototype-pollution keys. Bounded (`maxLength` units, default 1500) so properties stay fast.
 */
export function hostileString(opts: { maxLength?: number } = {}): fc.Arbitrary<string> {
  const max = opts.maxLength ?? 1500;
  return fc
    .array(fc.oneof({ weight: 5, arbitrary: nastyToken }, { weight: 4, arbitrary: ordinaryText }, { weight: 1, arbitrary: runOf }), { maxLength: 40 })
    .map((parts) => parts.join(''))
    .map((s) => (s.length > max ? s.slice(0, max) : s));
}

/** Short hostile identifiers (names, keys, hostnames). */
export const hostileKey: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...PROTO_KEYS, '', ' ', '0', '-1', '1e3', 'a.b', 'a/b', '$ref', '\0', '\u202e', '😀', '__proto__ ', ' constructor') },
  { weight: 2, arbitrary: hostileString({ maxLength: 20 }) },
  { weight: 3, arbitrary: fc.stringMatching(/^[a-z]{1,6}$/) },
);

// ───────────────────────── JSON

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** A finite double that survives a JSON round trip (no NaN/Infinity, no -0). */
export const jsonNumber: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }),
  fc.double({ noNaN: true, noDefaultInfinity: true }).map((n) => (Object.is(n, -0) ? 0 : n)),
  fc.constantFrom(0, 1, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.MAX_VALUE, Number.MIN_VALUE, 1e21, 1e-7, 0.1 + 0.2),
);

/**
 * Deep JSON values with hostile keys. Objects are built with `Object.fromEntries`, so an own `__proto__` key is a real own property
 * (as `JSON.parse` would produce it), not a prototype assignment.
 */
export function jsonValue(opts: { maxDepth?: number; maxKeys?: number; protoKeys?: boolean } = {}): fc.Arbitrary<Json> {
  const maxDepth = opts.maxDepth ?? 4;
  const maxKeys = opts.maxKeys ?? 5;
  const { value } = fc.letrec<{ value: Json; array: Json[]; object: { [k: string]: Json } }>((tie) => ({
    value: fc.oneof(
      { maxDepth, depthSize: 'small' },
      fc.constant(null),
      fc.boolean(),
      jsonNumber,
      hostileString({ maxLength: 40 }),
      tie('array'),
      tie('object'),
    ),
    array: fc.array(tie('value'), { maxLength: maxKeys }),
    object: fc.array(fc.tuple(opts.protoKeys === false ? hostileKey.filter((k) => k !== '__proto__') : hostileKey, tie('value')), { maxLength: maxKeys }).map((entries) => Object.fromEntries(entries) as { [k: string]: Json }),
  }));
  return value;
}

/** Deep structural equality for JSON values that, unlike `toEqual`, treats own `__proto__` keys as plain keys. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return Object.is(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Throws when `Object.prototype` was modified. Call after exercising code that handles untrusted keys. */
export function assertPrototypeClean(): void {
  const proto = Object.prototype as Record<string, unknown>;
  const own = Object.getOwnPropertyNames(proto).sort();
  if (own.join(',') !== PRISTINE_OBJECT_PROTO.join(',')) throw new Error(`Object.prototype was polluted: ${own.filter((k) => !PRISTINE_OBJECT_PROTO.includes(k)).join(', ')}`);
  if (({} as Record<string, unknown>)['polluted'] !== undefined || proto['polluted'] !== undefined) throw new Error('Object.prototype.polluted is set');
}
const PRISTINE_OBJECT_PROTO = Object.getOwnPropertyNames(Object.prototype).sort();

// ───────────────────────── markdown

export type LineEnding = '\n' | '\r\n' | '\r';

export function withLineEnding(text: string, eol: LineEnding): string {
  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

/** Text without carriage returns, so that rewriting `\n` to `\r\n`/`\r` is a faithful transformation. */
const noCr = (s: string): string => s.replace(/\r/g, '');

const word = fc.stringMatching(/^[a-z]{2,9}$/);
const sentence = fc.array(word, { minLength: 1, maxLength: 8 }).map((w) => w.join(' '));
const inlineText = fc.oneof({ weight: 5, arbitrary: sentence }, { weight: 2, arbitrary: hostileString({ maxLength: 60 }).map((s) => noCr(s).replace(/\n/g, ' ')) });
const blockText = fc.oneof({ weight: 3, arbitrary: sentence }, { weight: 2, arbitrary: hostileString({ maxLength: 120 }).map(noCr) });

const directiveArb = fc.oneof(
  fc.constantFrom(
    '<!-- ai-bdd: ignore -->', '<!-- ai-bdd: context -->', '<!-- ai-bdd: fuzzy -->', '<!-- ai-bdd: ignore=false -->', '<!-- ai-bdd: tags=a,b driver=web -->',
    '<!-- ai-bdd: start="/x y" -->', '<!-- ai-bdd: bogus=1 -->', '<!-- ai-bdd: tags= -->', '<!-- ai-bdd: -->', '<!-- ai-bdd', '<!-- ai-bdd: fuzzy tags="unterminated -->',
    '<!-- not a directive -->', '<!-- ai-bdd: __proto__=1 constructor=2 -->', '<!--ai-bdd:ignore-->', '<!-- AI-BDD: ignore -->',
  ),
  fc.tuple(fc.constantFrom('ignore', 'context', 'fuzzy', 'driver', 'start', 'tags', 'x', '__proto__'), hostileString({ maxLength: 20 })).map(([k, v]) => `<!-- ai-bdd: ${k}=${noCr(v).replace(/-->/g, '')} -->`),
);

const frontmatterArb = fc.constantFrom(
  '',
  '',
  '---\ntitle: x\n---\n',
  '---\nai-bdd:\n  tags: [a, b]\n  ignore: false\n  context: true\n---\n',
  '---\nai-bdd: {fuzzy: true, driver: web, start: "/p"}\n---\n',
  '---\n: bad\n  - [\n---\n',
  '---\n__proto__: {polluted: yes}\nconstructor: {prototype: {polluted: yes}}\n---\n',
  '---\nai-bdd:\n  __proto__: {polluted: 1}\n  tags: [__proto__]\n---\n',
  '---\n&a [*a]\n---\n',
  '---\nai-bdd: 5\n---\n',
  '---\n---\n',
  '---\nunterminated: true\n',
  '---\r\ntitle: crlf\r\n---\r\n',
);

function listBlock(depth: number, items: string[]): string {
  const markers = ['- ', '* ', '+ ', '1. ', '2) '];
  return items.map((it, i) => `${'  '.repeat(depth)}${markers[i % markers.length]}${it}`).join('\n');
}

const blockArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.tuple(fc.integer({ min: 1, max: 6 }), inlineText).map(([n, t]) => `${'#'.repeat(n)} ${t}`) },
  { weight: 4, arbitrary: fc.array(blockText, { minLength: 1, maxLength: 3 }).map((l) => l.join('\n')) },
  { weight: 3, arbitrary: fc.tuple(fc.integer({ min: 0, max: 3 }), fc.array(inlineText, { minLength: 1, maxLength: 5 })).map(([d, items]) => listBlock(d, items)) },
  { weight: 2, arbitrary: fc.array(inlineText, { minLength: 1, maxLength: 4 }).map((l) => `${listBlock(0, [l[0] as string])}\n${listBlock(1, l.slice(1))}`) },
  { weight: 2, arbitrary: fc.tuple(fc.array(inlineText.map((t) => t.replace(/\|/g, '/')), { minLength: 1, maxLength: 3 }), fc.array(fc.array(inlineText.map((t) => t.replace(/\|/g, '/')), { minLength: 0, maxLength: 4 }), { maxLength: 4 })).map(([head, rows]) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')) },
  { weight: 2, arbitrary: fc.tuple(fc.constantFrom('```', '~~~', '````', '```js'), blockText, fc.boolean()).map(([fence, body, close]) => `${fence}\n${body}\n${close ? fence.replace(/\w+$/, '') : ''}`) },
  { weight: 2, arbitrary: fc.array(blockText, { minLength: 1, maxLength: 3 }).map((l) => l.map((x) => x.split('\n').map((line) => `> ${line}`).join('\n')).join('\n>\n')) },
  { weight: 2, arbitrary: directiveArb },
  { weight: 1, arbitrary: fc.constantFrom('<div>\nhtml block\n</div>', '<details><summary>s</summary>\n\nbody\n\n</details>', '---', '***', '[ref]: http://example.com "t"', '[^1]: note', '<br/>', '    indented code', '\ttabbed code') },
  { weight: 1, arbitrary: runOf.map((r) => noCr(r)) },
);

/**
 * Markdown documents (LF line endings): headings, nested lists, tables, code fences (some unterminated), block quotes, raw html,
 * `<!-- ai-bdd: ... -->` directives (valid, malformed and unknown), YAML frontmatter (valid, invalid, hostile keys), optional BOM.
 * Use `withLineEnding` for CRLF/CR variants; for arbitrary byte-level garbage combine with `hostileString`.
 */
export function markdownDoc(opts: { maxBlocks?: number; bom?: boolean } = {}): fc.Arbitrary<string> {
  return fc
    .tuple(frontmatterArb, fc.array(blockArb, { maxLength: opts.maxBlocks ?? 14 }), fc.boolean())
    .map(([fm, blocks, trailingNewline]) => {
      const body = noCr(fm) + blocks.join('\n\n') + (trailingNewline ? '\n' : '');
      return opts.bom === true ? `\ufeff${body}` : body;
    });
}

/** Any text a markdown reader may be handed: structured documents, raw hostile strings, binary garbage, mixed line endings. */
export function anyDocText(opts: { maxLength?: number } = {}): fc.Arbitrary<string> {
  return fc.oneof(
    { weight: 4, arbitrary: markdownDoc() },
    { weight: 3, arbitrary: hostileString({ maxLength: opts.maxLength ?? 1500 }) },
    { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 400 }) },
    { weight: 2, arbitrary: fc.tuple(markdownDoc(), fc.constantFrom<LineEnding>('\n', '\r\n', '\r'), fc.boolean()).map(([d, eol, bom]) => (bom ? '\ufeff' : '') + withLineEnding(d, eol)) },
  );
}
