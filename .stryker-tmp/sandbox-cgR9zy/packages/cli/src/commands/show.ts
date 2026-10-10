// @ts-nocheck
import type { ChunkRef, DocPlan, ExitCode, Feature, Scenario, ScenarioRecording, Step, StepRecording } from '@ai-bdd/sdk/contracts';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import { resolveCreateRecordingStore, withEngine, type Ctx } from '../context.ts';

export interface ShowFlags { json?: boolean | undefined; recordings?: boolean | undefined }

interface Selection {
  plan: DocPlan;
  features: Feature[];
  /** Set when the query named a single scenario. */
  scenarioId?: string;
  wholeDoc: boolean;
}

const KIND_WORD = { given: 'Given', when: 'When', then: 'Then' } as const;

function normalizeDocQuery(q: string): string {
  return q.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Resolves `[id|docUri]` against the plans: docUri, feature id, scenario id, then id prefixes. */
export function selectPlans(plans: readonly DocPlan[], query: string | undefined): Selection[] {
  if (query === undefined || query === '') return plans.map((plan) => ({ plan, features: plan.features, wholeDoc: true }));
  const q = normalizeDocQuery(query);
  const byDoc = plans.filter((p) => p.docUri === q);
  if (byDoc.length > 0) return byDoc.map((plan) => ({ plan, features: plan.features, wholeDoc: true }));

  const out: Selection[] = [];
  for (const plan of plans) {
    for (const f of plan.features) {
      if (f.id === q) out.push({ plan, features: [f], wholeDoc: false });
    }
  }
  if (out.length > 0) return out;
  for (const plan of plans) {
    for (const f of plan.features) {
      const s = f.scenarios.find((x) => x.id === q);
      if (s) out.push({ plan, features: [{ ...f, scenarios: [s] }], scenarioId: s.id, wholeDoc: false });
    }
  }
  if (out.length > 0) return out;
  for (const plan of plans) {
    const features: Feature[] = [];
    for (const f of plan.features) {
      if (f.id.startsWith(q)) features.push(f);
      else {
        const scenarios = f.scenarios.filter((s) => s.id.startsWith(q));
        if (scenarios.length > 0) features.push({ ...f, scenarios });
      }
    }
    if (features.length > 0) out.push({ plan, features, wholeDoc: false });
  }
  if (out.length === 0) throw new AiBddError('SCENARIO_NOT_FOUND', `No document, feature or scenario matches "${query}".`);
  return out;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** `# source: <docUri>:<line> "<quote>"` lines for one set of refs; line derived from the plan's chunk ranges. */
export function sourceLines(plan: DocPlan, refs: readonly ChunkRef[], note = ''): string[] {
  const lines: string[] = [];
  for (const ref of refs) {
    const chunk = plan.chunks.find((c) => c.id === ref.chunkId);
    const line = chunk ? String(chunk.range.startLine) : '?';
    const quote = oneLine(ref.quote ?? chunk?.excerpt ?? '');
    const suffix = `${ref.relation === 'context' ? ' (context)' : ''}${note}`;
    lines.push(`# source: ${plan.docUri}:${line} "${quote}"${suffix}`);
  }
  return lines;
}

function recordingNotes(rec: ScenarioRecording | undefined, frontier: number, index: number, step: Step): string[] {
  if (rec === undefined) return ['# recording: none'];
  const sr: StepRecording | undefined = rec.steps[index];
  if (index >= frontier || sr === undefined) return ['# recording: none (not recorded or invalidated by an earlier change)'];
  if (sr.stepKey !== step.key) return ['# recording: stale'];
  const reasons = sr.fuzzyReasons.length > 0 ? ` (${sr.fuzzyReasons.join(', ')})` : '';
  const notes = [`# determinism: ${sr.determinism}${reasons}`];
  if (sr.act) notes.push(`# replay: ${sr.act.actions.length} action(s)`);
  if (sr.check) notes.push(`# check: ${sr.check.classification}, ${sr.check.predicates.length} predicate(s)`);
  if (sr.stats.healCount > 0) notes.push(`# healed: ${sr.stats.healCount} time(s)`);
  return notes;
}

function frontierOf(rec: ScenarioRecording | undefined, steps: readonly Step[]): number {
  if (rec === undefined) return 0;
  let m = 0;
  while (m < steps.length && rec.steps[m]?.stepKey === steps[m]?.key) m++;
  return m;
}

function renderScenario(plan: DocPlan, s: Scenario, rec: ScenarioRecording | undefined, withRecordings: boolean): string[] {
  const out: string[] = [];
  const state = [s.review, s.driver ? `driver=${s.driver}` : undefined, s.startUrl ? `start=${s.startUrl}` : undefined].filter(Boolean).join(', ');
  if (s.tags.length > 0) out.push(`  ${s.tags.map((t) => (t.startsWith('@') ? t : `@${t}`)).join(' ')}`);
  out.push(`  Scenario: ${s.title}  [${state}]`);
  out.push(`    # id: ${s.id}`);
  for (const l of sourceLines(plan, s.sources)) out.push(`    ${l}`);
  const frontier = frontierOf(rec, s.steps);
  s.steps.forEach((step, i) => {
    out.push(`    ${KIND_WORD[step.kind]} ${step.text}`);
    const own = step.sources.length > 0 ? sourceLines(plan, step.sources) : sourceLines(plan, s.sources, ' [scenario source]');
    if (own.length === 0) own.push('# source: (none)');
    for (const l of own) out.push(`      ${l}`);
    if (step.grounding === 'inferred') out.push('      # inferred step (no verbatim quote)');
    if (step.nature === 'subjective') out.push('      # subjective: judged by the model on every run');
    if (step.fixture) out.push(`      # fixture: ${step.fixture.name} ${JSON.stringify(step.fixture.args)}`);
    else if (step.requiresState === true) out.push('      # requires state: no fixture configured, scenario will be blocked');
    const params = Object.entries(step.params);
    if (params.length > 0) out.push(`      # params: ${params.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`);
    if (withRecordings) for (const n of recordingNotes(rec, frontier, i, step)) out.push(`      ${n}`);
  });
  return out;
}

export function renderSelection(sel: Selection, recs: ReadonlyMap<string, ScenarioRecording>, withRecordings: boolean): string[] {
  const { plan } = sel;
  const out: string[] = [`# ${plan.docUri}`, ''];
  for (const f of sel.features) {
    const flags = [f.review, f.pinned === true ? 'pinned' : undefined].filter(Boolean).join(', ');
    if (f.tags.length > 0) out.push(f.tags.map((t) => (t.startsWith('@') ? t : `@${t}`)).join(' '));
    out.push(`Feature: ${f.title}  [${flags}]`);
    out.push(`  # id: ${f.id}`);
    if (f.story) {
      out.push(`  As a ${f.story.asA}`);
      out.push(`  I want ${f.story.iWant}`);
      if (f.story.soThat) out.push(`  So that ${f.story.soThat}`);
    }
    if (f.description) out.push(`  ${oneLine(f.description)}`);
    for (const l of sourceLines(plan, f.sources)) out.push(`  ${l}`);
    for (const s of f.scenarios) {
      out.push('');
      out.push(...renderScenario(plan, s, recs.get(s.id), withRecordings));
    }
    out.push('');
  }
  if (sel.wholeDoc) {
    if (plan.notTestable.length > 0) {
      out.push('Not testable:');
      for (const n of plan.notTestable) out.push(`  - ${n.chunkId}: ${n.reason}`);
      out.push('');
    }
    if (plan.uncovered.length > 0) {
      out.push('Uncovered:');
      for (const u of plan.uncovered) out.push(`  - ${u}`);
      out.push('');
    }
  }
  return out;
}

export async function runShow(ctx: Ctx, query: string | undefined, flags: ShowFlags): Promise<ExitCode> {
  return withEngine<ExitCode>(ctx, {}, async ({ engine, config }) => {
    const plans = await engine.plans();
    const selections = selectPlans(plans, query);

    const recs = new Map<string, ScenarioRecording>();
    if (flags.recordings === true) {
      const createStore = await resolveCreateRecordingStore(ctx.deps);
      const store = createStore({ dir: config.recordingsDir, mode: 'read-only' });
      const listed = await store.list();
      for (const sel of selections) {
        for (const f of sel.features) {
          for (const s of f.scenarios) {
            const driverIds = listed.filter((e) => e.scenarioId === s.id).map((e) => e.driverId);
            const preferred = s.driver ?? config.defaultDriver;
            const driverId = preferred !== undefined && driverIds.includes(preferred) ? preferred : driverIds[0];
            if (driverId === undefined) continue;
            const rec = await store.load(driverId, s.id);
            if (rec) recs.set(s.id, rec);
          }
        }
      }
    }

    if (flags.json === true) {
      const docs = selections.map((sel) => ({
        docUri: sel.plan.docUri,
        features: sel.features,
        ...(sel.wholeDoc ? { notTestable: sel.plan.notTestable, uncovered: sel.plan.uncovered } : {}),
      }));
      const payload = {
        ...(query === undefined ? {} : { query }),
        docs,
        ...(flags.recordings === true ? { recordings: Object.fromEntries([...recs].sort(([a], [b]) => (a < b ? -1 : 1))) } : {}),
      };
      ctx.out(JSON.stringify(payload, null, 2));
      return 0;
    }

    if (selections.length === 0) {
      ctx.out('No plans found. Run `ai-bdd compile` first.');
      return 0;
    }
    for (const sel of selections) for (const line of renderSelection(sel, recs, flags.recordings === true)) ctx.out(line);
    return 0;
  });
}
