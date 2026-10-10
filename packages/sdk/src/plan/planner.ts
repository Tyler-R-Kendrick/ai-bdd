import {
  AiBddError,
  type Chunk,
  type ChunkedDoc,
  type ChunkRef,
  type CreatePlanner,
  type Diagnostic,
  type DocPlan,
  type DocStatus,
  type DraftFeature,
  type DraftRef,
  type DraftScenario,
  type DraftStep,
  type ExtractionResult,
  type Feature,
  type Planner,
  type ReviewState,
  type Scenario,
  type Section,
  type Step,
  type StepKind,
} from '../contracts/index.ts';
import { canonicalJson, normalizeForQuote, sha256Hex, slugify } from '../util/index.ts';
import { type Matchable, reconcile, tokenize } from './match.ts';
import { type DocIndex, computeDirty, forEachRef, hasStaleSources, indexDoc, isContext, isIgnored, resolveRef } from './refs.ts';

const NO_HASH = '0'.repeat(64);
const EXCERPT_CHARS = 80;
export const FUZZY_TAG = '@fuzzy';

// ───────────────────────── ids and fingerprints (§8.1, §8.2)

export function scenarioFingerprint(title: string, steps: readonly { kind: StepKind; text: string }[]): string {
  return sha256Hex(canonicalJson({ t: normalizeForQuote(title), s: steps.map((s) => [s.kind, normalizeForQuote(s.text)]) }));
}

export function featureFingerprint(title: string, scenarioFingerprints: readonly string[]): string {
  return sha256Hex(canonicalJson({ t: normalizeForQuote(title), s: [...scenarioFingerprints] }));
}

export function stepKey(kind: StepKind, text: string): string {
  return `${kind}:${sha256Hex(normalizeForQuote(text)).slice(0, 12)}`;
}

function featureIdBase(docUri: string, title: string): string {
  return `${slugify(docUri.replace(/\.[^./]+$/, ''), 48)}--${slugify(title, 48)}`;
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
  used.add(id);
  return id;
}

function recomputedFeatureFp(f: Feature): string {
  return featureFingerprint(f.title, f.scenarios.map((s) => scenarioFingerprint(s.title, s.steps)));
}

// ───────────────────────── draft bodies (everything except ids)

interface ScenarioBody {
  title: string;
  tags: string[];
  sources: ChunkRef[];
  steps: Step[];
  driver?: string;
  startUrl?: string;
  fingerprint: string;
  match: Matchable;
}

