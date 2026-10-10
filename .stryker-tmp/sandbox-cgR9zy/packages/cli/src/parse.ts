// @ts-nocheck
import { AiBddError, type ReporterName } from '@ai-bdd/sdk/contracts';

export const REPORTER_NAMES: readonly ReporterName[] = ['json', 'junit', 'markdown'];

/** CI detection as in §5.2: `CI` is `true` or `1`. */
export function isCiEnv(env: Record<string, string | undefined>): boolean {
  const v = env['CI']?.trim().toLowerCase();
  return v === 'true' || v === '1';
}

/** Splits comma-separated values and flattens repeats: `['a,b', 'c']` becomes `['a','b','c']`. */
export function splitList(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const out: string[] = [];
  for (const v of values) {
    for (const part of v.split(',')) {
      const t = part.trim();
      if (t !== '' && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

export function parseReporters(values: readonly string[] | undefined): ReporterName[] {
  const names = splitList(values);
  for (const n of names) {
    if (!(REPORTER_NAMES as readonly string[]).includes(n)) {
      throw new AiBddError('USAGE', `Unknown reporter "${n}". Expected one of: ${REPORTER_NAMES.join(', ')}.`);
    }
  }
  return names as ReporterName[];
}

export function parseWorkers(value: string): number {
  if (!/^[1-9]\d*$/.test(value.trim())) throw new AiBddError('USAGE', `--workers expects a positive integer, got "${value}".`);
  return Number.parseInt(value, 10);
}
