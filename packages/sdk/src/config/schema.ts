import { z } from 'zod';
import type { ChatModel, DriverFactory, FixtureDefinition, ModelSet, Verb } from '../contracts/index.ts';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFn = (v: unknown): boolean => typeof v === 'function';

export const VERBS: readonly Verb[] = ['navigate', 'click', 'fill', 'press', 'select', 'check', 'hover', 'scroll', 'back', 'wait'];
export const PURPOSES = ['extract', 'act', 'checkgen', 'judge'] as const;

const posInt = z.number().int().positive();
const nonNegInt = z.number().int().min(0);
const nonEmpty = z.string().min(1);

const isChatModel = (v: unknown): v is ChatModel => isRecord(v) && typeof v['id'] === 'string' && isFn(v['generate']);

const driverFactory = z.custom<DriverFactory>(
  (v) => isRecord(v) && typeof v['id'] === 'string' && isFn(v['create']),
  { message: 'expected a DriverFactory ({ id, create })' },
);

const modelSet = z.custom<ModelSet>(
  (v) => isRecord(v) && PURPOSES.every((p) => isChatModel(v[p])),
  { message: 'expected a ModelSet with ChatModel entries for extract, act, checkgen and judge' },
);

const fixtureDefinition = z.custom<FixtureDefinition>(
  (v) =>
    isRecord(v) &&
    typeof v['name'] === 'string' &&
    v['name'].length > 0 &&
    typeof v['description'] === 'string' &&
    isRecord(v['params']) &&
    isFn(v['run']),
  { message: 'expected a FixtureDefinition ({ name, description, params, run })' },
);

const baseURL = z.string().refine(
  (s) => {
    try {
      const u = new URL(s);
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.username === '' && u.password === '';
    } catch {
      return false;
    }
  },
  { message: 'expected an absolute http(s) URL without credentials' },
);

const price = z.strictObject({ inputPerMTok: z.number().min(0), outputPerMTok: z.number().min(0) });

/** Strict zod schema for `UserConfig`. Unknown keys are rejected (CONFIG_INVALID). */
export const userConfigSchema = z.strictObject({
  docs: z.array(nonEmpty),
  exclude: z.array(nonEmpty),
  planDir: nonEmpty,
  recordingsDir: nonEmpty,
  runsDir: nonEmpty,
  cacheDir: nonEmpty,
  baseURL,
  drivers: z.record(nonEmpty, driverFactory),
  defaultDriver: nonEmpty,
  models: modelSet,
  fixtures: z.array(fixtureDefinition),
  secrets: z.record(z.string().regex(/^[A-Za-z0-9_.-]+$/, 'secret names may contain letters, digits, ".", "_" and "-"'), z.strictObject({ env: nonEmpty })),
  context: z.string(),
  extract: z.strictObject({ sectionDepth: z.number().int().min(1).max(6), maxSectionChars: posInt, minQuoteChars: posInt, concurrency: posInt }).partial(),
  characterize: z.strictObject({ confirmRuns: nonNegInt, probeMs: nonNegInt, healThreshold: posInt }).partial(),
  judge: z
    .strictObject({
      passThreshold: z.number().min(0).max(1),
      failThreshold: z.number().min(0).max(1),
      samples: z.number().int().min(1).max(9),
      maxSpread: z.number().min(0).max(1),
      vision: z.boolean(),
      maxTreeChars: posInt,
    })
    .partial(),
  agent: z.strictObject({ maxActions: posInt, maxModelCalls: posInt, maxWaitMs: nonNegInt }).partial(),
  checks: z.strictObject({ maxAttempts: posInt, maxPredicates: posInt, requireDeterministic: z.boolean() }).partial(),
  settle: z.strictObject({ quietMs: nonNegInt, intervalMs: posInt, timeoutMs: posInt, requireSettled: z.boolean() }).partial(),
  policy: z.strictObject({ allowHosts: z.array(nonEmpty), denyVerbs: z.array(z.enum(VERBS as [Verb, ...Verb[]])) }).partial(),
  concurrency: z.strictObject({ scenarios: posInt }).partial(),
  reporters: z.array(z.enum(['json', 'junit', 'markdown'])),
  prices: z.record(nonEmpty, price),
}).partial();

export type ParsedUserConfig = z.infer<typeof userConfigSchema>;
