/**
 * @ai-bdd/spec-markdown — the core spec dialect.
 *
 * An unstructured markdown document is read as a spec by convention: sections are
 * scenarios, bullets (including PRD checkboxes) are steps, prose is the intent handed
 * to the actor. There is no bespoke syntax, and a dialect such as Gherkin is an
 * extension that produces the same `SpecDocument`.
 */
export {
  parseMarkdown,
  parseMarkdownSpec,
  inferKind,
  type MarkdownParseOptions,
  type ParsedMarkdown,
} from './markdown.js';
export {
  createDialectRegistry,
  defaultDialectRegistry,
  detectDialect,
  parseSpec,
  type Dialect,
  type DialectParseContext,
  type DialectRegistry,
} from './dialects.js';