interface FeatureBody {
  title: string;
  story?: DraftFeature['story'];
  description?: string;
  tags: string[];
  sources: ChunkRef[];
  scenarios: ScenarioBody[];
  fingerprint: string;
  match: Matchable;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function toRef(d: DraftRef, idx: DocIndex): ChunkRef | null {
  const c = idx.byId.get(d.chunkId);
  if (c === undefined) return null;
  const ref: ChunkRef = { chunkId: c.id, hash: c.hash, relation: d.relation };
  if (d.quote !== undefined) ref.quote = d.quote;
  return ref;
}

function toRefs(ds: readonly DraftRef[], idx: DocIndex): ChunkRef[] {
  const out: ChunkRef[] = [];
  for (const d of ds) {
    const r = toRef(d, idx);
    if (r !== null) out.push(r);
  }
  return out;
}

function buildSteps(drafts: readonly DraftStep[], idx: DocIndex): Step[] {
  const seen = new Map<string, number>();
  return drafts.map((d) => {
    const base = stepKey(d.kind, d.text);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const step: Step = {
      key: n === 1 ? base : `${base}#${n}`,
      kind: d.kind,
      text: d.text,
      grounding: d.grounding,
      sources: toRefs(d.sources, idx),
      params: { ...d.params },
    };
    if (d.nature !== undefined && d.kind === 'then') step.nature = d.nature;
    if (d.requiresState !== undefined && d.kind === 'given') step.requiresState = d.requiresState;
    if (d.fixture !== undefined) step.fixture = { name: d.fixture.name, args: { ...d.fixture.args } };
    return step;
  });
}

/** §8.4 step 6: directives of the source chunks flow into the scenario. */
function applyDirectives(
  refs: readonly ChunkRef[],
  idx: DocIndex,
): { tags: string[]; driver?: string; startUrl?: string; fuzzy: boolean } {
  const out: { tags: string[]; driver?: string; startUrl?: string; fuzzy: boolean } = { tags: [], fuzzy: false };
  for (const ref of refs) {
    if (ref.relation !== 'source') continue;
    const d = idx.byId.get(ref.chunkId)?.directives;
    if (d === undefined) continue;
    if (d.driver !== undefined && out.driver === undefined) out.driver = d.driver;
    if (d.start !== undefined && out.startUrl === undefined) out.startUrl = d.start;
    if (d.tags !== undefined) out.tags.push(...d.tags);
    if (d.fuzzy === true) out.fuzzy = true;
  }
  return out;
}

function matchable(fingerprint: string, title: string, stepTexts: readonly string[]): Matchable {
  return { fingerprint, titleNorm: normalizeForQuote(title), tokens: tokenize(title, ...stepTexts) };
}

function buildScenarioBody(d: DraftScenario, featureSources: readonly ChunkRef[], idx: DocIndex): ScenarioBody {
  const sources = toRefs(d.sources, idx);
  const steps = buildSteps(d.steps, idx);
  let dirRefs: ChunkRef[] = [...sources, ...steps.flatMap((s) => s.sources)];
  if (!dirRefs.some((r) => r.relation === 'source')) dirRefs = [...featureSources];
  const dir = applyDirectives(dirRefs, idx);
  const tags = dedupe([...d.tags, ...dir.tags, ...(dir.fuzzy ? [FUZZY_TAG] : [])]);
  const fingerprint = scenarioFingerprint(d.title, d.steps);
  const body: ScenarioBody = {
    title: d.title,
    tags,
    sources,
    steps,
    fingerprint,
    match: matchable(
      fingerprint,
      d.title,
      d.steps.map((s) => s.text),
    ),
  };
  if (dir.driver !== undefined) body.driver = dir.driver;
  if (dir.startUrl !== undefined) body.startUrl = dir.startUrl;
  return body;
}

function buildFeatureBody(d: DraftFeature, rejected: ReadonlySet<string>, idx: DocIndex): FeatureBody | null {
  const sources = toRefs(d.sources, idx);
  if (!sources.some((r) => r.relation === 'source')) return null;
  const scenarios = d.scenarios
    .map((s) => buildScenarioBody(s, sources, idx))
    .filter((s) => !rejected.has(s.fingerprint));
  if (d.scenarios.length > 0 && scenarios.length === 0) return null; // everything it proposed was rejected (R-EX5)
  const dir = applyDirectives(sources, idx);
  const fingerprint = featureFingerprint(
    d.title,
    scenarios.map((s) => s.fingerprint),
  );
  const body: FeatureBody = {
    title: d.title,
    tags: dedupe([...d.tags, ...dir.tags]),
    sources,
    scenarios,
    fingerprint,
    match: matchable(
      fingerprint,
      d.title,
      d.scenarios.flatMap((s) => s.steps.map((st) => st.text)),
    ),
  };
  if (d.story !== undefined) body.story = { ...d.story };
  if (d.description !== undefined) body.description = d.description;
  return body;
}

function prevFeatureMatch(f: Feature): Matchable {
  return matchable(
    recomputedFeatureFp(f),
    f.title,
    f.scenarios.flatMap((s) => s.steps.map((st) => st.text)),
  );
}

function prevScenarioMatch(s: Scenario): Matchable {
  return matchable(
    scenarioFingerprint(s.title, s.steps),
    s.title,
    s.steps.map((st) => st.text),
  );
}

// ───────────────────────── relocation of kept features

interface RelocateResult {
  feature: Feature;
  contextChanged: string[];
}

function relocateRef(ref: ChunkRef, idx: DocIndex, changed: Set<string>): ChunkRef | null {
  const r = resolveRef(ref, idx);
  if (r.kind === 'same') return ref;
  if (r.kind === 'moved') return { ...ref, chunkId: r.chunk.id };
  if (ref.relation === 'source') return ref;
  // context refs never make a section dirty; they are refreshed and reported (PLAN_CONTEXT_CHANGED).
  changed.add(ref.chunkId);
  const cur = idx.byId.get(ref.chunkId);
  if (cur === undefined || isIgnored(cur)) return null;
  return { ...ref, hash: cur.hash };
}

function relocateRefs(refs: readonly ChunkRef[], idx: DocIndex, changed: Set<string>): ChunkRef[] {
  const out: ChunkRef[] = [];
  for (const r of refs) {
    const n = relocateRef(r, idx, changed);
    if (n !== null) out.push(n);
  }
  return out;
}

/** Keeps a feature verbatim apart from relocated (moved) refs. */
function relocateFeature(f: Feature, idx: DocIndex): RelocateResult {
  const changed = new Set<string>();
  const feature: Feature = {
    ...f,
    sources: relocateRefs(f.sources, idx, changed),
    scenarios: f.scenarios.map((s) => ({
      ...s,
      sources: relocateRefs(s.sources, idx, changed),
      steps: s.steps.map((st) => ({ ...st, sources: relocateRefs(st.sources, idx, changed) })),
    })),
  };
  return { feature, contextChanged: [...changed].sort() };
}

// ───────────────────────── ordering and coverage

function firstSourceIndex(f: Feature, idx: DocIndex): number {
  let best = Number.POSITIVE_INFINITY;
  const consider = (ref: ChunkRef): void => {
    if (ref.relation !== 'source') return;
    const i = idx.order.get(ref.chunkId);
    if (i !== undefined && i < best) best = i;
  };
  f.sources.forEach(consider);
  if (best === Number.POSITIVE_INFINITY) forEachRef(f, consider);
  return best;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function computeUncovered(idx: DocIndex, features: readonly Feature[], notTestable: ReadonlySet<string>): string[] {
  const covered = new Set<string>();
  const add = (refs: readonly ChunkRef[]): void => {
    for (const r of refs) if (r.relation === 'source') covered.add(r.chunkId);
  };
  for (const f of features) {
    if (f.review === 'rejected') continue;
    add(f.sources);
    for (const s of f.scenarios) {
      if (s.review === 'rejected') continue;
      add(s.sources);
      for (const st of s.steps) add(st.sources);
    }
  }
  return idx.doc.chunks
    .filter((c) => c.kind !== 'heading' && !isIgnored(c) && !isContext(idx, c) && !covered.has(c.id) && !notTestable.has(c.id))
    .map((c) => c.id);
}

function semanticKey(f: Feature): string {
  return canonicalJson({
    fp: f.fingerprint,
    t: f.title,
    d: f.description ?? null,
    st: f.story === undefined ? null : { a: f.story.asA, i: f.story.iWant, s: f.story.soThat ?? null },
    tags: f.tags,
  });
}

function scenarioKey(s: Scenario): string {
  return canonicalJson({ fp: s.fingerprint, t: s.title, tags: s.tags, d: s.driver ?? null, u: s.startUrl ?? null });
}

// ───────────────────────── planner

function diag(code: Diagnostic['code'], severity: Diagnostic['severity'], message: string, uri: string, details?: Diagnostic['details']): Diagnostic {
  const d: Diagnostic = { code, severity, message, uri };
  if (details !== undefined) d.details = details;
  return d;
}

type SectionMode = 'extract' | 'keep' | 'failed';

interface Slot {
  section: Section;
  body: FeatureBody;
  prev: Feature | undefined;
}

export const createPlanner: CreatePlanner = (): Planner => {
  const planner: Planner = {
    dirtySections(doc, previous, opts) {
      return computeDirty(doc, previous, opts.full, indexDoc(doc));
    },

    merge(doc, previous, extracted, meta) {
      const idx = indexDoc(doc);
      const docUri = doc.doc.uri;
      const diagnostics: Diagnostic[] = [];
      const dirtySet = new Set(computeDirty(doc, previous, false, idx));
      const rejectedList = previous?.rejected ?? [];
      const rejectedFps = new Set(rejectedList.map((r) => r.fingerprint));
      const prevFeatures = previous?.features ?? [];
      const sectionIds = new Set(doc.sections.map((s) => s.id));

      // Section modes (document order; the `extracted` map is only ever read with `get`).
      const modes = new Map<string, SectionMode>();
      const results = new Map<string, ExtractionResult>();
      for (const s of doc.sections) {
        const res = extracted.get(s.id);
        if (res !== undefined && !res.failed) {
          modes.set(s.id, 'extract');
          results.set(s.id, res);
        } else if (res !== undefined || dirtySet.has(s.id)) {
          modes.set(s.id, 'failed');
          diagnostics.push(
            diag('EXTRACT_SECTION_FAILED', 'warning', `section ${s.id} was not extracted; previous features are kept`, docUri, { sectionId: s.id }),
          );
        } else {
          modes.set(s.id, 'keep');
        }
      }

      const kept: Feature[] = [];
      const slots: Slot[] = [];

      const keepFeature = (f: Feature, sectionId: string): void => {
        const r = relocateFeature(f, idx);
        if (r.contextChanged.length > 0) {
          diagnostics.push(
            diag('PLAN_CONTEXT_CHANGED', 'warning', `context chunks changed for feature ${f.id}`, docUri, { featureId: f.id, chunkIds: r.contextChanged }),
          );
        }
        kept.push({ ...r.feature, sectionId });
      };

      // Pinned features are never overwritten (R-PL3), whatever happened to their section.
      for (const f of prevFeatures) {
        if (f.pinned !== true) continue;
        let sectionId = f.sectionId;
        if (!sectionIds.has(sectionId)) {
          let rehomed: string | undefined;
          forEachRef(f, (ref) => {
            if (rehomed !== undefined || ref.relation !== 'source') return;
            const r = resolveRef(ref, idx);
            const target = r.kind === 'same' ? idx.byId.get(ref.chunkId) : r.kind === 'moved' ? r.chunk : undefined;
            if (target !== undefined && sectionIds.has(target.sectionId)) rehomed = target.sectionId;
          });
          if (rehomed !== undefined) sectionId = rehomed;
        }
        keepFeature(f, sectionId);
        if (hasStaleSources(f, idx)) {
          diagnostics.push(diag('PLAN_PINNED_STALE', 'warning', `pinned feature ${f.id} has changed sources`, docUri, { featureId: f.id }));
        }
      }

      const prevBySection = new Map<string, Feature[]>();
      for (const f of prevFeatures) {
        if (f.pinned === true) continue;
        const a = prevBySection.get(f.sectionId);
        if (a === undefined) prevBySection.set(f.sectionId, [f]);
        else a.push(f);
      }

      for (const section of doc.sections) {
        const mode = modes.get(section.id);
        const prevHere = prevBySection.get(section.id) ?? [];
        if (mode !== 'extract') {
          for (const f of prevHere) keepFeature(f, section.id);
          continue;
        }
        const res = results.get(section.id) as ExtractionResult;
        const bodies: FeatureBody[] = [];
        for (const d of res.drafts) {
          const b = buildFeatureBody(d, rejectedFps, idx);
          if (b !== null) bodies.push(b);
        }
        // Drafts that reconcile to a pinned feature are discarded (the pinned feature stays verbatim).
        const pinnedHere = prevFeatures.filter((f) => f.pinned === true && f.sectionId === section.id);
        const toPinned = reconcile(
          bodies.map((b) => b.match),
          pinnedHere.map(prevFeatureMatch),
        );
        const live = bodies.filter((_, i) => !toPinned.has(i));
        const matches = reconcile(
          live.map((b) => b.match),
          prevHere.map(prevFeatureMatch),
        );
        live.forEach((body, i) => {
          const p = matches.get(i);
          slots.push({ section, body, prev: p === undefined ? undefined : prevHere[p] });
        });
      }

      // Assign ids. Inherited ids are reserved first so fresh ids never steal them.
      const usedFeatureIds = new Set<string>([...kept.map((f) => f.id), ...slots.flatMap((s) => (s.prev === undefined ? [] : [s.prev.id]))]);
      const built: Feature[] = [];
      for (const slot of slots) {
        const { body, prev, section } = slot;
        const id = prev?.id ?? uniqueId(featureIdBase(docUri, body.title), usedFeatureIds);
        const prevScenarios = prev?.scenarios ?? [];
        const sm = reconcile(
          body.scenarios.map((s) => s.match),
          prevScenarios.map(prevScenarioMatch),
        );
        const usedScenarioIds = new Set<string>();
        for (const [, p] of sm) usedScenarioIds.add((prevScenarios[p] as Scenario).id);
        const scenarios: Scenario[] = body.scenarios.map((sb, i) => {
          const p = sm.get(i);
          const pv = p === undefined ? undefined : (prevScenarios[p] as Scenario);
          const scenarioId = pv?.id ?? uniqueId(`${id}/${slugify(sb.title, 48)}`, usedScenarioIds);
          const review: ReviewState = pv !== undefined && scenarioFingerprint(pv.title, pv.steps) === sb.fingerprint ? pv.review : 'unreviewed';
          const sc: Scenario = {
            id: scenarioId,
            featureId: id,
            title: sb.title,
            tags: sb.tags,
            sources: sb.sources,
            steps: sb.steps,
            review,
            fingerprint: sb.fingerprint,
          };
          if (sb.driver !== undefined) sc.driver = sb.driver;
          if (sb.startUrl !== undefined) sc.startUrl = sb.startUrl;
          return sc;
        });
        const review: ReviewState = prev !== undefined && recomputedFeatureFp(prev) === body.fingerprint ? prev.review : 'unreviewed';
        const feature: Feature = {
          id,
          docUri,
          sectionId: section.id,
          title: body.title,
          tags: body.tags,
          sources: body.sources,
          scenarios,
          review,
          fingerprint: body.fingerprint,
        };
        if (body.story !== undefined) feature.story = body.story;
        if (body.description !== undefined) feature.description = body.description;
        built.push(feature);
      }

      const features = [...kept, ...built]
        .map((f) => ({ f, i: firstSourceIndex(f, idx) }))
        .sort((a, b) => (a.i === b.i ? 0 : a.i < b.i ? -1 : 1) || cmp(a.f.title, b.f.title) || cmp(a.f.id, b.f.id))
        .map((x) => x.f);

      // notTestable: replace entries of re-extracted sections, relocate the rest.
      const extractedSections = new Set(results.keys());
      const prevChunkHash = new Map((previous?.chunks ?? []).map((c) => [c.id, c.hash]));
      const nt = new Map<string, string>();
      for (const e of previous?.notTestable ?? []) {
        const cur = idx.byId.get(e.chunkId);
        const oldHash = prevChunkHash.get(e.chunkId);
        let target: Chunk | undefined;
        if (cur !== undefined && (oldHash === undefined || cur.hash === oldHash)) target = cur;
        else if (oldHash !== undefined) {
          const cands = idx.contextByHash.get(oldHash) ?? [];
          target = cands.length === 1 ? cands[0] : cur;
        } else target = cur;
        if (target === undefined || extractedSections.has(target.sectionId)) continue;
        if (!nt.has(target.id)) nt.set(target.id, e.reason);
      }
      for (const s of doc.sections) {
        const res = results.get(s.id);
        if (res === undefined) continue;
        for (const e of res.notTestable) if (idx.byId.has(e.chunkId) && !nt.has(e.chunkId)) nt.set(e.chunkId, e.reason);
      }
      const notTestable = [...nt]
        .sort((a, b) => (idx.order.get(a[0]) ?? 0) - (idx.order.get(b[0]) ?? 0))
        .map(([chunkId, reason]) => ({ chunkId, reason }));

      const anyExtracted = results.size > 0;
      const plan: DocPlan = {
        schemaVersion: 1,
        docUri,
        docSha256: doc.doc.sha256,
        extractor: anyExtracted || previous === null ? { modelId: meta.extractor.modelId, promptVersion: meta.extractor.promptVersion } : previous.extractor,
        sections: doc.sections.map((s) => {
          if (modes.get(s.id) !== 'failed') return { id: s.id, hash: s.hash };
          const prevHash = previous?.sections.find((p) => p.id === s.id)?.hash;
          return { id: s.id, hash: prevHash ?? NO_HASH, failed: true };
        }),
        chunks: doc.chunks
          .filter((c) => !isIgnored(c))
          .map((c) => ({ id: c.id, hash: c.hash, kind: c.kind, range: { ...c.range }, excerpt: c.text.slice(0, EXCERPT_CHARS) })),
        features,
        notTestable,
        rejected: rejectedList.map((r) => ({ fingerprint: r.fingerprint, title: r.title })),
        uncovered: computeUncovered(idx, features, new Set(notTestable.map((n) => n.chunkId))),
      };

      // Change report (ids of features and scenarios).
      const prevMap = new Map<string, string>();
      for (const f of prevFeatures) {
        prevMap.set(f.id, semanticKey(f));
        for (const s of f.scenarios) prevMap.set(s.id, scenarioKey(s));
      }
      const added: string[] = [];
      const updated: string[] = [];
      const newIds = new Set<string>();
      const note = (id: string, key: string): void => {
        newIds.add(id);
        const old = prevMap.get(id);
        if (old === undefined) added.push(id);
        else if (old !== key) updated.push(id);
      };
      for (const f of features) {
        note(f.id, semanticKey(f));
        for (const s of f.scenarios) note(s.id, scenarioKey(s));
      }
      const removed: string[] = [];
      for (const f of prevFeatures) {
        if (!newIds.has(f.id)) removed.push(f.id);
        for (const s of f.scenarios) if (!newIds.has(s.id)) removed.push(s.id);
      }
      return { plan, diagnostics, added, updated, removed };
    },

    status(docs, plans) {
      const docByUri = new Map(docs.map((d) => [d.doc.uri, d]));
      const planByUri = new Map(plans.map((p) => [p.docUri, p]));
      const uris = [...new Set([...docByUri.keys(), ...planByUri.keys()])].sort(cmp);
      const out: DocStatus[] = uris.map((uri) => statusOf(docByUri.get(uri), planByUri.get(uri), uri));
      return { docs: out };
    },

    review(plan, id, action) {
      return reviewPlan(plan, id, action);
    },
  };
  return planner;
};

function statusOf(doc: ChunkedDoc | undefined, plan: DocPlan | undefined, docUri: string): DocStatus {
  if (plan === undefined) {
    return {
      docUri,
      state: 'new',
      dirtySections: (doc as ChunkedDoc).sections.map((s) => s.id),
      staleFeatures: [],
      uncovered: [],
      notTestable: [],
      unreviewedScenarios: [],
    };
  }
  const base = {
    notTestable: plan.notTestable.map((n) => n.chunkId),
    uncovered: [...plan.uncovered],
    unreviewedScenarios: plan.features.flatMap((f) => f.scenarios.filter((s) => s.review === 'unreviewed').map((s) => s.id)),
  };
  if (doc === undefined) return { docUri, state: 'orphaned', dirtySections: [], staleFeatures: [], ...base };
  const idx = indexDoc(doc);
  const dirtySections = computeDirty(doc, plan, false, idx);
  const staleFeatures = plan.features.filter((f) => f.pinned === true && hasStaleSources(f, idx)).map((f) => f.id);
  return { docUri, state: dirtySections.length > 0 || staleFeatures.length > 0 ? 'stale' : 'fresh', dirtySections, staleFeatures, ...base };
}

function aggregateReview(scenarios: readonly Scenario[], fallback: ReviewState): ReviewState {
  if (scenarios.length === 0) return fallback;
  if (scenarios.every((s) => s.review === 'accepted')) return 'accepted';
  if (scenarios.every((s) => s.review === 'rejected')) return 'rejected';
  return 'unreviewed';
}

/** §8.7. Pure: returns a new plan and never mutates the input. */
function reviewPlan(plan: DocPlan, id: string, action: 'accept' | 'reject' | 'pin' | 'unpin'): DocPlan {
  const next = structuredClone(plan);
  const feature = next.features.find((f) => f.id === id);
  const owner = feature ?? next.features.find((f) => f.scenarios.some((s) => s.id === id));
  if (owner === undefined) throw new AiBddError('SCENARIO_NOT_FOUND', `no feature or scenario with id ${JSON.stringify(id)}`, { details: { id } });

  if (action === 'pin') {
    owner.pinned = true;
    return next;
  }
  if (action === 'unpin') {
    delete owner.pinned;
    return next;
  }
  const targets = feature !== undefined ? feature.scenarios : owner.scenarios.filter((s) => s.id === id);
  const state: ReviewState = action === 'accept' ? 'accepted' : 'rejected';
  for (const s of targets) {
    s.review = state;
    if (action === 'reject') {
      if (!next.rejected.some((r) => r.fingerprint === s.fingerprint)) next.rejected.push({ fingerprint: s.fingerprint, title: s.title });
    } else {
      next.rejected = next.rejected.filter((r) => r.fingerprint !== s.fingerprint);
    }
  }
  owner.review = feature !== undefined ? state : aggregateReview(owner.scenarios, owner.review);
  next.uncovered = refreshUncovered(next);
  return next;
}

/** Rejected items stop covering their sources (§8.4 step 8); accepting again restores coverage. Needs no doc: plan.chunks suffices. */
function refreshUncovered(plan: DocPlan): string[] {
  const covered = new Set<string>();
  const referenced = new Set<string>();
  const visit = (refs: readonly ChunkRef[], live: boolean): void => {
    for (const r of refs) {
      if (r.relation !== 'source') continue;
      referenced.add(r.chunkId);
      if (live) covered.add(r.chunkId);
    }
  };
  for (const f of plan.features) {
    const fl = f.review !== 'rejected';
    visit(f.sources, fl);
    for (const s of f.scenarios) {
      const sl = fl && s.review !== 'rejected';
      visit(s.sources, sl);
      for (const st of s.steps) visit(st.sources, sl);
    }
  }
  const notTestable = new Set(plan.notTestable.map((n) => n.chunkId));
  const keep = new Set(plan.uncovered.filter((id) => !covered.has(id)));
  for (const id of referenced) if (!covered.has(id) && !notTestable.has(id)) keep.add(id);
  return plan.chunks.filter((c) => keep.has(c.id) && c.kind !== 'heading').map((c) => c.id);
}
