import { AstBuilder, compile as compilePickles, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { IdGenerator, PickleStepType } from '@cucumber/messages';
import type { GherkinDocument, Pickle, Step as AstStep } from '@cucumber/messages';
import type {
  Chunk, ChunkedDoc, Diagnostic, DocumentExtension, DraftFeature, DraftScenario, DraftStep,
  ExtractionInput, ExtractionResult, Section, SourceDoc, SourceRange, StepKind, Usage,
} from '@ai-bdd/sdk/contracts';
import { sha256Hex } from '@ai-bdd/sdk';

export type { GherkinDocument, Pickle } from '@cucumber/messages';

export const GHERKIN_EXTENSION_ID = '@ai-bdd/gherkin';
export const GHERKIN_PROMPT_VERSION = 'cucumber-gherkin-42';

export interface GherkinOptions {
  /** A Cucumber language code, e.g. `en`, `fr` or `pt`. A `# language:` header still overrides it. */
  defaultDialect?: string;
  /** URI suffixes claimed by the extension. Default `['.feature']`. */
  suffixes?: readonly string[];
}

/** Parse with the official Cucumber parser and compile pickles (background and example expansion included). */
export function parseGherkin(text: string, uri = 'memory.feature', opts: GherkinOptions = {}): {
  ast: GherkinDocument;
  pickles: readonly Pickle[];
} {
  const ast = new Parser(new AstBuilder(IdGenerator.incrementing()), new GherkinClassicTokenMatcher(opts.defaultDialect)).parse(text);
  return { ast, pickles: compilePickles(ast, uri, IdGenerator.incrementing()) };
}
const ZERO_USAGE: Usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0 };

interface ParsedDocument {
  ast: GherkinDocument;
  pickles: readonly Pickle[];
  featureChunkId: string;
  scenarioChunks: ReadonlyMap<string, string>;
  stepChunks: ReadonlyMap<string, string>;
  steps: ReadonlyMap<string, AstStep>;
}

const cache = new WeakMap<ChunkedDoc, ParsedDocument>();

function range(line: number, column: number | undefined, text: string): SourceRange {
  const startColumn = column ?? 1;
  return { startLine: line, startColumn, endLine: line, endColumn: startColumn + Math.max(1, text.length) };
}

function empty(doc: SourceDoc, diagnostics: Diagnostic[]): ChunkedDoc {
  return { doc: { uri: doc.uri, sha256: doc.sha256, title: doc.uri }, chunks: [], sections: [], contextChunkIds: [], diagnostics };
}

function parse(doc: SourceDoc, opts: GherkinOptions): { chunked: ChunkedDoc; parsed?: ParsedDocument } {
  let ast: GherkinDocument;
  let pickles: readonly Pickle[];
  try {
    const compiled = parseGherkin(doc.text, doc.uri, opts);
    ast = compiled.ast;
    pickles = compiled.pickles;
  } catch (error) {
    return {
      chunked: empty(doc, [{
        code: 'DOC_READ_FAILED', severity: 'error', uri: doc.uri,
        message: `invalid Gherkin: ${error instanceof Error ? error.message : String(error)}`,
      }]),
    };
  }
  const feature = ast.feature;
  if (feature === undefined) return { chunked: empty(doc, []) };

  const sectionId = `${doc.uri}#feature`;
  const featureChunkId = `${sectionId}/feature`;
  const chunks: Chunk[] = [];
  const scenarioChunks = new Map<string, string>();
  const stepChunks = new Map<string, string>();
  const steps = new Map<string, AstStep>();
  const add = (id: string, kind: Chunk['kind'], text: string, at: { line: number; column?: number }, headingPath: string[]): string => {
    const chunkId = `${sectionId}/${id}`;
    chunks.push({
      id: chunkId, docUri: doc.uri, anchor: id, kind, headingPath, sectionId,
      text, hash: sha256Hex(text), range: range(at.line, at.column, text), directives: {},
    });
    return chunkId;
  };
  add('feature', 'heading', `${feature.keyword}: ${feature.name}`, feature.location, [feature.name]);

  for (const child of feature.children) {
    if (child.background !== undefined) {
      const background = child.background;
      add(background.id ?? `background-${background.location.line}`, 'heading', background.keyword, background.location, [feature.name]);
      for (const step of background.steps) {
        const text = `${step.keyword}${step.text}`;
        stepChunks.set(step.id, add(step.id, 'paragraph', text, step.location, [feature.name, background.keyword]));
        steps.set(step.id, step);
      }
    }
    if (child.scenario !== undefined) {
      const scenario = child.scenario;
      scenarioChunks.set(scenario.id, add(scenario.id, 'heading', `${scenario.keyword}: ${scenario.name}`, scenario.location, [feature.name, scenario.name]));
      for (const step of scenario.steps) {
        const text = `${step.keyword}${step.text}`;
        stepChunks.set(step.id, add(step.id, 'paragraph', text, step.location, [feature.name, scenario.name]));
        steps.set(step.id, step);
      }
    }
    if (child.rule !== undefined) {
      const rule = child.rule;
      add(rule.id, 'heading', `${rule.keyword}: ${rule.name}`, rule.location, [feature.name, rule.name]);
      for (const ruleChild of rule.children) {
        const owner = ruleChild.background ?? ruleChild.scenario;
        if (owner === undefined) continue;
        add(owner.id ?? `${owner.keyword}-${owner.location.line}`, 'heading', `${owner.keyword}${'name' in owner ? `: ${owner.name}` : ''}`, owner.location, [feature.name, rule.name]);
        if (ruleChild.scenario !== undefined) scenarioChunks.set(ruleChild.scenario.id, `${sectionId}/${owner.id}`);
        for (const step of owner.steps) {
          const text = `${step.keyword}${step.text}`;
          stepChunks.set(step.id, add(step.id, 'paragraph', text, step.location, [feature.name, rule.name]));
          steps.set(step.id, step);
        }
      }
    }
  }

  const endLine = Math.max(feature.location.line, ...chunks.map((c) => c.range.endLine));
  const section: Section = {
    id: sectionId, docUri: doc.uri, anchor: 'feature', title: feature.name, level: 1,
    chunkIds: chunks.map((c) => c.id), hash: sha256Hex(chunks.map((c) => c.hash).join('\n')),
    range: { startLine: feature.location.line, startColumn: feature.location.column ?? 1, endLine, endColumn: 1 },
  };
  const chunked: ChunkedDoc = {
    doc: { uri: doc.uri, sha256: doc.sha256, title: feature.name },
    chunks, sections: [section], contextChunkIds: [], diagnostics: [],
  };
  const parsed: ParsedDocument = {
    ast, pickles,
    featureChunkId, scenarioChunks, stepChunks, steps,
  };
  cache.set(chunked, parsed);
  return { chunked, parsed };
}
function kindOf(type: PickleStepType | undefined, previous: StepKind): StepKind {
  if (type === PickleStepType.CONTEXT) return 'given';
  if (type === PickleStepType.ACTION) return 'when';
  if (type === PickleStepType.OUTCOME) return 'then';
  return previous;
}

