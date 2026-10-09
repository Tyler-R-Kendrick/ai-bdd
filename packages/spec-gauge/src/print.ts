/**
 * Gauge markdown printer.
 *
 * `parseGaugeSpec(printGaugeSpec(doc))` reproduces `doc` modulo locations for
 * specs that have no concept expansion and no spec-level data table. A
 * data-driven spec is printed once per distinct scenario (the instances share
 * a source location) and re-parses to the same set of instances.
 */
import { DIRECTIVE_KEYS, type DataTable, type DirectiveKey, type SpecDocument, type Step, type StepArg, type StepOptions } from '@ai-bdd/contracts';

function directiveValue(key: DirectiveKey, value: StepOptions[DirectiveKey]): string {
  if (key === 'vision') return value === true ? 'on' : 'off';
  if (key === 'invariant') return value === true ? 'true' : 'false';
  const text = String(value);
  return /[\s,]/u.test(text) ? `"${text.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"` : text;
}

interface OptionEntry {
  key: DirectiveKey;
  text: string;
}

function optionEntries(options: Partial<StepOptions>): OptionEntry[] {
  const entries: OptionEntry[] = [];
  for (const key of DIRECTIVE_KEYS) {
    const value = options[key];
    if (value === undefined) continue;
    entries.push({ key, text: directiveValue(key, value) });
  }
  return entries;
}

function commentDirective(options: Partial<StepOptions>): string | null {
  const entries = optionEntries(options);
  if (entries.length === 0) return null;
  return `<!-- ai-bdd: ${entries.map((entry) => `${entry.key}=${entry.text}`).join(' ')} -->`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/gu, '\\|');
}

function pushTable(out: string[], table: DataTable): void {
  out.push(`| ${table.header.map(escapeCell).join(' | ')} |`);
  for (const row of table.rows) out.push(`| ${row.map(escapeCell).join(' | ')} |`);
}

function pushDocString(out: string[], arg: Extract<StepArg, { type: 'docString' }>): void {
  out.push(arg.mediaType === undefined ? '"""' : `"""${arg.mediaType}`);
  if (arg.content.length > 0) out.push(...arg.content.split('\n'));
  out.push('"""');
}

function pushStep(out: string[], step: Step): void {
  out.push(`* ${step.text}`);
  const entries = optionEntries(step.options);
  if (entries.length > 0) {
    out.push('| ai-bdd | value |');
    for (const entry of entries) out.push(`| ${entry.key} | ${entry.text} |`);
  }
  for (const arg of step.args) {
    if (arg.type === 'table') pushTable(out, arg.table);
    else if (arg.type === 'docString') pushDocString(out, arg);
  }
  out.push('');
}

export function printGaugeSpec(doc: SpecDocument): string {
  const out: string[] = [];
  out.push(`# ${doc.name}`);
  if (doc.tags.length > 0) out.push(`Tags: ${doc.tags.join(', ')}`);
  const specDirective = commentDirective(doc.options);
  if (specDirective !== null) out.push(specDirective);
  out.push('');

  for (const step of doc.contexts) pushStep(out, step);
  if (doc.dataTable !== undefined) {
    out.push('');
    pushTable(out, doc.dataTable);
    out.push('');
  }

  const seen = new Set<string>();
  for (const scenario of doc.scenarios) {
    const key = `${scenario.location.line}:${scenario.location.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`## ${scenario.name}`);
    if (scenario.tags.length > 0) out.push(`Tags: ${scenario.tags.join(', ')}`);
    const scenarioDirective = commentDirective(scenario.options);
    if (scenarioDirective !== null) out.push(scenarioDirective);
    out.push('');
    for (const step of scenario.steps) {
      if (step.phase !== undefined && step.phase !== 'scenario') continue;
      pushStep(out, step);
    }
  }

  if (doc.teardown.length > 0) {
    out.push('___');
    for (const step of doc.teardown) pushStep(out, step);
  }
  return out.join('\n');
}
