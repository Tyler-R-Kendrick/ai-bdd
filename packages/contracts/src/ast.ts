import type {
  DataTable,
  Dialect,
  Diagnostic,
  KindSource,
  SourceLocation,
  StepArg,
  StepKind,
  StepOptions,
  StepPhase,
  Tag,
} from './primitives.js';

/** Provenance of a step that came from a concept expansion (P9). */
export interface StepOrigin {
  /** Concept id: `${uri}#${signature}`. */
  conceptId: string;
  signature: string;
  /** Location of the concept definition. */
  definition: SourceLocation;
  /** Location of the call site inside the spec. */
  callSite: SourceLocation;
  /** Captured concept parameters at this call site. */
  args: Record<string, string>;
}

/**
 * One executable step, after concept expansion and parameter substitution.
 * `id` is stable for a given (scenario id, index) so caches and lock entries
 * keep working when unrelated steps change.
 */
export interface Step {
  id: string;
  text: string;
  /** normalizeStepText(text) (P5). */
  normalized: string;
  /** Original keyword for Gherkin steps (`Given`, `When`, `*`, ...). */
  keyword?: string;
  kind: StepKind;
  kindSource: KindSource;
  args: StepArg[];
  location: SourceLocation;
  options: StepOptions;
  phase?: StepPhase;
  /** Data row of the owning scenario instance, when data-driven. */
  dataRow?: string[];
  /** Concept expansion chain, outermost first. Empty for plain steps. */
  originChain: StepOrigin[];
  /** Concept parameters captured for a step produced by a concept expansion. */
  conceptArgs?: Record<string, string>;
}

/** One scenario instance: each data row / outline row becomes its own. */
export interface Scenario {
  /** Stable id: `${document.id}#${slug(name)}` plus `[row]` for rows. */
  id: string;
  name: string;
  tags: Tag[];
  steps: Step[];
  /** Data-driven row (Gauge data table row or Gherkin Scenario Outline row). */
  dataRow?: string[];
  dataHeader?: string[];
  /** Gherkin `Examples:` block name, when present. */
  exampleSet?: string;
  /** Owning Gherkin `Rule:`, when present. */
  rule?: string;
  options: StepOptions;
  location: SourceLocation;
}

/** One parsed spec file. Both dialects produce this shape (R-K18). */
export interface SpecDocument {
  /** Stable id derived from the uri. */
  id: string;
  name: string;
  uri: string;
  dialect: Dialect;
  tags: Tag[];
  /** Spec-scope directives. */
  options: StepOptions;
  /** Spec-level data table (Gauge data-driven spec) or outline examples header. */
  dataTable?: DataTable;
  /** Steps before the first scenario (Gauge contexts) / Gherkin backgrounds. */
  contexts: Step[];
  /** Steps after the `___` teardown separator (Gauge only, P8). */
  teardown: Step[];
  scenarios: Scenario[];
  diagnostics: Diagnostic[];
}

export interface ParseResult {
  document: SpecDocument;
  diagnostics: Diagnostic[];
}

/** A Gauge concept definition from a `.cpt` file. */
export interface Concept {
  id: string;
  signature: string;
  /** Ordered `<param>` names in the signature. */
  parameters: string[];
  /** Body steps, as written (parameters not yet substituted). */
  body: ConceptStep[];
  location: SourceLocation;
  uri: string;
}

export interface ConceptStep {
  text: string;
  keyword?: string;
  args: StepArg[];
  location: SourceLocation;
}

export interface ConceptSet {
  concepts: Concept[];
  bySignature: Map<string, Concept>;
}
