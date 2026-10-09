import type { ParseResult, SpecDocument } from '@ai-bdd/contracts';
import { parseMarkdownSpec } from './markdown.js';

/**
 * A dialect reads a document into the shared AST.
 *
 * The core ships exactly one (`markdown`). Gherkin and Gauge are *extension* packages
 * that register themselves, so a project that does not want `When`/`Given`/`Then` never
 * loads the code that understands it.
 */
export interface Dialect {
  id: string;
  /** File extensions that select this dialect, including the leading dot. */
  extensions: string[];
  /** Higher wins when several dialects claim a document. */
  priority?: number;
  parse(text: string, uri: string, ctx: DialectParseContext): ParseResult;
  /** Arbitrary side information a parser wants to hand back (intent, concepts, ...). */
  extras?(text: string, uri: string, ctx: DialectParseContext): Record<string, unknown>;
}

export interface DialectParseContext {
  registry: DialectRegistry;
  kinds?: { assertionPrefixes?: string[]; assertionVerbs?: string[] };
}

export interface DialectRegistry {
  register(dialect: Dialect): void;
  get(id: string): Dialect | undefined;
  list(): Dialect[];
  /** The dialect for a path, by extension, then by content sniffing. */
  forPath(path: string, text?: string): Dialect;
}

/** Sniffs a document's dialect from its first meaningful lines. */
export function detectDialect(text: string, registry: DialectRegistry): Dialect {
  for (const dialect of [...registry.list()].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))) {
    if (dialect.id === 'markdown') continue;
    if (dialect.extensions.some((extension) => text.includes(extension))) continue;
    if (/^\s*(Feature:|#\s*language:)/mu.test(text) && dialect.id === 'gherkin') return dialect;
  }
  return registry.get('markdown') ?? markdownDialect;
}

const markdownDialect: Dialect = {
  id: 'markdown',
  extensions: ['.md', '.markdown', '.mdx', '.txt'],
  priority: 0,
  parse(text, uri, ctx) {
    return parseMarkdownSpec(text, uri, ctx.kinds !== undefined ? { kinds: ctx.kinds } : {}).result;
  },
  extras(text, uri, ctx) {
    const parsed = parseMarkdownSpec(text, uri, ctx.kinds !== undefined ? { kinds: ctx.kinds } : {});
    return { intent: Object.fromEntries(parsed.intent), specIntent: parsed.specIntent };
  },
};

export function createDialectRegistry(): DialectRegistry {
  const dialects = new Map<string, Dialect>();
  return {
    register(dialect) {
      dialects.set(dialect.id, dialect);
    },
    get(id) {
      return dialects.get(id);
    },
    list() {
      return [...dialects.values()];
    },
    forPath(path, text) {
      for (const dialect of [...dialects.values()].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))) {
        if (dialect.extensions.some((extension) => path.endsWith(extension))) return dialect;
      }
      if (text !== undefined) return detectDialect(text, this);
      const fallback = dialects.get('markdown');
      if (fallback) return fallback;
      throw new Error('no dialect is registered and none could be detected');
    },
  };
}

/** The registry a runtime uses when a project registers no dialects. */
export const defaultDialectRegistry: DialectRegistry = (() => {
  const registry = createDialectRegistry();
  registry.register(markdownDialect);
  return registry;
})();

/** Parses a document with the dialect its path selects. */
export function parseSpec(
  text: string,
  uri: string,
  options: { registry?: DialectRegistry; dialectId?: string; kinds?: DialectParseContext['kinds'] } = {},
): ParseResult & { extras: Record<string, unknown>; dialectId: string } {
  const registry = options.registry ?? defaultDialectRegistry;
  const dialect = options.dialectId !== undefined ? registry.get(options.dialectId) : registry.forPath(uri, text);
  if (!dialect) {
    const document = parseMarkdownSpec(text, uri).result.document;
    return { document, diagnostics: document.diagnostics, extras: {}, dialectId: 'markdown' };
  }
  const ctx: DialectParseContext = { registry, ...(options.kinds !== undefined ? { kinds: options.kinds } : {}) };
  const result = dialect.parse(text, uri, ctx);
  return { ...result, extras: dialect.extras?.(text, uri, ctx) ?? {}, dialectId: dialect.id };
}

export type { SpecDocument };
