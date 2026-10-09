/**
 * Primitive shared types (section 10 of the ai-bdd specification).
 * Every other contract builds on these.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * An authoring dialect id.
 *
 * The core ships `markdown` and nothing else. `gherkin` and `gauge` are *extension*
 * dialects that produce the same AST, so a project can add or drop one without the
 * runtime changing (the id is a string, not a closed union, for that reason).
 */
export type Dialect = 'markdown' | 'gherkin' | 'gauge' | (string & {});

/**
 * Step kind. `setup` arranges state, `action` changes the UI, `assertion`
 * checks an outcome.
 */
export type StepKind = 'setup' | 'action' | 'assertion';

/** Where the kind came from (section 7.4). */
export type KindSource = 'directive' | 'binding' | 'keyword' | 'prefix' | 'default';

/** Resolution modes for an assertion step (section 8.3). */
export type AssertionMode = 'auto' | 'check' | 'judge' | 'both';

/** Restricts the resolution chain (section 8.1.1). */
export type ResolveMode = 'auto' | 'exact' | 'semantic' | 'agent';

/** Lifecycle phase of a step inside a scenario instance (P8). */
export type StepPhase = 'context' | 'scenario' | 'teardown';

/** Result status, shared by steps and scenarios. */
export type Status =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'pending'
  | 'ambiguous'
  | 'undefined'
  | 'healed';

export type Severity = 'error' | 'warning' | 'info';

/** 1-based line/column on the original text, with an optional inclusive end. */
export interface SourceLocation {
  uri: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  location?: SourceLocation;
  details?: JsonValue;
  related?: SourceLocation[];
}

/** A table argument: the first row is the header. */
export interface DataTable {
  header: string[];
  rows: string[][];
}

export type StepArg =
  | { type: 'table'; table: DataTable; location?: SourceLocation }
  | { type: 'docString'; content: string; mediaType?: string; location?: SourceLocation }
  | { type: 'file'; path: string; content: string; location?: SourceLocation }
  | { type: 'secret'; name: string; location?: SourceLocation };

/** Per-scope options produced by directives (section 7.3). */
export interface StepOptions {
  kind?: StepKind;
  mode?: AssertionMode;
  threshold?: number;
  failThreshold?: number;
  samples?: number;
  vision?: boolean;
  driver?: string;
  resolve?: ResolveMode;
  timeout?: number;
  invariant?: boolean;
}

/** The set of directive keys, used for validation. */
export const DIRECTIVE_KEYS = [
  'kind',
  'mode',
  'threshold',
  'failThreshold',
  'samples',
  'vision',
  'driver',
  'resolve',
  'timeout',
  'invariant',
] as const satisfies readonly (keyof StepOptions)[];

export type DirectiveKey = (typeof DIRECTIVE_KEYS)[number];

/** Tag expression grammar comes from @cucumber/tag-expressions; tags are stored raw. */
export type Tag = string;
