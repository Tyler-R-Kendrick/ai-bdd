/**
 * @ai-bdd/spec-gherkin — the Gherkin dialect adapter.
 *
 * Gherkin is parsed with @cucumber/gherkin and its pickles are compiled into the
 * same SpecDocument the Gauge parser produces, so both dialects share one engine
 * (R-K18). Kinds come from the pickle step type: Context -> setup,
 * Action -> action, Outcome -> assertion; `*` steps are inferred later.
 */
import { AstBuilder, GherkinClassicTokenMatcher, Parser, compile } from '@cucumber/gherkin';
import { IdGenerator, PickleStepType } from '@cucumber/messages';
import type { GherkinDocument, Pickle, PickleStep, StepKeywordType } from '@cucumber/messages';
import type {
  DataTable,
  Diagnostic,
  JsonValue,
  ParseResult,
  Scenario,
  SourceLocation,
  SpecDocument,
  Step,
  StepArg,
  StepKind,
  StepOptions,
} from '@ai-bdd/contracts';
import { normalizeStepText, slug } from '@ai-bdd/contracts';
import { parseDirectives } from '@ai-bdd/spec-directives';

export function parseGherkin(text: string, uri: string): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const parseOptions = {
    defaultDialect: 'en' as const,
    includeGherkinDocument: true,
    includePickles: true,
    includeSource: true,
    newId: IdGenerator.uuid(),
  };

  let document: SpecDocument;
  const declaredDialect = /^\s*#\s*language:\s*(\S+)/mu.exec(text)?.[1];
  try {
    const parser = new Parser(new AstBuilder(IdGenerator.uuid()), new GherkinClassicTokenMatcher(declaredDialect ?? 'en'));
    const gherkinDocument = parser.parse(text) as GherkinDocument;
    // `compile` returns one pickled step sequence per scenario or outline row.
    const pickles = compile(gherkinDocument, uri, IdGenerator.uuid()) as unknown as Pickle[];
    document = convert(gherkinDocument, pickles, text, uri, diagnostics);
  } catch (error) {
    diagnostics.push({
      code: 'GHERKIN_PARSE',
      severity: 'error',
      message: error instanceof Error ? error.message : String(error),
      location: { uri, line: 1, column: 1 },
    });
    document = emptyDocument(uri, diagnostics);
  }
  document.diagnostics = diagnostics;
  return { document, diagnostics };
}

export { parseDirectives };
export type { JsonValue, StepArg, DataTable, StepOptions };

function emptyDocument(uri: string, diagnostics: Diagnostic[]): SpecDocument {
  return {
    id: documentId(uri),
    name: uri.split('/').pop() ?? uri,
    uri,
    dialect: 'gherkin',
    tags: [],
    options: {},
    contexts: [],
    teardown: [],
    scenarios: [],
    diagnostics: [...diagnostics],
  };
}

function documentId(uri: string): string {
  return `gherkin:${slug(uri)}`;
}

/** Converts a Gherkin document plus its pickles into the shared AST. */
function convert(
  gherkinDocument: GherkinDocument,
  pickles: Pickle[],
  text: string,
  uri: string,
  diagnostics: Diagnostic[],
): SpecDocument {
  const feature = gherkinDocument.feature;
  if (!feature) {
    diagnostics.push({ code: 'GHERKIN_PARSE', severity: 'error', message: 'the document has no Feature', location: { uri, line: 1, column: 1 } });
    return emptyDocument(uri, diagnostics);
  }

  const id = documentId(uri);
  const lines = text.split(/\r?\n/u);
  // Every pickle already inlines its Background steps, so the scenario step list
  // is used as-is; steps that come from a Background are marked as context phase.
  const keywordByText = new Map<string, string>();
  const backgroundTexts = new Set<string>();
  for (const child of feature.children) {
    const background = child.background;
    if (background) {
      for (const step of background.steps) {
        keywordByText.set(step.text, step.keyword);
        backgroundTexts.add(step.text);
      }
    }
    const scenario = child.scenario;
    if (scenario) for (const step of scenario.steps) keywordByText.set(step.text, step.keyword);
  }

  const specOptions: StepOptions = {};
  const contexts: Step[] = [];
  const contextsExtra = collectContexts(feature, uri);
  contexts.push(...contextsExtra);

  const scenarios: Scenario[] = [];
  for (const pickle of pickles) {
    const scenarioName = pickle.name;
    const tags = pickle.tags.map((tag) => tag.name);
    const locationOf = (ref: unknown): SourceLocation => {
      const location = (ref as { location?: { line?: number; column?: number } } | undefined)?.location;
      return { uri, line: location?.line ?? 1, column: location?.column ?? 1 };
    };
    const line = pickleLine(lines, scenarioName);
    const scenarioId = `${id}#${slug(scenarioName)}${pickle.astNodeIds.length > 1 ? `[${pickle.astNodeIds.at(-1)?.slice(-4) ?? 'row'}]` : ''}`;
    const steps: Step[] = pickle.steps.map((step, index) => {
      const keyword = keywordByText.get(step.text) ?? '';
      const kind = kindOfStep(step.type as PickleStepType | undefined);
      const args = stepArgsOf(step, uri, locationOf(step));
      const normalized = normalizeStepText(step.text);
      return {
        id: `${scenarioId}#${index}`,
        text: step.text,
        normalized,
        ...(keyword ? { keyword } : {}),
        kind,
        kindSource: 'keyword',
        args,
        location: locationOf(step),
        options: {},
        ...(backgroundTexts.has(step.text) ? { phase: 'context' as const } : {}),
        originChain: [],
      };
    });

    applyInlineDirectives(lines, steps, scenarioId, diagnostics);
    const row = dataRowOf(pickle, feature);
    scenarios.push({
      id: scenarioId,
      name: scenarioName,
      tags,
      steps,
      ...(row.values.length > 0 ? { dataRow: row.values } : {}),
      ...(row.header.length > 0 ? { dataHeader: row.header } : {}),
      ...(pickle.name && /outline/iu.test(scenarioName) ? { exampleSet: scenarioName } : {}),
      options: {},
      location: { uri, line, column: 1 },
    });
  }

  return {
    id,
    name: feature.name,
    uri,
    dialect: 'gherkin',
    tags: feature.tags.map((tag) => tag.name),
    options: specOptions,
    contexts: contextsExtra,
    teardown: [],
    scenarios,
    diagnostics: [...diagnostics],
  };
}

