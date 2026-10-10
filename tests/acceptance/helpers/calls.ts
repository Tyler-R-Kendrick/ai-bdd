import { existsSync, readFileSync } from 'node:fs';
import type { ModelPurpose } from '@ai-bdd/sdk/contracts';

/** Loose view of a fake-model call (the in-memory `calls` array and the JSONL log use the same shape). */
export interface CallRecord {
  purpose?: string;
  request?: { purpose?: string; system?: string; messages?: unknown[]; context?: Record<string, unknown> };
  response?: Record<string, unknown>;
  ruleId?: string;
  [key: string]: unknown;
}

export const PURPOSES: readonly ModelPurpose[] = ['extract', 'act', 'checkgen', 'judge'];

export function purposeOf(call: CallRecord): string {
  return call.purpose ?? call.request?.purpose ?? 'unknown';
}

export function ofPurpose(calls: readonly CallRecord[], purpose: ModelPurpose): CallRecord[] {
  return calls.filter((c) => purposeOf(c) === purpose);
}

export function countByPurpose(calls: readonly CallRecord[]): Record<ModelPurpose, number> {
  return {
    extract: ofPurpose(calls, 'extract').length,
    act: ofPurpose(calls, 'act').length,
    checkgen: ofPurpose(calls, 'checkgen').length,
    judge: ofPurpose(calls, 'judge').length,
  };
}

export function callText(call: CallRecord): string {
  return JSON.stringify(call);
}

/** Calls whose context field `key` equals `value` (e.g. stepText). */
export function withContext(calls: readonly CallRecord[], key: string, value: string): CallRecord[] {
  return calls.filter((c) => String(c.request?.context?.[key] ?? '') === value);
}

/** Read the JSONL call log the fake models append to (`logPath` option) in spawned CLI processes. */
export function readFakeLog(path: string): CallRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as CallRecord);
}
