import type {
  DataTable,
  Diagnostic,
  ParseResult,
  Scenario,
  SpecDocument,
  Step,
  StepArg,
  StepKind,
  StepOptions,
} from '@ai-bdd/contracts';
import { normalizeStepText, slug } from '@ai-bdd/contracts';

/**
 * The core spec dialect: an unstructured markdown document claimed as a spec by
 * convention. There is no bespoke syntax to learn; a document is read the way a person
 * reads a PRD.
 *
 * | Construct | Becomes |
 * | --- | --- |
 * | `# Heading` | the spec name (the first one wins) |
 * | `## Heading` or deeper | one scenario |
 * | `- [ ] text`, `- text`, `* text`, `1. text` | one step |
 * | prose between headings | the scenario's intent, handed to the actor |
 * | a table directly under a step | that step's table argument |
 * | a table under a section | the scenario's data rows (one instance per row) |
 * | a bullet before the first section | a context step, run before every scenario |
 * | `<!-- ai-bdd: k=v -->` | a directive for the current scenario |
 * | ``` fences | opaque: never scanned for steps |
 *
 * A dialect (Gherkin, Gauge) is an extension: it registers a parser producing the same
 * `SpecDocument`, so the runtime never learns which dialect a file used.
 */
export interface MarkdownParseOptions {
  /** Fence languages whose body is read as spec text rather than code. */
  specFences?: string[];
  /** Treat prose before the first section as spec-level intent (default true). */
  specIntent?: boolean;
  /** Overrides for the kind inference lists. */
  kinds?: { assertionPrefixes?: string[]; assertionVerbs?: string[] };
}

export interface ParsedMarkdown {
  result: ParseResult;
  /** Prose per scenario, keyed by scenario id. */
  intent: Map<string, string>;
  /** Prose before the first section. */
  specIntent: string;
}

interface Line {
  raw: string;
  number: number;
  trimmed: string;
  indent: number;
}

