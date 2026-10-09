import type { JsonValue, SourceLocation, StepKind } from './primitives.js';

export type ParamType = 'string' | 'int' | 'float' | 'word' | 'any' | 'enum';

/** A declared parameter of a binding, used for extraction and validation (R-K5d). */
export interface ParamDecl {
  name: string;
  type: ParamType;
  enumValues?: string[];
  /** `derived: true` relaxes the verbatim-occurrence rule (R-K5d). */
  derived?: boolean;
  optional?: boolean;
}

export type PatternKind = 'cucumber-expression' | 'regex' | 'gauge-template';

/** A binding as published by a provider (no hash fields: the server computes them). */
export interface BindingDescriptor {
  /** Globally unique id, e.g. `ts:local#seed-workspace` or `py:behave#steps.py:12`. */
  id: string;
  /** Binding provider: `ts:local`, `python:behave`, `java:cucumber-jvm`, ... */
  provider: string;
  pattern: string;
  patternKind: PatternKind;
  /** `any` means the binding accepts any step kind. */
  kind: StepKind | 'any';
  description?: string;
  examples?: string[];
  counterExamples?: string[];
  params?: ParamDecl[];
  /** When true, a `kindSource: 'default'` step may not use this binding (R-K5c). */
  strictKind?: boolean;
  source?: SourceLocation;
  /** Optional implementation reference inside the provider runtime. */
  functionRef?: string;
  tags?: string[];
}

/** A registered binding, with the deterministic content hash used by the lockfile. */
export interface Binding extends BindingDescriptor {
  hash: string;
  /** Text used for embedding (pattern + description + examples), precomputed. */
  bindingTexts: string[];
}

export interface BindingSet {
  bindings: Binding[];
  /** Deterministic hash over the sorted binding hashes. */
  hash: string;
  providers: string[];
}

export interface BindingMatch {
  binding: Binding;
  params: Record<string, JsonValue>;
  /** Captured raw spans, used by the polarity guard. */
  spans?: string[];
}

/** Instruction returned to a plugin: call its own function, then report back. */
export interface InvokeLocal {
  type: 'invoke-local';
  bindingId: string;
  params: Record<string, JsonValue>;
}

export interface AcceptedBinding {
  id: string;
  rejected?: never;
}

export interface RejectedBinding {
  id: string;
  rejected: string;
}
