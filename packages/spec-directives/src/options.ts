/**
 * Directive value coercion (section 7.3).
 *
 * The directive grammar is a whitespace (or comma) separated list of
 * `key=value` assignments. A value may be double quoted to embed spaces and
 * the escapes `\"` and `\\`.
 */
import type {
  AssertionMode,
  Diagnostic,
  DirectiveKey,
  ResolveMode,
  SourceLocation,
  StepKind,
  StepOptions,
} from '@ai-bdd/contracts';

export interface Assignment {
  key: string;
  value: string;
  /** True when the value was written as a double-quoted string. */
  quoted: boolean;
}

export type CoerceResult =
  | { ok: true; key: DirectiveKey; value: StepOptions[DirectiveKey] }
  | { ok: false; diagnostic: Diagnostic };

const KINDS: readonly StepKind[] = ['setup', 'action', 'assertion'];
const MODES: readonly AssertionMode[] = ['auto', 'check', 'judge', 'both'];
const RESOLVE_MODES: readonly ResolveMode[] = ['auto', 'exact', 'semantic', 'agent'];

/** Keys that only carry meaning for assertion steps (section 8.3, R-K9). */
export const ASSERTION_ONLY_KEYS: readonly DirectiveKey[] = [
  'mode',
  'threshold',
  'failThreshold',
  'samples',
  'vision',
  'invariant',
];

function error(code: string, message: string, loc?: SourceLocation): Diagnostic {
  return loc === undefined
    ? { code, severity: 'error', message }
    : { code, severity: 'error', message, location: loc };
}

function invalid(key: string, value: string, loc?: SourceLocation): CoerceResult {
  return {
    ok: false,
    diagnostic: error('DIRECTIVE_INVALID_VALUE', `Invalid value "${value}" for directive "${key}".`, loc),
  };
}

function unknown(key: string, loc?: SourceLocation): CoerceResult {
  return {
    ok: false,
    diagnostic: error('DIRECTIVE_UNKNOWN_KEY', `Unknown directive key "${key}".`, loc),
  };
}

function parseDecimal(raw: string): number | undefined {
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function parseInteger(raw: string): number | undefined {
  if (!/^-?\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function parseBoolean(raw: string): boolean | undefined {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

function parseOnOff(raw: string): boolean | undefined {
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  return undefined;
}


/**
 * Coerce a single `key=value` assignment. Unknown keys and invalid values are
 * returned as diagnostics, never thrown.
 */
export function coerceDirective(key: string, raw: string, loc?: SourceLocation): CoerceResult {
  const value = raw.trim();
  switch (key) {
    case 'kind': {
      const match = KINDS.find((candidate) => candidate === value);
      return match === undefined ? invalid(key, raw, loc) : { ok: true, key, value: match };
    }
    case 'mode': {
      const match = MODES.find((candidate) => candidate === value);
      return match === undefined ? invalid(key, raw, loc) : { ok: true, key, value: match };
    }
    case 'resolve': {
      const match = RESOLVE_MODES.find((candidate) => candidate === value);
      return match === undefined ? invalid(key, raw, loc) : { ok: true, key, value: match };
    }
    case 'threshold': {
      const parsed = parseDecimal(value);
      if (parsed === undefined || parsed < 0 || parsed > 1) return invalid(key, raw, loc);
      return { ok: true, key, value: parsed };
    }
    case 'failThreshold': {
      const parsed = parseDecimal(value);
      if (parsed === undefined || parsed < 0 || parsed > 1) return invalid(key, raw, loc);
      return { ok: true, key, value: parsed };
    }
    case 'samples': {
      const parsed = parseInteger(value);
      if (parsed === undefined || parsed < 1 || parsed > 9) return invalid(key, raw, loc);
      return { ok: true, key, value: parsed };
    }
    case 'vision': {
      const parsed = parseOnOff(value);
      return parsed === undefined ? invalid(key, raw, loc) : { ok: true, key, value: parsed };
    }
    case 'invariant': {
      const parsed = parseBoolean(value);
      return parsed === undefined ? invalid(key, raw, loc) : { ok: true, key, value: parsed };
    }
    case 'timeout': {
      const parsed = parseInteger(value);
      if (parsed === undefined || parsed < 1) return invalid(key, raw, loc);
      return { ok: true, key, value: parsed };
    }
    case 'driver': {
      if (value.length === 0) return invalid(key, raw, loc);
      return { ok: true, key, value };
    }
    default:
      return unknown(key, loc);
  }
}

/** Write a coerced value onto a `Partial<StepOptions>` accumulator. */
export function assignOption(out: Partial<StepOptions>, key: DirectiveKey, value: StepOptions[DirectiveKey]): void {
  switch (key) {
    case 'kind':
      out.kind = value as StepKind;
      break;
    case 'mode':
      out.mode = value as AssertionMode;
      break;
    case 'resolve':
      out.resolve = value as ResolveMode;
      break;
    case 'threshold':
      out.threshold = value as number;
      break;
    case 'failThreshold':
      out.failThreshold = value as number;
      break;
    case 'samples':
      out.samples = value as number;
      break;
    case 'vision':
      out.vision = value as boolean;
      break;
    case 'invariant':


      out.invariant = value as boolean;
      break;
    case 'timeout':
      out.timeout = value as number;
      break;
    case 'driver':
      out.driver = value as string;
      break;
  }
}

/**
 * Parse the assignment list that follows the `ai-bdd:` marker.
 * Syntactically broken assignments produce a DIRECTIVE_INVALID_VALUE diagnostic
 * and are skipped.
 */
export function parseAssignmentList(
  text: string,
  loc?: SourceLocation,
): { entries: Assignment[]; diagnostics: Diagnostic[] } {
  const entries: Assignment[] = [];
  const diagnostics: Diagnostic[] = [];
  let i = 0;
  const isSeparator = (ch: string | undefined): boolean => ch === undefined || /\s|,/u.test(ch);

  while (i < text.length) {
    while (i < text.length && isSeparator(text[i])) i += 1;
    if (i >= text.length) break;

    const start = i;
    let key = '';
    while (i < text.length && text[i] !== '=' && !isSeparator(text[i])) {
      key += text[i];
      i += 1;
    }
    if (text[i] !== '=') {
      while (i < text.length && !isSeparator(text[i])) i += 1;
      diagnostics.push(
        error('DIRECTIVE_INVALID_VALUE', `Malformed directive assignment "${text.slice(start, i)}".`, loc),
      );
      continue;
    }
    i += 1; // consume '='

    let value = '';
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      i += 1;
      let closed = false;
      while (i < text.length) {
        const ch = text[i];
        if (ch === '\\' && i + 1 < text.length) {
          const next = text[i + 1];
          if (next === '"' || next === '\\') {
            value += next;
            i += 2;
            continue;
          }
          value += ch;
          i += 1;
          continue;
        }
        if (ch === '"') {
          closed = true;
          i += 1;
          break;
        }
        value += ch;
        i += 1;
      }
      if (!closed) {
        diagnostics.push(error('DIRECTIVE_INVALID_VALUE', `Unterminated quoted value for "${key}".`, loc));
      }
    } else {
      while (i < text.length && !isSeparator(text[i])) {
        value += text[i];
        i += 1;
      }
    }
    entries.push({ key, value, quoted });
  }
  return { entries, diagnostics };
}
