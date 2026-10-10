/**
 * Scrubbers make output that varies between runs (ids, times, paths, ports) stable before it is compared. They run in order on the
 * serialized text. A scrubber that replaces distinct values gives each distinct value its own counter (`Guid_1`, `Guid_2`), so a
 * snapshot still shows which occurrences were the same value.
 */
export type Scrubber = (text: string) => string;

/** Replace every match with `<label>_<n>` where n numbers distinct matches (compared through `key`) in order of first appearance. */
export function counted(pattern: RegExp, label: string, key: (match: string) => string = (m) => m): Scrubber {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return (text) => {
    const seen = new Map<string, number>();
    return text.replace(new RegExp(pattern.source, flags), (m) => {
      const k = key(m);
      let n = seen.get(k);
      if (n === undefined) {
        n = seen.size + 1;
        seen.set(k, n);
      }
      return `${label}_${n}`;
    });
  };
}

/** Replace every match with a fixed string. */
export function replace(pattern: RegExp, replacement: string): Scrubber {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return (text) => text.replace(new RegExp(pattern.source, flags), replacement);
}

const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/g;
const SHA256 = /\b[0-9a-f]{64}\b/g;
const DURATION_MS = /\b\d+(?:\.\d+)?ms\b/g;
const LOCAL_PORT = /(?<=(?:localhost|127\.0\.0\.1|\[::1\]):)\d{2,5}\b/g;

/** UUIDs (including v7 ids): `Guid_1`, `Guid_2`, ... */
// Stryker disable next-line MethodExpression: equivalent mutant, the key only decides which matches are equal, and upper case compares the same way as lower case for hex digits and hyphens
export const guids = (): Scrubber => counted(GUID, 'Guid', (m) => m.toLowerCase());
/** ISO-8601 instants: `Instant_1`, ... */
export const instants = (): Scrubber => counted(ISO_INSTANT, 'Instant');
/** Hex sha256 digests: `Sha256_1`, ... (use when the digest is incidental, not the thing under test). */
// Stryker disable next-line MethodExpression: equivalent mutant, the key only decides which matches are equal, and upper case compares the same way as lower case for hex digits
export const digests = (): Scrubber => counted(SHA256, 'Sha256', (m) => m.toLowerCase());
/** Durations such as `123ms`. */
export const durations = (): Scrubber => replace(DURATION_MS, '{duration}');
/** The port of a loopback URL. */
export const ports = (): Scrubber => replace(LOCAL_PORT, '{port}');

/** Absolute directories become stable placeholders (`{root}`, `{tmp}`); longest prefix first, POSIX and Windows separators. */
export function paths(dirs: Record<string, string>): Scrubber {
  const entries = Object.entries(dirs)
    .filter(([, dir]) => dir.length > 0)
    .sort(([, a], [, b]) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const [label, dir] of entries) {
      for (const variant of new Set([dir, dir.replace(/\\/g, '/'), dir.replace(/\//g, '\\'), JSON.stringify(dir).slice(1, -1)])) {
        out = out.split(variant).join(`{${label}}`);
      }
    }
    return out;
  };
}

/** Line endings to `\n`, trailing whitespace on each line removed, exactly one final newline. */
export function normalizeText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent mutants, with no lines left lines[-1] is undefined and never equals "", so the loop ends there anyway
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

/** The scrubbers applied unless `scrubDefaults: false`. */
export function defaultScrubbers(dirs: Record<string, string> = {}): Scrubber[] {
  return [paths(dirs), guids(), instants()];
}

export function applyScrubbers(text: string, scrubbers: readonly Scrubber[]): string {
  return scrubbers.reduce((acc, s) => s(acc), text);
}