const RE_HEADING = /^(#{1,6})\s+(.*)$/u;
const RE_UL = /^[-*+]\s+(.*)$/u;
const RE_OL = /^\d{1,3}[.)]\s+(.*)$/u;
const RE_CHECKBOX = /^\[([ xX])\]\s+(.*)$/u;
const RE_FENCE = /^(```+|~~~+)\s*(\S*)\s*$/u;
const RE_DIRECTIVE = /^<!--\s*ai-bdd\s*:?\s*(.*?)\s*-->$/u;
const RE_TABLE_ROW = /^\|.*\|$/u;
const RE_SEPARATOR_CELL = /^:?-{2,}:?$/u;

/** Appends a wrapped prose line to the paragraph it belongs to. */
function joinParagraph(target: string[], line: string): void {
  if (target.length === 0) {
    target.push(line);
    return;
  }
  target[target.length - 1] = `${target[target.length - 1]} ${line}`;
}

function splitLines(text: string): Line[] {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.split(/\r\n|\n|\r/u).map((raw, position) => ({
    raw,
    number: position + 1,
    trimmed: raw.trim(),
    indent: raw.length - raw.trimStart().length,
  }));
}

/**
 * The default kind inference for a bullet.
 *
 * A spec is a sequence of things to do and things to expect, so the split is: an
 * expectation reads like a statement about state, everything else is an action. The
 * lists are configurable, and a project can override them through `config.kinds`.
 */
export function inferKind(
  text: string,
  overrides?: { assertionPrefixes?: string[]; assertionVerbs?: string[] },
): { kind: StepKind; source: 'prefix' | 'default' } {
  const normalized = normalizeStepText(text).toLowerCase();
  const padded = ` ${normalized} `;
  const prefixes = overrides?.assertionPrefixes ?? [
    'the ',
    'a ',
    'an ',
    'no ',
    'verify ',
    'check ',
    'expect ',
    'assert ',
    'should ',
    'then ',
    'it ',
  ];
  const verbs = overrides?.assertionVerbs ?? [
    ' reads ',
    ' shows ',
    ' is visible',
    ' is displayed',
    ' appears',
    ' contains ',
    ' equals ',
    ' is shown',
    ' explains ',
    ' is not ',
    ' are ',
    ' looks ',
    ' matches ',
    ' says ',
    ' includes ',
    ' remains ',
  ];
  // An explicit imperative is an assertion on its own: `verify the badge says Pro` and
  // `expect the dialog to appear` need no state verb to be understood as a check.
  const imperatives = ['verify ', 'check ', 'expect ', 'assert ', 'should ', 'then '];
  if (imperatives.some((imperative) => normalized.startsWith(imperative))) {
    return { kind: 'assertion', source: 'prefix' };
  }
  // A statement of state is an assertion when it both opens like a description (`the`,
  // `a`, `no`, `it`) and carries one of the state verbs.
  const startsLike = prefixes.some((prefix) => normalized.startsWith(prefix));
  const hasVerb = verbs.some((verb) => padded.includes(verb));
  if (startsLike && hasVerb) return { kind: 'assertion', source: 'prefix' };
  return { kind: 'action', source: 'default' };
}

function readListItem(trimmed: string): { text: string; checked?: boolean } | undefined {
  const body = RE_UL.exec(trimmed)?.[1] ?? RE_OL.exec(trimmed)?.[1];
  if (body === undefined) return undefined;
  const checkbox = RE_CHECKBOX.exec(body);
  if (checkbox) return { text: checkbox[2]!.trim(), checked: checkbox[1]!.toLowerCase() === 'x' };
  return { text: body.trim() };
}

function readTable(lines: Line[], start: number): { table: DataTable; next: number } {
  const rows: string[][] = [];
  let index = start;
  while (index < lines.length && RE_TABLE_ROW.test(lines[index]!.trimmed)) {
    const cells = lines[index]!.trimmed
      .replace(/^\|/u, '')
      .replace(/\|$/u, '')
      .split('|')
      .map((cell) => cell.trim());
    if (!cells.every((cell) => RE_SEPARATOR_CELL.test(cell))) rows.push(cells);
    index += 1;
  }
  const [header, ...body] = rows;
  return { table: { header: header ?? [], rows: body }, next: index };
}
function parseDirectivePayload(
  payload: string,
  location: { uri: string; line: number; column: number },
  diagnostics: Diagnostic[],
): StepOptions {
  const options: StepOptions = {};
  for (const part of payload.split(/\s+/u)) {
    if (part.length === 0) continue;
    const equals = part.indexOf('=');
    const key = equals === -1 ? part : part.slice(0, equals);
    const value = (equals === -1 ? '' : part.slice(equals + 1)).replace(/^"|"$/gu, '');
    switch (key) {
      case 'kind':
        if (value === 'setup' || value === 'action' || value === 'assertion') options.kind = value;
        else diagnostics.push({ code: 'DIRECTIVE_INVALID_VALUE', severity: 'error', message: `kind must be setup/action/assertion, got "${value}"`, location });
        break;
      case 'actor':
      case 'driver':
        if (value.length > 0) options.driver = value;
        break;
      case 'mode':
        if (value === 'auto' || value === 'check' || value === 'judge' || value === 'both') options.mode = value;
        else diagnostics.push({ code: 'DIRECTIVE_INVALID_VALUE', severity: 'error', message: `mode must be auto/check/judge/both, got "${value}"`, location });
        break;
      case 'threshold': {
        const threshold = Number(value);
        if (Number.isFinite(threshold) && threshold >= 0 && threshold <= 1) options.threshold = threshold;
        else diagnostics.push({ code: 'DIRECTIVE_INVALID_VALUE', severity: 'error', message: `threshold must be between 0 and 1, got "${value}"`, location });
        break;
      }
      case 'tags':
        break;
      default:
        diagnostics.push({ code: 'DIRECTIVE_UNKNOWN_KEY', severity: 'error', message: `unknown directive key "${key}"`, location });
    }
  }
  return options;
}

interface ScenarioDraft {
  scenario: Scenario;
  prose: string[];
}

/**
 * Reads a markdown document as a spec.
 *
 * The parser never throws: anything it cannot read becomes a diagnostic, because the
 * first job of a spec runner is to tell a human what it understood.
 */
export function parseMarkdownSpec(text: string, uri: string, options: MarkdownParseOptions = {}): ParsedMarkdown {
  const diagnostics: Diagnostic[] = [];
  const lines = splitLines(text);
  const intent = new Map<string, string>();
  const drafts: ScenarioDraft[] = [];
  const contexts: Step[] = [];
  let specIntent = '';
  let specName = '';
  let specId = '';
  let current: ScenarioDraft | undefined;
  let stepCount = 0;
  let sawTableForStep = false;

  const locationOf = (line: Line): { uri: string; line: number; column: number } => ({
    uri,
    line: line.number,
    column: line.indent + 1,
  });

  const flushProse = (): void => {
    if (!current) return;
    const prose = current.prose.join('\n').trim();
    if (prose.length > 0) intent.set(current.scenario.id, prose);
    current.prose = [];
  };

  const makeStep = (body: string, line: Line, checked: boolean | undefined): Step => {
    stepCount += 1;
    const inferred = inferKind(body, options.kinds);
    const args: StepArg[] = [];
    void checked;
    void args;
    const owner = current;
    const id = owner ? `${owner.scenario.id}#${owner.scenario.steps.length}` : `context#${contexts.length}`;
    void id;
    return {
      id: owner ? `${owner.scenario.id}#${owner.scenario.steps.length}` : `context#${contexts.length}`,
      text: body,
      normalized: normalizeStepText(body),
      kind: inferred.kind,
      kindSource: inferred.source,
      args: [],
      location: locationOf(line),
      options: {},
      originChain: [],
    };
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = line.trimmed;

    const fence = RE_FENCE.exec(trimmed);
    if (fence) {
      const marker = fence[1]!;
      const language = (fence[2] ?? '').toLowerCase();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trimmed.startsWith(marker)) {
        body.push(lines[index]!.raw);
        index += 1;
      }
      index += 1;
      if ((options.specFences ?? ['spec', 'markdown', 'md', 'bdd']).includes(language)) {
        const nested = parseMarkdownSpec(body.join('\n'), uri, options);
        for (const scenario of nested.result.document.scenarios) {
          if (scenario.name.startsWith(specName) || scenario.steps.length === 0) continue;
          drafts.push({ scenario, prose: [] });
        }
        // A fence body with no headings is a run of steps for the enclosing scope,
        // which is how a PRD embeds an acceptance-criteria block.
        if (nested.result.document.scenarios.length === 0) {
          for (const step of nested.result.document.contexts) {
            if (current) current.scenario.steps.push({ ...step, id: `${current.scenario.id}#${current.scenario.steps.length}` });
            else contexts.push({ ...step, id: `context#${contexts.length}` });
          }
        }
        diagnostics.push(...nested.result.diagnostics.filter((diagnostic) => diagnostic.code !== 'MARKDOWN_NO_TITLE'));
      }
      continue;
    }

    if (trimmed.length === 0) {
      flushProse();
      index += 1;
      continue;
    }

    const directive = RE_DIRECTIVE.exec(trimmed);
    if (directive) {
      const parsed = parseDirectivePayload(directive[1] ?? '', locationOf(line), diagnostics);
      if (current) Object.assign(current.scenario.options, parsed);
      index += 1;
      continue;
    }

    const heading = RE_HEADING.exec(trimmed);
    if (heading) {
      flushProse();
      const depth = heading[1]!.length;
      const title = (heading[2] ?? '').trim();
      if (depth === 1 && specName.length === 0) {
        specName = title;
        specId = `md:${slug(uri.split('/').pop() ?? uri)}`;
        current = undefined;
        index += 1;
        continue;
      }
      const baseId = `${specId}#${slug(title)}`;
      const duplicate = drafts.some((draft) => draft.scenario.name === title);
      if (duplicate) {
        diagnostics.push({
          code: 'MARKDOWN_DUPLICATE_SCENARIO',
          severity: 'warning',
          message: `"${title}" appears more than once; the second instance gets a suffixed id`,
          location: locationOf(line),
        });
      }
      const scenario: Scenario = {
        id: duplicate ? `${baseId}-${drafts.length}` : baseId,
        name: title,
        tags: [],
        steps: [],
        options: {},
        location: locationOf(line),
      };
      current = { scenario, prose: [] };
      drafts.push(current);
      sawTableForStep = false;
      index += 1;
      continue;
    }

    if (RE_TABLE_ROW.test(trimmed)) {
      const { table, next } = readTable(lines, index);
      const scenario = current?.scenario;
      const lastStep = scenario?.steps.at(-1);
      if (lastStep && !sawTableForStep && lastStep.location.line === (lines[index - 1]?.number ?? -1)) {
        lastStep.args.push({ type: 'table', table, location: locationOf(line) });
        sawTableForStep = true;
      } else if (scenario) {
        scenario.dataHeader = table.header;
        const [first, ...rest] = table.rows;
        if (first) scenario.dataRow = first;
        for (const row of rest) {
          if (current) drafts.push({ scenario: { ...scenario, id: `${scenario.id}-${slug(row.join('-'))}`, dataRow: row }, prose: [] });
        }
      }
      index = next;
      continue;
    }

    const item = readListItem(trimmed);
    if (item) {
      const step = makeStep(item.text, line, item.checked);
      if (current) {
        current.scenario.steps.push({ ...step, id: step.id });
        sawTableForStep = false;
      } else {
        contexts.push(step);
      }
      index += 1;
      continue;
    }

    // Consecutive prose lines are one paragraph: a markdown file is usually wrapped,
    // and the actor should receive a sentence, not a column.
    if (current) {
      joinParagraph(current.prose, trimmed);
    } else if (options.specIntent !== false) {
      const lines = specIntent.length === 0 ? [] : [specIntent];
      joinParagraph(lines, trimmed);
      specIntent = lines.join('\n');
    }
    index += 1;
  }

  flushProse();

  if (specName.length === 0) {
    specName = (uri.split('/').pop() ?? uri).replace(/\.md$/u, '');
    specId = `md:${slug(specName)}`;
    diagnostics.push({
      code: 'MARKDOWN_NO_TITLE',
      severity: 'error',
      message: 'the document has no level-1 heading; the file name was used as the spec name',
      location: { uri, line: 1, column: 1 },
    });
  }

  const document: SpecDocument = {
    id: specId,
    name: specName,
    uri,
    dialect: 'markdown',
    tags: [],
    options: {},
    contexts,
    teardown: [],
    scenarios: drafts.map((draft) => draft.scenario),
    diagnostics,
  };
  return { result: { document, diagnostics }, intent, specIntent };
}

export function parseMarkdown(text: string, uri: string, options: MarkdownParseOptions = {}): ParseResult {
  return parseMarkdownSpec(text, uri, options).result;
}
