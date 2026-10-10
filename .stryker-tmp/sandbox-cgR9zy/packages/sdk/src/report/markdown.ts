// @ts-nocheck
import type { DocPlan, Feature, ModelPurpose, RunReport, ScenarioResult, ScenarioStatus, Usage } from '../contracts/index.ts';
import { PURPOSES, STATUS_ORDER, failureInfo, firstFailingStep, healedSteps, isFailing, oneLine, stubOf, worstStatus } from './common.ts';

const EXCERPT_MAX = 80;

/** Make a value safe for a one-line markdown table cell. */
function cell(s: string): string {
  return oneLine(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function inline(s: string): string {
  return oneLine(s);
}

function code(s: string): string {
  const one = oneLine(s);
  const longest = Math.max(0, ...[...one.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = one.startsWith('`') || one.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${one}${pad}${fence}`;
}

function fenced(body: string, lang: string): string[] {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return [`${fence}${lang}`, body.replace(/\n+$/, ''), fence];
}

export function excerptOf(text: string): string {
  const t = oneLine(text);
  const chars = [...t];
  return chars.length <= EXCERPT_MAX ? t : `${chars.slice(0, EXCERPT_MAX - 1).join('')}…`;
}

function shortId(id: string): string {
  const i = id.indexOf('#');
  return i >= 0 ? id.slice(i + 1) : id;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const out = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const r of rows) out.push(`| ${r.join(' | ')} |`);
  return out;
}

function usageRow(label: string, u: Usage | undefined): string[] {
  return [label, String(u?.modelCalls ?? 0), String(u?.inputTokens ?? 0), String(u?.outputTokens ?? 0)];
}

// ───────────────────────── traceability

type RowStatus = ScenarioStatus | 'not run' | 'no scenarios';

interface MatrixRow {
  sectionId: string;
  chunkId: string;
  excerpt: string;
  scenarioIds: string[];
  status: RowStatus;
}

interface ChunkInfo { excerpt: string; order: number }

function stripPart(sectionId: string): string {
  return sectionId.replace(/\/part-\d+$/, '');
}

/** Pick the section a chunk belongs to: longest heading-path prefix, preferring the section its feature was extracted from. */
function sectionFor(chunkId: string, sectionIds: readonly string[], preferred: ReadonlySet<string>): string | undefined {
  let bestBase = -1;
  let candidates: string[] = [];
  for (const sid of sectionIds) {
    const base = stripPart(sid);
    if (chunkId === base || chunkId.startsWith(`${base}/`)) {
      if (base.length > bestBase) {
        bestBase = base.length;
        candidates = [sid];
      } else if (base.length === bestBase) {
        candidates.push(sid);
      }
    }
  }
  if (candidates.length > 0) return candidates.find((c) => preferred.has(c)) ?? candidates[0];
  for (const p of preferred) if (sectionIds.includes(p)) return p;
  return undefined;
}

interface ChunkUse { scenarios: string[]; sectionHints: Set<string> }

function collectUses(plan: DocPlan): Map<string, ChunkUse> {
  const uses = new Map<string, ChunkUse>();
  const touch = (chunkId: string): ChunkUse => {
    let u = uses.get(chunkId);
    if (u === undefined) {
      u = { scenarios: [], sectionHints: new Set() };
      uses.set(chunkId, u);
    }
    return u;
  };
  for (const f of plan.features ?? []) {
    if (f.review === 'rejected') continue;
    for (const ref of f.sources ?? []) {
      if (ref.relation === 'source') touch(ref.chunkId).sectionHints.add(f.sectionId);
    }
    for (const sc of f.scenarios ?? []) {
      if (sc.review === 'rejected') continue;
      const refs = [...(sc.sources ?? []), ...(sc.steps ?? []).flatMap((st) => st.sources ?? [])];
      for (const ref of refs) {
        if (ref.relation !== 'source') continue;
        const u = touch(ref.chunkId);
        u.sectionHints.add(f.sectionId);
        if (!u.scenarios.includes(sc.id)) u.scenarios.push(sc.id);
      }
    }
  }
  return uses;
}

function rowStatus(ids: readonly string[], results: ReadonlyMap<string, ScenarioResult>): RowStatus {
  if (ids.length === 0) return 'no scenarios';
  const found = ids.map((id) => results.get(id)?.status).filter((s): s is ScenarioStatus => s !== undefined);
  return worstStatus(found) ?? 'not run';
}

function buildRows(plan: DocPlan, results: ReadonlyMap<string, ScenarioResult>): MatrixRow[] {
  const chunkInfo = new Map<string, ChunkInfo>();
  (plan.chunks ?? []).forEach((c, i) => chunkInfo.set(c.id, { excerpt: c.excerpt, order: i }));
  const sectionIds = (plan.sections ?? []).map((s) => s.id);
  const sectionOrder = new Map(sectionIds.map((id, i) => [id, i] as const));
  const scenarioOrder = new Map<string, number>();
  let n = 0;
  for (const f of plan.features ?? []) for (const sc of f.scenarios ?? []) scenarioOrder.set(sc.id, n++);

  const rows: (MatrixRow & { sectionIdx: number; chunkIdx: number })[] = [];
  for (const [chunkId, use] of collectUses(plan)) {
    const info = chunkInfo.get(chunkId);
    const sectionId = sectionFor(chunkId, sectionIds, use.sectionHints) ?? '(unsectioned)';
    const ids = [...use.scenarios].sort((a, b) => (scenarioOrder.get(a) ?? 0) - (scenarioOrder.get(b) ?? 0));
    rows.push({
      sectionId,
      chunkId,
      excerpt: info !== undefined ? excerptOf(info.excerpt) : `(chunk not in plan: ${shortId(chunkId)})`,
      scenarioIds: ids,
      status: rowStatus(ids, results),
      sectionIdx: sectionOrder.get(sectionId) ?? Number.MAX_SAFE_INTEGER,
      chunkIdx: info?.order ?? Number.MAX_SAFE_INTEGER,
    });
  }
  rows.sort((a, b) => a.sectionIdx - b.sectionIdx || a.chunkIdx - b.chunkIdx || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0));
  return rows;
}

function chunkLine(chunkId: string, plan: DocPlan | undefined, reason?: string): string {
  const excerpt = plan?.chunks?.find((c) => c.id === chunkId)?.excerpt;
  const parts = [`- ${code(shortId(chunkId))}`];
  if (excerpt !== undefined) parts.push(excerptOf(excerpt));
  if (reason !== undefined) parts.push(`— ${inline(reason)}`);
  return parts.join(' ');
}

function orderChunkIds(ids: readonly string[], plan: DocPlan | undefined): string[] {
  const order = new Map((plan?.chunks ?? []).map((c, i) => [c.id, i] as const));
  return [...ids].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) || (a < b ? -1 : a > b ? 1 : 0));
}

function docSection(docUri: string, plan: DocPlan | undefined, report: RunReport, results: ReadonlyMap<string, ScenarioResult>): string[] {
  const cov = (report.coverage?.docs ?? []).find((d) => d.docUri === docUri);
  const out: string[] = [`### ${code(docUri)}`, ''];
  if (cov !== undefined) {
    out.push(`Coverage: ${cov.covered} of ${cov.chunks} chunks covered, ${cov.uncovered.length} uncovered, ${cov.notTestable.length} not testable.`);
  } else if (plan !== undefined) {
    out.push(`Coverage: not reported for this run (plan lists ${plan.uncovered.length} uncovered, ${plan.notTestable.length} not testable).`);
  }
  out.push('');
  if (plan === undefined) {
    out.push('_No plan was supplied for this document, so scenario traceability is unavailable._', '');
  } else {
    const rows = buildRows(plan, results);
    if (rows.length === 0) {
      out.push('_No scenarios cite chunks of this document._', '');
    } else {
      out.push(
        ...table(
          ['Section', 'Chunk', 'Scenarios', 'Status'],
          rows.map((r) => [
            code(shortId(r.sectionId)),
            cell(r.excerpt),
            r.scenarioIds.length === 0 ? '—' : r.scenarioIds.map((id) => code(id)).join(', '),
            r.status,
          ]),
        ),
        '',
      );
    }
  }
  const uncovered = cov?.uncovered ?? plan?.uncovered ?? [];
  out.push(`**Uncovered chunks (${uncovered.length})**`, '');
  if (uncovered.length === 0) out.push('None.');
  else for (const id of orderChunkIds(uncovered, plan)) out.push(chunkLine(id, plan));
  out.push('');
  const reasons = new Map((plan?.notTestable ?? []).map((n) => [n.chunkId, n.reason] as const));
  const notTestable = cov?.notTestable ?? (plan?.notTestable ?? []).map((n) => n.chunkId);
  out.push(`**Not testable (${notTestable.length})**`, '');
  if (notTestable.length === 0) out.push('None.');
  else for (const id of orderChunkIds(notTestable, plan)) out.push(chunkLine(id, plan, reasons.get(id)));
  out.push('');
  return out;
}

// ───────────────────────── whole report

function failuresSection(report: RunReport): string[] {
  const failing = report.scenarios.filter((s) => isFailing(s.status));
  const out = ['## Failures', ''];
  if (failing.length === 0) return [...out, 'None.', ''];
  for (const sc of failing) {
    const info = failureInfo(sc);
    out.push(`### ${code(sc.scenarioId)} — ${sc.status}`, '');
    out.push(`- Title: ${inline(sc.title)}`);
    out.push(`- Error: ${code(info.code)} ${inline(info.message)}`);
    const first = firstFailingStep(sc);
    if (first !== undefined) {
      const err = first.step.error;
      out.push(`- First failing step: #${first.index + 1} ${code(first.step.kind)} ${inline(first.step.text)} — ${first.step.status}${err !== undefined ? `, ${code(err.code)}` : ''}`);
      const stub = stubOf(err?.details);
      if (stub !== undefined) out.push('', 'Fixture stub:', '', ...fenced(stub, 'ts'));
    } else {
      out.push('- First failing step: none (scenario-level failure)');
    }
    out.push('');
  }
  return out;
}

function healedSection(report: RunReport): string[] {
  const out = ['## Healed', ''];
  const items: string[] = [];
  for (const sc of report.scenarios) {
    for (const st of healedSteps(sc)) {
      const idx = sc.steps.indexOf(st) + 1;
      items.push(`- ${code(sc.scenarioId)} step #${idx} ${code(st.kind)} ${inline(st.text)}`);
    }
  }
  if (items.length === 0) return [...out, 'None.', ''];
  return [...out, 'These steps passed only after the recorded replay diverged. Review the app or the recording.', '', ...items, ''];
}

function fuzzySection(report: RunReport): string[] {
  const out = ['## Fuzzy steps', ''];
  const rows: string[][] = [];
  for (const sc of report.scenarios) {
    sc.steps.forEach((st, i) => {
      if (st.determinism !== 'fuzzy' && (st.fuzzyReasons ?? []).length === 0) return;
      const reasons = (st.fuzzyReasons ?? []).length === 0 ? 'unspecified' : st.fuzzyReasons.join(', ');
      rows.push([code(sc.scenarioId), String(i + 1), `${st.kind} ${cell(st.text)}`, st.path, cell(reasons)]);
    });
  }
  if (rows.length === 0) return [...out, 'None.', ''];
  return [...out, 'These steps are not deterministic and keep running through the agent or the judge.', '', ...table(['Scenario', 'Step', 'Text', 'Path', 'Reasons'], rows), ''];
}

function unreviewedSection(report: RunReport): string[] {
  const out = ['## Unreviewed scenarios that ran', ''];
  const items = report.scenarios.filter((s) => s.review === 'unreviewed');
  if (items.length === 0) return [...out, 'None.', ''];
  return [
    ...out,
    'These scenarios were extracted by a model and have not been accepted by a reviewer.',
    '',
    ...items.map((s) => `- ${code(s.scenarioId)} — ${s.status}`),
    '',
  ];
}

function usageSection(report: RunReport): string[] {
  const u = report.usage;
  const rows = PURPOSES.map((p: ModelPurpose) => usageRow(p, u?.byPurpose?.[p]));
  rows.push(usageRow('total', u));
  const out = ['## Usage', '', ...table(['Purpose', 'Model calls', 'Input tokens', 'Output tokens'], rows), ''];
  if (u?.estimatedCostUsd !== undefined) out.push(`Estimated cost: $${u.estimatedCostUsd.toFixed(4)} USD`, '');
  return out;
}

function warningsSection(report: RunReport): string[] {
  const ws = report.warnings ?? [];
  if (ws.length === 0) return [];
  return ['## Warnings', '', ...ws.map((w) => `- ${code(w.code)} (${w.severity})${w.uri !== undefined ? ` ${code(w.uri)}` : ''} ${inline(w.message)}`), ''];
}

function traceabilitySection(report: RunReport, plans: readonly DocPlan[]): string[] {
  const results = new Map(report.scenarios.map((s) => [s.scenarioId, s] as const));
  const planByUri = new Map(plans.map((p) => [p.docUri, p] as const));
  const uris = [...new Set([...planByUri.keys(), ...(report.coverage?.docs ?? []).map((d) => d.docUri)])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out = ['## Traceability', ''];
  if (uris.length === 0) out.push('_No documents._', '');
  for (const uri of uris) out.push(...docSection(uri, planByUri.get(uri), report, results));
  const known = new Set<string>();
  for (const p of plans) for (const f of p.features ?? ([] as Feature[])) for (const sc of f.scenarios ?? []) known.add(sc.id);
  const stray = report.scenarios.filter((s) => !known.has(s.scenarioId));
  if (stray.length > 0) {
    out.push('### Scenarios not found in the supplied plans', '', ...stray.map((s) => `- ${code(s.scenarioId)} — ${s.status} (${code(s.docUri)})`), '');
  }
  return out;
}

export function renderMarkdown(report: RunReport, plans: readonly DocPlan[]): string {
  const lines: string[] = ['# ai-bdd run summary', ''];
  lines.push(`- Run: ${code(report.runId)}`);
  lines.push(`- Started: ${inline(report.startedAt)}`);
  lines.push(`- Finished: ${inline(report.finishedAt)}`);
  lines.push(`- Exit code: ${report.exitCode}`);
  const o = report.options;
  if (o !== undefined) {
    lines.push(
      `- Options: frozen=${o.frozen}, strict=${o.strict}, audit=${o.audit}, noAgent=${o.noAgent}, updateRecordings=${o.updateRecordings}, recordings=${o.recordingsMode}, workers=${o.workers}`,
    );
  }
  lines.push('', '## Totals', '');
  lines.push(...table(['Status', 'Scenarios'], [...STATUS_ORDER.map((s) => [s, String(report.totals?.[s] ?? 0)]), ['total', String(report.scenarios.length)]]), '');
  lines.push(...failuresSection(report));
  lines.push(...healedSection(report));
  lines.push(...fuzzySection(report));
  lines.push(...unreviewedSection(report));
  lines.push(...traceabilitySection(report, plans));
  lines.push(...usageSection(report));
  lines.push(...warningsSection(report));
  while (lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}
