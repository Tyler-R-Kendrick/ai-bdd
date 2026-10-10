import type { DocDirectives, JsonValue } from '../contracts/index.ts';

/** Spec 3.2: the recognised directive keys. */
export const FLAG_KEYS = ['ignore', 'context', 'fuzzy'] as const;
export const VALUE_KEYS = ['driver', 'start', 'tags'] as const;
const KNOWN_KEYS: readonly string[] = [...FLAG_KEYS, ...VALUE_KEYS];

/** Mutable directive scope. `false` means "explicitly off", which overrides an outer `true`. */
export interface DirectiveSet {
  ignore?: boolean;
  context?: boolean;
  fuzzy?: boolean;
  driver?: string;
  start?: string;
  tags: string[];
}

export function emptyDirectiveSet(): DirectiveSet {
  return { tags: [] };
}

export type DirectiveReport = (code: 'DIRECTIVE_INVALID' | 'DIRECTIVE_UNKNOWN_KEY', message: string, details?: JsonValue) => void;

// ───────────────────────── comment extraction

export interface CommentBody {
  /** Text between `<!--` and `-->` (or to the end of the node when unterminated). */
  body: string;
  terminated: boolean;
}

/** All HTML comments inside an html node value. Linear time, no backtracking. */
export function findComments(html: string): CommentBody[] {
  const out: CommentBody[] = [];
  let pos = 0;
  for (;;) {
    const open = html.indexOf('<!--', pos);
    if (open === -1) break;
    const close = html.indexOf('-->', open + 4);
    if (close === -1) {
      out.push({ body: html.slice(open + 4), terminated: false });
      break;
    }
    out.push({ body: html.slice(open + 4, close), terminated: true });
    pos = close + 3;
  }
  return out;
}

/** Returns the text after `ai-bdd:` when the comment body is a directive, else null. */
export function directiveBody(commentBody: string): string | null {
  const trimmed = commentBody.trimStart();
  if (!trimmed.startsWith('ai-bdd')) return null;
  const rest = trimmed.slice('ai-bdd'.length).trimStart();
  if (!rest.startsWith(':')) return null;
  return rest.slice(1);
}

// ───────────────────────── tokenizer for `key=value key2="v w" flag`

export interface RawEntry {
  key: string;
  /** `true` for a bare flag. */
  value: string | true;
}

const MAX_BODY = 4096;

function isWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function isKeyChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;
}

