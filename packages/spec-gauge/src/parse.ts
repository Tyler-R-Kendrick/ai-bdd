/**
 * Gauge-format markdown parser (sections 4.3 and 7.1, rules P1-P10).
 *
 * The parser never throws (P10): any unexpected failure is reported as an
 * INTERNAL diagnostic and an empty document is returned.
 */
import {
  normalizeStepText,
  slug,
  type Concept,
  type DataTable,
  type Diagnostic,
  type ParseResult,
  type Scenario,
  type SourceLocation,
  type SpecDocument,
  type Step,
  type StepOptions,
  type StepPhase,
} from '@ai-bdd/contracts';
import { inferKind, parseDirectives } from '@ai-bdd/spec-directives';
import { readStepBlock, readTags, type RawStep } from './blocks.js';
import { expandConcepts, type ExpandedStep } from './expand.js';
import { loadExternalTable, resolveStepParams, type ParamContext } from './params.js';
import {
  isFence,
  isScenarioHeading,
  isSpecHeading,
  isStep,
  isTagsLine,
  isTeardown,
  isUnderlineDash,
  isUnderlineEq,
  location,
  parseTableRow,
  parseTableRows,
  RE_EXTERNAL_TABLE,
  splitLines,
  type Line,
} from './text.js';

export interface GaugeParseOptions {
  concepts?: Concept[];
  readFile?: (path: string) => string;
  /** Defaults to the directory of `uri`. */
  projectRoot?: string;
}

interface ScenarioBuilder {
  name: string;
  tags: string[];
  options: Partial<StepOptions>;
  location: SourceLocation;
  steps: RawStep[];
}

type Anchor =
  | { kind: 'spec' }
  | { kind: 'scenario'; scenario: ScenarioBuilder }
  | { kind: 'step'; step: RawStep };

function projectRootOf(uri: string): string {
  const normalized = uri.replace(/\\/gu, '/');
  const index = normalized.lastIndexOf('/');
  if (index < 0) return '.';
  return normalized.slice(0, index) || '/';
}

function buildStep(
  expanded: ExpandedStep,
  id: string,
  ctx: ParamContext,
  diagnostics: Diagnostic[],
): Step {
  const resolved = resolveStepParams(expanded.text, expanded.args, expanded.location, ctx);
  diagnostics.push(...resolved.diagnostics);
  const inferred = inferKind({ text: resolved.text, options: expanded.options });
  return {
    id,
    text: resolved.text,
    normalized: normalizeStepText(resolved.text),
    kind: inferred.kind,
    kindSource: inferred.kindSource,
    args: resolved.args,
    location: expanded.location,
    options: expanded.options,
    phase: expanded.phase,
    originChain: expanded.originChain,
    ...(expanded.conceptArgs === undefined ? {} : { conceptArgs: expanded.conceptArgs }),
  };
}

function emptyDocument(uri: string): SpecDocument {
  return {
    id: uri,
    name: '',
    uri,
    dialect: 'gauge',
    tags: [],
    options: {},
    contexts: [],
    teardown: [],
    scenarios: [],
    diagnostics: [],
  };
}

interface ParseState {
  name: string;
  specHeadings: number;
  specTags: string[];
  specOptions: Partial<StepOptions>;
  contexts: RawStep[];
  teardown: RawStep[];
  builders: ScenarioBuilder[];
  dataTable: DataTable | undefined;
  diagnostics: Diagnostic[];
  projectRoot: string;
  reported: Set<string>;
}

