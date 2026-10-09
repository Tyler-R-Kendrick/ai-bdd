import type { AssertionMode, JsonObject } from './primitives.js';
import type { Hooks } from './hooks.js';
import type { JudgeConfig } from './judge.js';
import type { PriceTable } from './models.js';
import type { InvalidationStrategy } from './programs.js';
import type { SettleOptions } from './evidence.js';

export type ReporterName = 'json' | 'junit' | 'markdown' | 'cucumber-messages';

/** A driver reference in configuration. In JSON configs this is `{use, options}`. */
export type DriverConfig = { use: string; options?: JsonObject };
export type DriverConfigMap = Record<string, DriverConfig>;

/** Model references. TS configs pass real model objects; JSON configs pass `{use, options}`. */
export interface ModelsConfig {
  act: unknown;
  judge: unknown;
  extract?: unknown;
  checkgen?: unknown;
  embed: unknown;
  grounding?: unknown;
}

export interface ResolutionConfig {
  threshold: number;
  margin: number;
  allowAgentSetup: boolean;
  semantic: { enabled: boolean; guards?: GuardConfig };
}

export interface GuardConfig {
  negationTokens?: string[];
  comparisonTokens?: string[];
  /** Extra numeric-literal sensitivity toggle (default on). */
  numbers?: boolean;
}

export interface KindsConfig {
  assertionPrefixes?: string[];
  assertionVerbs?: string[];
}

export interface AssertionsConfig {
  mode: AssertionMode;
  requireDeterministic: boolean;
  checkGen: { maxAttempts: number };
}

export interface AgentConfig {
  maxActions: number;
  maxModelCalls: number;
}

export interface CacheConfig {
  mode: 'read-write' | 'read-only' | 'off';
  dir: string;
  invalidation: string[];
  /** Route-to-globs mapping for the files-hash strategy. */
  files?: Record<string, string[]>;
  /** Value for the build-checksum strategy. */
  buildChecksum?: string;
  /** Value for the manual strategy. */
  manual?: string;
  /** Loaded custom strategies (TS configs only). */
  custom?: InvalidationStrategy[];
}

export interface EvidenceConfig {
  dir: string;
  video: 'off' | 'retain-on-failure' | 'on';
  requireSettled: boolean;
  settle: SettleOptions;
  signing?: { keyEnv: string };
}

export interface SecretDecl {
  env?: string;
  value?: string;
}

export interface PolicyConfig {
  allowHosts: string[];
  denyVerbs: string[];
  cua?: { allowApps: string[] };
}

export interface ConcurrencyConfig {
  scenarios: number;
}

export interface DaemonConfig {
  host: string;
  port: number;
  sessionIdleMs?: number;
}

export interface AiBddConfig {
  specs?: string[];
  concepts?: string[];
  bindings?: string[];
  drivers?: DriverConfigMap;
  defaultDriver?: string;
  models?: ModelsConfig;
  context?: string;
  resolution?: Partial<ResolutionConfig>;
  kinds?: KindsConfig;
  assertions?: Partial<AssertionsConfig>;
  judge?: Partial<JudgeConfig>;
  grounding?: { threshold: number; margin: number };
  agent?: Partial<AgentConfig>;
  cache?: Partial<CacheConfig>;
  evidence?: Partial<EvidenceConfig> & { settle?: Partial<SettleOptions> };
  secrets?: Record<string, SecretDecl>;
  policy?: Partial<PolicyConfig>;
  concurrency?: Partial<ConcurrencyConfig>;
  daemon?: Partial<DaemonConfig>;
  hooks?: Hooks;
  reporters?: ReporterName[];
  prices?: PriceTable;
}

/** The fully defaulted configuration the runtime works with. */
export interface ResolvedConfig {
  specs: string[];
  concepts: string[];
  bindings: string[];
  drivers: DriverConfigMap;
  defaultDriver?: string;
  models: ModelsConfig;
  context?: string;
  resolution: ResolutionConfig;
  kinds: Required<KindsConfig>;
  assertions: AssertionsConfig;
  judge: JudgeConfig;
  grounding: { threshold: number; margin: number };
  agent: AgentConfig;
  cache: CacheConfig;
  evidence: EvidenceConfig;
  secrets: Record<string, SecretDecl>;
  policy: Required<Omit<PolicyConfig, 'cua'>> & { cua: { allowApps: string[] } };
  concurrency: ConcurrencyConfig;
  daemon: Required<DaemonConfig>;
  hooks: Hooks;
  reporters: ReporterName[];
  prices: PriceTable;
  projectRoot: string;
}

export const DEFAULT_KIND_CONFIG: Required<KindsConfig> = {
  assertionPrefixes: ['the ', 'a message ', 'no ', 'verify ', 'check ', 'expect ', 'assert ', 'should ', 'then '],
  assertionVerbs: [
    ' reads ',
    ' shows ',
    ' is visible',
    ' is displayed',
    ' appears',
    ' contains ',
    ' equals ',
    ' is shown',
    ' should ',
    ' explains ',
    ' is not ',
    ' are ',
  ],
};

export const DEFAULT_GUARD_CONFIG: Required<GuardConfig> = {
  negationTokens: [
    'not',
    'no',
    'never',
    'without',
    'none',
    'empty',
    'cannot',
    "can't",
    "isn't",
    "doesn't",
    "don't",
    'fails',
    'failed',
  ],
  comparisonTokens: ['more', 'less', 'fewer', 'at least', 'at most', 'exactly', 'only'],
  numbers: true,
};

export const DEFAULT_SETTLE: SettleOptions = {
  quietMs: 300,
  intervalMs: 100,
  timeoutMs: 5000,
  pixelTolerance: 0.001,
};

export const CONFIG_KEYS = [
  'specs',
  'concepts',
  'bindings',
  'drivers',
  'defaultDriver',
  'models',
  'context',
  'resolution',
  'kinds',
  'assertions',
  'judge',
  'grounding',
  'agent',
  'cache',
  'evidence',
  'secrets',
  'policy',
  'concurrency',
  'daemon',
  'hooks',
  'reporters',
  'prices',
] as const satisfies readonly (keyof AiBddConfig)[];