function excerpt(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}...` : s;
}

export function tokenizeDirective(body: string): { entries: RawEntry[]; errors: string[] } {
  const entries: RawEntry[] = [];
  const errors: string[] = [];
  if (body.length > MAX_BODY) {
    errors.push(`directive is longer than ${MAX_BODY} characters`);
    return { entries, errors };
  }
  const n = body.length;
  let i = 0;
  while (i < n) {
    while (i < n && isWs(body[i])) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && isKeyChar(body[i])) i++;
    if (i === start) {
      while (i < n && !isWs(body[i])) i++;
      errors.push(`unexpected token ${JSON.stringify(excerpt(body.slice(start, i)))}`);
      continue;
    }
    const key = body.slice(start, i);
    if (body[i] === '=') {
      i++;
      if (i >= n || isWs(body[i])) {
        errors.push(`key "${key}" has an empty value`);
        continue;
      }
      const q = body[i];
      if (q === '"' || q === "'") {
        i++;
        let value = '';
        let closed = false;
        while (i < n) {
          const c = body[i] as string;
          if (c === '\\' && (body[i + 1] === q || body[i + 1] === '\\')) {
            value += body[i + 1];
            i += 2;
            continue;
          }
          if (c === q) {
            closed = true;
            i++;
            break;
          }
          value += c;
          i++;
        }
        if (!closed) {
          errors.push(`unterminated quoted value for key "${key}"`);
          break;
        }
        if (i < n && !isWs(body[i])) {
          const s = i;
          while (i < n && !isWs(body[i])) i++;
          errors.push(`unexpected characters ${JSON.stringify(excerpt(body.slice(s, i)))} after quoted value of "${key}"`);
          continue;
        }
        entries.push({ key, value });
      } else {
        const s = i;
        while (i < n && !isWs(body[i])) i++;
        entries.push({ key, value: body.slice(s, i) });
      }
    } else if (i < n && !isWs(body[i])) {
      const s = start;
      while (i < n && !isWs(body[i])) i++;
      errors.push(`unexpected token ${JSON.stringify(excerpt(body.slice(s, i)))}`);
    } else {
      entries.push({ key, value: true });
    }
  }
  return { entries, errors };
}

// ───────────────────────── interpretation

const DRIVER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function addTag(set: DirectiveSet, raw: string, report: DirectiveReport): void {
  const tag = raw.trim().replace(/^@/, '');
  if (tag === '') return;
  if (!TAG_RE.test(tag)) {
    report('DIRECTIVE_INVALID', `invalid tag ${JSON.stringify(excerpt(raw.trim()))}`, { key: 'tags' });
    return;
  }
  if (!set.tags.includes(tag)) set.tags.push(tag);
}

/**
 * Apply one `key` / `value` pair to a scope. `value` is `true` for a bare flag, a string from a comment,
 * or any YAML value from frontmatter. Problems are reported, never thrown.
 */
export function applyDirectiveEntry(set: DirectiveSet, key: string, value: unknown, report: DirectiveReport): void {
  if (!KNOWN_KEYS.includes(key)) {
    report('DIRECTIVE_UNKNOWN_KEY', `unknown directive key "${excerpt(key)}" (ignored)`, { key });
    return;
  }
  if (key === 'ignore' || key === 'context' || key === 'fuzzy') {
    let flag: boolean | undefined;
    if (value === true || value === false) flag = value;
    else if (typeof value === 'string') {
      const v = value.toLowerCase();
      if (v === 'true') flag = true;
      else if (v === 'false') flag = false;
    }
    if (flag === undefined) {
      report('DIRECTIVE_INVALID', `"${key}" is a flag; expected no value, true or false`, { key });
      return;
    }
    set[key] = flag;
    return;
  }
  if (key === 'driver') {
    if (typeof value !== 'string' || !DRIVER_RE.test(value)) {
      report('DIRECTIVE_INVALID', '"driver" requires a driver name (letters, digits, ".", "_", "-")', { key });
      return;
    }
    set.driver = value;
    return;
  }
  if (key === 'start') {
    if (typeof value !== 'string' || value.trim() === '' || value.length > 2048 || CONTROL_RE.test(value)) {
      report('DIRECTIVE_INVALID', '"start" requires a non-empty path or URL', { key });
      return;
    }
    set.start = value.trim();
    return;
  }
  // tags
  if (typeof value === 'string') {
    const parts = value.split(',');
    if (parts.every((p) => p.trim() === '')) {
      report('DIRECTIVE_INVALID', '"tags" requires a comma separated list', { key });
      return;
    }
    for (const part of parts) addTag(set, part, report);
    return;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    for (const part of value as string[]) addTag(set, part, report);
    return;
  }
  report('DIRECTIVE_INVALID', '"tags" requires a comma separated list', { key });
}

/** Parse the text after `ai-bdd:` into a scope. At least one diagnostic is reported for an empty directive. */
export function parseDirectiveText(text: string, report: DirectiveReport): DirectiveSet {
  const set = emptyDirectiveSet();
  const { entries, errors } = tokenizeDirective(text);
  for (const e of errors) report('DIRECTIVE_INVALID', e);
  for (const e of entries) applyDirectiveEntry(set, e.key, e.value, report);
  if (entries.length === 0 && errors.length === 0) report('DIRECTIVE_INVALID', 'empty directive');
  return set;
}

/** Interpret the frontmatter `ai-bdd:` value, a mapping with the same keys. */
export function parseFrontmatterDirectives(value: JsonValue, report: DirectiveReport): DirectiveSet {
  const set = emptyDirectiveSet();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    report('DIRECTIVE_INVALID', 'frontmatter "ai-bdd" must be a mapping of directive keys');
    return set;
  }
  for (const [k, v] of Object.entries(value)) applyDirectiveEntry(set, k, v, report);
  return set;
}

// ───────────────────────── merging

/** Merge `over` into `target` in place: scalar keys override, tags union. */
export function mergeInto(target: DirectiveSet, over: DirectiveSet): void {
  if (over.ignore !== undefined) target.ignore = over.ignore;
  if (over.context !== undefined) target.context = over.context;
  if (over.fuzzy !== undefined) target.fuzzy = over.fuzzy;
  if (over.driver !== undefined) target.driver = over.driver;
  if (over.start !== undefined) target.start = over.start;
  for (const t of over.tags) if (!target.tags.includes(t)) target.tags.push(t);
}

/** Effective directives of a chunk: outermost scope first. Explicit `false` values are dropped. */
export function resolveDirectives(scopes: readonly DirectiveSet[]): DocDirectives {
  const acc = emptyDirectiveSet();
  for (const s of scopes) mergeInto(acc, s);
  const out: DocDirectives = {};
  if (acc.ignore === true) out.ignore = true;
  if (acc.context === true) out.context = true;
  if (acc.fuzzy === true) out.fuzzy = true;
  if (acc.driver !== undefined) out.driver = acc.driver;
  if (acc.start !== undefined) out.start = acc.start;
  if (acc.tags.length > 0) out.tags = [...acc.tags];
  return out;
}