function parseInternal(text: string, uri: string, opts: GaugeParseOptions): ParseResult {
  const lines = splitLines(text);
  const diagnostics: Diagnostic[] = [];
  const concepts = opts.concepts ?? [];
  const projectRoot = opts.projectRoot ?? projectRootOf(uri);
  const reported = new Set<string>();

  const specTags: string[] = [];
  const specOptions: Partial<StepOptions> = {};
  const contexts: RawStep[] = [];
  const teardown: RawStep[] = [];
  const builders: ScenarioBuilder[] = [];
  const seenNames = new Set<string>();
  let name = '';
  let specHeadings = 0;
  let dataTable: DataTable | undefined;
  let current: ScenarioBuilder | null = null;
  const currentScenario = (): ScenarioBuilder | null => current;
  let phase: StepPhase = 'context';
  // Read through a function so TypeScript does not narrow away the phases that
  // are only assigned inside the nested builders below.
  const currentPhase = (): StepPhase => phase;
  let fence: string | null = null;
  let anchorLine = -1;
  let anchor: Anchor | null = null;

  const multipleHeading = (line: Line): Diagnostic => ({
    code: 'GAUGE_MULTIPLE_SPEC_HEADINGS',
    severity: 'error',
    message: 'A spec file may only contain one spec heading.',
    location: location(uri, line),
  });

  const startScenario = (scenarioName: string, line: Line): void => {
    const builder: ScenarioBuilder = {
      name: scenarioName,
      tags: [],
      options: {},
      location: location(uri, line),
      steps: [],
    };
    if (seenNames.has(scenarioName)) {
      diagnostics.push({
        code: 'GAUGE_DUPLICATE_SCENARIO',
        severity: 'error',
        message: `Scenario "${scenarioName}" is defined more than once.`,
        location: location(uri, line),
      });
    }
    seenNames.add(scenarioName);
    builders.push(builder);
    current = builder;
    phase = 'scenario';
    anchor = { kind: 'scenario', scenario: builder };
  };

  const applyDirective = (line: Line): void => {
    const parsed = parseDirectives(line.raw, 'gauge', location(uri, line));
    if (parsed === null) return;
    if (anchor !== null && line.number === anchorLine + 1) {
      if (anchor.kind === 'spec') Object.assign(specOptions, parsed.directives);
      else if (anchor.kind === 'scenario') Object.assign(anchor.scenario.options, parsed.directives);
      else Object.assign(anchor.step.options, parsed.directives);
      anchorLine = line.number;
    } else {
      diagnostics.push({
        code: 'DIRECTIVE_ORPHAN',
        severity: 'warning',

        message: 'Directive is not directly attached to a step, scenario or spec.',
        location: location(uri, line),
      });
      anchorLine = line.number;
      anchor = null;
    }
    diagnostics.push(...parsed.diagnostics);
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as Line;
    const trimmed = line.text;

    if (fence !== null) {
      if (isFence(trimmed)) fence = null;
      index += 1;
      continue;
    }
    if (isFence(trimmed)) {
      fence = trimmed[0] ?? null;
      index += 1;
      continue;
    }
    if (trimmed === '') {
      index += 1;
      continue;
    }
    if (parseDirectives(line.raw, 'gauge', location(uri, line)) !== null) {
      applyDirective(line);
      index += 1;
      continue;
    }
    if (isSpecHeading(trimmed)) {
      specHeadings += 1;
      if (specHeadings === 1) name = trimmed.slice(1).trim();
      else diagnostics.push(multipleHeading(line));
      anchorLine = line.number;
      anchor = { kind: 'spec' };
      index += 1;
      continue;
    }
    if (isScenarioHeading(trimmed) && phase !== 'teardown') {
      startScenario(trimmed.slice(2).trim(), line);
      anchorLine = line.number;
      index += 1;
      continue;
    }
    if (isTeardown(trimmed)) {
      phase = 'teardown';
      current = null;
      anchorLine = line.number;
      anchor = null;
      index += 1;
      continue;
    }
    if (isTagsLine(trimmed)) {
      const block = readTags(lines, index);
      if (currentPhase() === 'scenario' && currentScenario() !== null) {
        currentScenario()!.tags.push(...block.tags);
        anchor = { kind: 'scenario', scenario: currentScenario()! };
      } else {
        specTags.push(...block.tags);
        anchor = { kind: 'spec' };
      }
      anchorLine = block.lastLine;
      index = block.next;
      continue;
    }
    if (isStep(trimmed)) {
      const block = readStepBlock(lines, index, uri, phase, diagnostics);
      if (currentPhase() === 'teardown') teardown.push(block.raw);
      else if (currentPhase() === 'scenario' && currentScenario() !== null) currentScenario()!.steps.push(block.raw);
      else contexts.push(block.raw);
      anchorLine = block.lastLine;
      anchor = { kind: 'step', step: block.raw };
      index = block.next;
      continue;
    }
    const external = RE_EXTERNAL_TABLE.exec(trimmed);
    if (external !== null && currentPhase() !== 'scenario' && dataTable === undefined) {
      const loaded = loadExternalTable((external[1] ?? '').trim(), location(uri, line), {
        projectRoot,
        reported,
        ...(opts.readFile === undefined ? {} : { readFile: opts.readFile }),
      });
      diagnostics.push(...loaded.diagnostics);
      if (loaded.table !== null) dataTable = loaded.table;
      anchorLine = line.number;
      anchor = null;
      index += 1;
      continue;
    }
    if (parseTableRow(trimmed) !== null) {
      const parsed = parseTableRows(lines, index);
      if (parsed !== null) {
        if (currentPhase() !== 'scenario' && dataTable === undefined) dataTable = parsed.table;
        anchorLine = parsed.lastLine;
        anchor = null;
        index = parsed.next;
        continue;
      }
    }
    if (index + 1 < lines.length) {
      const next = lines[index + 1] as Line;
      if (isUnderlineEq(next.text)) {
        specHeadings += 1;
        if (specHeadings === 1) name = trimmed;
        else diagnostics.push(multipleHeading(line));
        anchorLine = next.number;
        anchor = { kind: 'spec' };
        index += 2;
        continue;
      }
      if (isUnderlineDash(next.text) && phase !== 'teardown') {
        startScenario(trimmed, line);
        anchorLine = next.number;
        index += 2;
        continue;
      }
    }
    index += 1;
  }

  return finish(uri, opts, concepts, {
    name,
    specHeadings,
    specTags,
    specOptions,
    contexts,
    teardown,
    builders,
    dataTable,
    diagnostics,
    projectRoot,
    reported,
  });
}

