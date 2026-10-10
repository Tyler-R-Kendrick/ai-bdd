// @ts-nocheck
import { isAbsolute, resolve } from 'node:path';
import {
  AiBddError,
  type AgentConfig,
  type CharacterizeConfig,
  type ChecksConfig,
  type ExtractConfig,
  type JudgeConfig,
  type RecordingsMode,
  type ReporterName,
  type ResolveConfig,
  type ResolvedConfig,
  type SettleOptions,
} from '../contracts/index.ts';
import { userConfigSchema } from './schema.ts';

export const DEFAULT_ALLOW_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];
export const MIN_SECRET_LENGTH = 4;

const DEFAULTS = {
  docs: ['docs/**/*.md'],
  exclude: ['**/node_modules/**', '.ai-bdd/**'],
  planDir: '.ai-bdd/plans',
  recordingsDir: '.ai-bdd/recordings',
  runsDir: '.ai-bdd/runs',
  cacheDir: '.ai-bdd/cache',
  extract: { sectionDepth: 2, maxSectionChars: 12000, minQuoteChars: 12, concurrency: 4 } satisfies ExtractConfig,
  characterize: { confirmRuns: 1, probeMs: 500, healThreshold: 2 } satisfies CharacterizeConfig,
  judge: { passThreshold: 0.8, failThreshold: 0.3, samples: 3, maxSpread: 0.5, vision: true, maxTreeChars: 20000 } satisfies JudgeConfig,
  agent: { maxActions: 20, maxModelCalls: 15, maxWaitMs: 5000 } satisfies AgentConfig,
  checks: { maxAttempts: 3, maxPredicates: 8, requireDeterministic: false } satisfies ChecksConfig,
  settle: { quietMs: 300, intervalMs: 100, timeoutMs: 5000, requireSettled: true } satisfies SettleOptions & { requireSettled: boolean },
  scenarios: 4,
  reporters: ['json', 'junit', 'markdown'] as ReporterName[],
} as const;

/** Drop keys whose value is `undefined` so spreads never override defaults with `undefined`. */
function defined<T extends object>(o: T | undefined): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: { [K in keyof T]?: Exclude<T[K], undefined> } = {};
  if (o === undefined) return out;
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

function invalid(message: string, issues: { path: string; message: string }[] = []): AiBddError {
  return new AiBddError('CONFIG_INVALID', message, { details: { issues } });
}

function unique(list: readonly string[]): string[] {
  return [...new Set(list)];
}

/**
 * Validate a user config and apply defaults. Pure: no file system access, no module loading.
 * Secret VALUES are read from `env` only to validate their length; they are never stored (R-SE1).
 */
export const resolveConfig: ResolveConfig = (user, opts) => {
  const parsed = userConfigSchema.safeParse(user);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      path: i.path.map(String).join('.') || '(root)',
      message: i.code === 'unrecognized_keys' ? `unknown key(s): ${i.keys.join(', ')}` : i.message,
    }));
    throw invalid(`Invalid ai-bdd config:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')}`, issues);
  }
  const u = parsed.data;
  const projectRoot = resolve(opts.projectRoot);
  const env = opts.env;
  const abs = (p: string): string => (isAbsolute(p) ? resolve(p) : resolve(projectRoot, p));

  const extract: ExtractConfig = { ...DEFAULTS.extract, ...defined(u.extract) };
  const characterize: CharacterizeConfig = { ...DEFAULTS.characterize, ...defined(u.characterize) };
  const judge: JudgeConfig = { ...DEFAULTS.judge, ...defined(u.judge) };
  const agent: AgentConfig = { ...DEFAULTS.agent, ...defined(u.agent) };
  const checks: ChecksConfig = { ...DEFAULTS.checks, ...defined(u.checks) };
  const settle: SettleOptions & { requireSettled: boolean } = { ...DEFAULTS.settle, ...defined(u.settle) };

  if (!(judge.failThreshold < judge.passThreshold)) {
    throw invalid(
      `Invalid ai-bdd config: judge.failThreshold (${judge.failThreshold}) must be lower than judge.passThreshold (${judge.passThreshold})`,
      [{ path: 'judge.failThreshold', message: 'must be lower than judge.passThreshold' }],
    );
  }

  // Secrets: names and env var names only. Values are validated for length and then forgotten.
  const secrets: Record<string, { env: string }> = {};
  for (const [name, spec] of Object.entries(u.secrets ?? {})) {
    secrets[name] = { env: spec.env };
    const value = env[spec.env];
    if (value !== undefined && value !== '' && value.length < MIN_SECRET_LENGTH) {
      throw new AiBddError(
        'SECRET_TOO_SHORT',
        `Secret "${name}" (env ${spec.env}) is shorter than ${MIN_SECRET_LENGTH} characters; short secrets cannot be redacted safely`,
        { details: { name, env: spec.env, minLength: MIN_SECRET_LENGTH } },
      );
    }
  }

  const ci = env['CI'] === 'true' || env['CI'] === '1';
  let recordingsMode: RecordingsMode = ci ? 'read-only' : 'read-write';
  const override = env['AI_BDD_RECORDINGS'];
  if (override !== undefined && override !== '') {
    if (override !== 'read-write' && override !== 'read-only' && override !== 'off') {
      throw invalid(`Invalid AI_BDD_RECORDINGS "${override}": expected read-write, read-only or off`, [
        { path: 'AI_BDD_RECORDINGS', message: 'expected read-write, read-only or off' },
      ]);
    }
    recordingsMode = override;
  }

  const allowHosts = unique(u.policy?.allowHosts ?? DEFAULT_ALLOW_HOSTS);
  if (u.baseURL !== undefined) {
    const host = new URL(u.baseURL).hostname.toLowerCase();
    if (!allowHosts.some((h) => h.toLowerCase() === host)) allowHosts.push(host);
  }

  const drivers = { ...(u.drivers ?? {}) };
  const driverNames = Object.keys(drivers);
  const defaultDriver = u.defaultDriver ?? (driverNames.length === 1 ? driverNames[0] : undefined);

  const resolved: ResolvedConfig = {
    projectRoot,
    ci,
    docs: [...(u.docs ?? DEFAULTS.docs)],
    exclude: [...(u.exclude ?? DEFAULTS.exclude)],
    planDir: abs(u.planDir ?? DEFAULTS.planDir),
    recordingsDir: abs(u.recordingsDir ?? DEFAULTS.recordingsDir),
    runsDir: abs(u.runsDir ?? DEFAULTS.runsDir),
    cacheDir: abs(u.cacheDir ?? DEFAULTS.cacheDir),
    drivers,
    fixtures: [...(u.fixtures ?? [])],
    secrets,
    context: u.context ?? '',
    extract,
    characterize,
    judge,
    agent,
    checks,
    settle,
    policy: { allowHosts, denyVerbs: unique(u.policy?.denyVerbs ?? []) as ResolvedConfig['policy']['denyVerbs'] },
    concurrency: { scenarios: u.concurrency?.scenarios ?? DEFAULTS.scenarios },
    recordingsMode,
    reporters: [...(u.reporters ?? DEFAULTS.reporters)],
    prices: { ...(u.prices ?? {}) },
  };
  if (opts.configPath !== undefined) resolved.configPath = abs(opts.configPath);
  if (u.baseURL !== undefined) resolved.baseURL = u.baseURL;
  if (defaultDriver !== undefined) resolved.defaultDriver = defaultDriver;
  if (u.models !== undefined) resolved.models = u.models;
  return resolved;
};