function source(chunkId: string | undefined, quote?: string): { chunkId: string; relation: 'source'; quote?: string }[] {
  if (chunkId === undefined) return [];
  return [{ chunkId, relation: 'source', ...(quote === undefined ? {} : { quote }) }];
}

function drafts(input: ExtractionInput, parsed: ParsedDocument): DraftFeature[] {
  const feature = parsed.ast.feature;
  if (feature === undefined) return [];
  const byId = new Map(input.doc.chunks.map((c) => [c.id, c] as const));
  const scenarios: DraftScenario[] = parsed.pickles.map((pickle) => {
    const scenarioAstId = pickle.astNodeIds.find((id) => parsed.scenarioChunks.has(id));
    const scenarioChunkId = scenarioAstId === undefined ? undefined : parsed.scenarioChunks.get(scenarioAstId);
    let previous: StepKind = 'given';
    const steps: DraftStep[] = pickle.steps.map((step) => {
      const kind = kindOf(step.type, previous);
      previous = kind;
      const astId = [...step.astNodeIds].reverse().find((id) => parsed.stepChunks.has(id));
      const chunkId = astId === undefined ? undefined : parsed.stepChunks.get(astId);
      const original = astId === undefined ? undefined : parsed.steps.get(astId);
      const originalText = original === undefined ? step.text : `${original.keyword}${original.text}`;
      return { kind, text: step.text, grounding: 'quoted', params: {}, sources: source(chunkId, originalText) };
    });
    const scenarioRefs = source(scenarioChunkId, scenarioChunkId === undefined ? undefined : byId.get(scenarioChunkId)?.text);
    return {
      title: pickle.name, tags: pickle.tags.map((t) => t.name),
      sources: [...scenarioRefs, ...steps.flatMap((s) => s.sources)], steps,
    };
  });
  return [{
    title: feature.name, description: feature.description.trim(),
    tags: feature.tags.map((t) => t.name), sources: source(parsed.featureChunkId, `${feature.keyword}: ${feature.name}`), scenarios,
  }];
}

/** Create the pluggable `.feature` document extension. No AI extraction model is used. */
export function gherkin(options: GherkinOptions = {}): DocumentExtension {
  return {
    id: GHERKIN_EXTENSION_ID,
    suffixes: options.suffixes === undefined || options.suffixes.length === 0 ? ['.feature'] : [...options.suffixes],
    chunker: { chunk(doc) { return parse(doc, options).chunked; } },
    extractor: {
      async extractSection(input: ExtractionInput): Promise<ExtractionResult> {
        const parsed = cache.get(input.doc);
        return {
          sectionId: input.section.id, failed: parsed === undefined,
          drafts: parsed === undefined ? [] : drafts(input, parsed),
          notTestable: [], diagnostics: parsed === undefined ? [{ code: 'DOC_READ_FAILED', severity: 'error', message: 'Gherkin AST is unavailable', uri: input.doc.doc.uri }] : [],
          usage: { ...ZERO_USAGE }, modelId: GHERKIN_EXTENSION_ID, promptVersion: GHERKIN_PROMPT_VERSION,
        };
      },
    },
  };
}

/** Package-loader entry point for JSON configuration. */
export const createDocumentExtension = gherkin;
export default gherkin;