function finish(uri: string, opts: GaugeParseOptions, concepts: Concept[], state: ParseState): ParseResult {
  const { diagnostics } = state;
  if (state.specHeadings === 0) {
    diagnostics.push({
      code: 'GAUGE_NO_SPEC_HEADING',
      severity: 'error',
      message: 'The spec file has no spec heading.',
      location: { uri, line: 1, column: 1 },
    });
  }

  const expandedContexts = expandConcepts(state.contexts, concepts, diagnostics);
  const expandedTeardown = expandConcepts(state.teardown, concepts, diagnostics);
  const expandedScenarios = state.builders.map((builder) => ({
    builder,
    steps: expandConcepts(builder.steps, concepts, diagnostics),
  }));

  const baseCtx = (dataHeader: string[] | undefined, dataRow: string[] | undefined): ParamContext => ({
    projectRoot: state.projectRoot,
    reported: state.reported,
    ...(opts.readFile === undefined ? {} : { readFile: opts.readFile }),
    ...(dataHeader === undefined ? {} : { dataHeader }),
    ...(dataRow === undefined ? {} : { dataRow }),
  });

  const table = state.dataTable;
  const docCtx = baseCtx(table?.header, table?.rows[0]);
  const contextSteps = expandedContexts.map((step, i) =>
    buildStep(step, `${uri}#context:${i + 1}`, docCtx, diagnostics),
  );
  const teardownSteps = expandedTeardown.map((step, i) =>
    buildStep(step, `${uri}#teardown:${i + 1}`, docCtx, diagnostics),
  );

  const rows: Array<string[] | undefined> =
    table !== undefined && table.rows.length > 0 ? table.rows : [undefined];
  const scenarios: Scenario[] = [];
  for (const { builder, steps } of expandedScenarios) {
    rows.forEach((row, rowIndex) => {
      const base = `${uri}#${slug(builder.name)}`;
      const scenarioId = row === undefined ? base : `${base}[${rowIndex + 1}]`;
      const ctx = baseCtx(table?.header, row);
      let counter = 0;
      const nextId = (): string => {
        counter += 1;
        return `${scenarioId}#${counter}`;
      };
      const all: Step[] = [
        ...expandedContexts.map((step) => buildStep({ ...step, phase: 'context' }, nextId(), ctx, diagnostics)),
        ...steps.map((step) => buildStep({ ...step, phase: 'scenario' }, nextId(), ctx, diagnostics)),
        ...expandedTeardown.map((step) => buildStep({ ...step, phase: 'teardown' }, nextId(), ctx, diagnostics)),
      ];
      scenarios.push({
        id: scenarioId,
        name: builder.name,
        tags: [...builder.tags],
        steps: all,
        ...(row === undefined || table === undefined
          ? {}
          : { dataRow: [...row], dataHeader: [...table.header] }),
        options: builder.options,
        location: builder.location,
      });
    });
  }

  const document: SpecDocument = {
    id: uri,
    name: state.name,
    uri,
    dialect: 'gauge',
    tags: state.specTags,
    options: state.specOptions,
    ...(table === undefined ? {} : { dataTable: table }),
    contexts: contextSteps,
    teardown: teardownSteps,
    scenarios,
    diagnostics,
  };
  return { document, diagnostics };
}

/** Parse Gauge markdown. Never throws (P10). */
export function parseGaugeSpec(text: string, uri: string, opts: GaugeParseOptions = {}): ParseResult {
  try {
    return parseInternal(text, uri, opts);
  } catch (error) {
    const document = emptyDocument(uri);
    document.diagnostics.push({
      code: 'INTERNAL',
      severity: 'error',
      message: `Gauge parser failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { document, diagnostics: document.diagnostics };
  }
}