function collectContexts(feature: NonNullable<GherkinDocument['feature']>, uri: string): Step[] {
  const contexts: Step[] = [];
  for (const child of feature.children) {
    const background = child.background;
    if (!background) continue;
    background.steps.forEach((step, index) => {
      const keyword = step.keyword ?? '';
      contexts.push({
        id: `context#${index}`,
        text: step.text,
        normalized: normalizeStepText(step.text),
        ...(keyword ? { keyword } : {}),
        kind: kindOfKeyword(keyword),
        kindSource: 'keyword',
        args: [],
        location: { uri, line: step.location?.line ?? 1, column: step.location?.column ?? 1 },
        options: {},
        phase: 'context',
        originChain: [],
      });
    });
  }
  return contexts;
}

function applyInlineDirectives(lines: string[], steps: Step[], scenarioId: string, diagnostics: Diagnostic[]): void {
  // A comment line directly after a step (or its table/docstring) is a step directive.
  let lastStepIndex = -1;
  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (/^\*\s|^(Given|When|Then|And|But)\b/u.test(trimmed)) {
      lastStepIndex += 1;
      return;
    }
    if (!trimmed.startsWith('#') || trimmed.startsWith('# ai-bdd:')) {
      if (trimmed.startsWith('# ai-bdd:')) {
        const parsed = parseDirectives(trimmed, 'gherkin', { uri: scenarioId, line: index + 1, column: 1 });
        if (parsed) {
          const target = steps[lastStepIndex];
          if (target) Object.assign(target.options, parsed.directives);
          diagnostics.push(...parsed.diagnostics);
        }
      }
    }
  });
}

function pickleLine(lines: string[], name: string): number {
  const index = lines.findIndex((line) => line.includes(name));
  return index === -1 ? 1 : index + 1;
}

function kindOfKeyword(keyword: string): StepKind {
  if (/^given\b/iu.test(keyword)) return 'setup';
  if (/^when\b/iu.test(keyword)) return 'action';
  if (/^then\b/iu.test(keyword)) return 'assertion';
  return 'action';
}

function kindOfStep(type: PickleStepType | undefined): StepKind {
  switch (type) {
    case PickleStepType.CONTEXT:
      return 'setup';
    case PickleStepType.OUTCOME:
      return 'assertion';
    case PickleStepType.ACTION:
      return 'action';
    default:
      return 'action';
  }
}

function stepArgsOf(step: PickleStep, uri: string, location: SourceLocation): StepArg[] {
  const args: StepArg[] = [];
  const argument = step.argument as
    | { dataTable?: { rows: Array<{ cells: Array<{ value: string }> }> }; docString?: { content: string; mediaType?: string } }
    | undefined;
  if (argument?.dataTable) {
    const rows = argument.dataTable.rows.map((row) => row.cells.map((cell) => cell.value));
    const [header, ...body] = rows;
    args.push({ type: 'table', table: { header: header ?? [], rows: body }, location });
  }
  if (argument?.docString) {
    args.push({
      type: 'docString',
      content: argument.docString.content,
      ...(argument.docString.mediaType ? { mediaType: argument.docString.mediaType } : {}),
      location,
    });
  }
  void uri;
  return args;
}

function dataRowOf(pickle: Pickle, feature: NonNullable<GherkinDocument['feature']>): { header: string[]; values: string[] } {
  const outline = feature.children
    .map((child) => child.scenario)
    .find((scenario) => scenario !== undefined && pickle.astNodeIds.includes(scenario.id));
  const examples = outline?.examples ?? [];
  for (const block of examples) {
    for (const row of block.tableBody) {
      if (!pickle.astNodeIds.includes(row.id)) continue;
      const headerRow = block.tableHeader?.cells.map((cell) => cell.value) ?? [];
      return { header: headerRow, values: row.cells.map((cell) => cell.value) };
    }
  }
  return { header: [], values: [] };
}

export type { StepKeywordType };
