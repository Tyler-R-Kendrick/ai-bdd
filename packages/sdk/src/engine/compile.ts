import {
  AiBddError,
  type ChunkedDoc,
  type CompileOptions,
  type CompileResult,
  type Diagnostic,
  type DocPlan,
  type DocStatus,
  type EvidenceStore,
  type ExitCode,
  type ExtractionResult,
  type FixtureDescriptor,
  type JsonValue,
  type PlanStatus,
  type Section,
} from '../contracts/index.ts';
import { stableJson } from '../util/index.ts';
import type { Core } from './core.ts';
import { zeroUsage } from './usage.ts';
import { cmp, errorMessage, mapPool, matchesAnyGlob, throwIfAborted } from './util.ts';

export interface DocAnalysis {
  chunked: ChunkedDoc[];
  /** Every doc discovered on disk (before the `docs` filter). */
  discoveredUris: Set<string>;
  plans: DocPlan[];
  status: PlanStatus;
}

/** discover -> chunk -> load plans -> status. Never calls a model and never writes. */
export async function analyze(core: Core, docFilter?: readonly string[]): Promise<DocAnalysis> {
  const { config, modules } = core;
  const filter = docFilter !== undefined && docFilter.length > 0 ? docFilter : undefined;
  const sources = await modules.discoverDocs(config);
  const selected = filter === undefined ? sources : sources.filter((s) => matchesAnyGlob(filter, s.uri));
  const chunker = modules.createChunker();
  const chunked = selected.map((s) => chunker.chunk(s, { sectionDepth: config.extract.sectionDepth, maxSectionChars: config.extract.maxSectionChars }));
  const existing = await core.planStore().loadAll();
  const plans = filter === undefined ? existing : existing.filter((p) => matchesAnyGlob(filter, p.docUri));
  const status = core.planner().status(chunked, plans);
  return { chunked, discoveredUris: new Set(sources.map((s) => s.uri)), plans, status };
}

const fixtureDescriptors = (core: Core): FixtureDescriptor[] =>
  core.config.fixtures.map((f) => ({ name: f.name, description: f.description, params: f.params }));

interface Task {
  doc: ChunkedDoc;
  section: Section;
  previous: DocPlan | null;
}

function failedResult(core: Core, section: Section, err: unknown): ExtractionResult {
  const code = err instanceof AiBddError ? err.code : 'INTERNAL';
  return {
    sectionId: section.id,
    failed: true,
    drafts: [],
    notTestable: [],
    diagnostics: [
      {
        code: 'EXTRACT_SECTION_FAILED',
        severity: 'error',
        message: `Extraction of section ${section.id} failed: ${errorMessage(err)}`,
        uri: section.docUri,
        details: { sectionId: section.id, cause: code },
      },
    ],
    usage: zeroUsage(),
    modelId: core.models.extract.id,
    promptVersion: core.modules.extractPromptVersion,
  };
}

const isReadError = (d: Diagnostic): boolean => d.code === 'DOC_READ_FAILED' && d.severity === 'error';

/**
 * Compile (§7, §8): discover -> chunk -> dirty sections -> extract (concurrently) -> merge -> save.
 * `check` writes nothing and never calls a model; `dryRun` extracts but writes nothing.
 */
export async function compile(core: Core, opts: CompileOptions = {}, evidence?: EvidenceStore): Promise<CompileResult> {
  core.assertOpen();
  const { config, modules } = core;
  const check = opts.check === true;
  const dryRun = opts.dryRun === true;
  const full = opts.full === true;
  const before = core.meter.snapshot();
  throwIfAborted(opts.signal);

  const { chunked, discoveredUris, plans, status } = await analyze(core, opts.docs);
  const planByUri = new Map(plans.map((p) => [p.docUri, p]));
  const statusByUri = new Map<string, DocStatus>(status.docs.map((d) => [d.docUri, d]));
  const docDiagnostics = new Map<string, Diagnostic[]>(chunked.map((d) => [d.doc.uri, [...d.diagnostics]]));
  const orphanPlans = plans.filter((p) => !discoveredUris.has(p.docUri));

  const resultDocs: CompileResult['docs'] = [];
  const entryFor = (docUri: string, state: DocStatus['state']): CompileResult['docs'][number] => ({
    docUri,
    state,
    extractedSections: [],
    failedSections: [],
    added: [],
    updated: [],
    removed: [],
    diagnostics: docDiagnostics.get(docUri) ?? [],
  });

  const finish = (exitCode: ExitCode): CompileResult => {
    resultDocs.sort((a, b) => cmp(a.docUri, b.docUri));
    return { docs: resultDocs, usage: core.meter.since(before).total, exitCode };
  };
  const allDiagnostics = (): Diagnostic[] => resultDocs.flatMap((d) => d.diagnostics);

  if (check) {
    for (const d of status.docs) resultDocs.push(entryFor(d.docUri, d.state));
    const readError = allDiagnostics().some(isReadError);
    return finish(readError ? 2 : status.docs.some((d) => d.state !== 'fresh') ? 4 : 0);
  }

  // Plan which sections are dirty; unchanged sections are "reused" without any model call.
  const extractor = modules.createExtractor({ model: core.models.extract, redactor: core.redactor(), config, ...(evidence === undefined ? {} : { evidence }) });
  const tasks: Task[] = [];
  const dirtyByDoc = new Map<string, Set<string>>();
  for (const doc of chunked) {
    const previous = planByUri.get(doc.doc.uri) ?? null;
    const dirty = new Set(core.planner().dirtySections(doc, previous, { full }));
    dirtyByDoc.set(doc.doc.uri, dirty);
    for (const section of doc.sections) {
      if (dirty.has(section.id)) tasks.push({ doc, section, previous });
      else core.emit({ type: 'compile-section', docUri: doc.doc.uri, sectionId: section.id, status: 'reused' });
    }
  }

  const fixtures = fixtureDescriptors(core);
  const secretNames = Object.keys(config.secrets).sort(cmp);
  const results = new Map<string, Map<string, ExtractionResult>>();
  const extractedDocs = await mapPool(tasks, config.extract.concurrency, async (task) => {
    throwIfAborted(opts.signal);
    let result: ExtractionResult;
    try {
      result = await extractor.extractSection({
        doc: task.doc,
        section: task.section,
        fixtures,
        secretNames,
        previousTitles: task.previous?.features.filter((f) => f.sectionId === task.section.id).map((f) => f.title) ?? [],
        rejected: task.previous?.rejected ?? [],
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
    } catch (err) {
      if (err instanceof AiBddError && err.code === 'ABORTED') throw err;
      result = failedResult(core, task.section, err);
    }
    core.emit({ type: 'compile-section', docUri: task.doc.doc.uri, sectionId: task.section.id, status: result.failed ? 'failed' : 'extracted' });
    return { task, result };
  });
  for (const { task, result } of extractedDocs) {
    let perDoc = results.get(task.doc.doc.uri);
    if (perDoc === undefined) results.set(task.doc.doc.uri, (perDoc = new Map()));
    perDoc.set(task.section.id, result);
  }

  const store = core.planStore();
  let failedAny = false;
  for (const doc of chunked) {
    throwIfAborted(opts.signal);
    const uri = doc.doc.uri;
    const previous = planByUri.get(uri) ?? null;
    const extracted = results.get(uri) ?? new Map<string, ExtractionResult>();
    const first = [...extracted.values()].find((r) => r.modelId !== '');
    const meta = {
      extractor: first
        ? { modelId: first.modelId, promptVersion: first.promptVersion }
        : (previous?.extractor ?? { modelId: core.models.extract.id, promptVersion: modules.extractPromptVersion }),
    };
    const merged = core.planner().merge(doc, previous, extracted, meta);
    const entry = entryFor(uri, statusByUri.get(uri)?.state ?? (previous === null ? 'new' : 'fresh'));
    for (const section of doc.sections) {
      const r = extracted.get(section.id);
      if (r === undefined) continue;
      (r.failed ? entry.failedSections : entry.extractedSections).push(section.id);
      entry.diagnostics.push(...r.diagnostics);
    }
    entry.diagnostics.push(...merged.diagnostics);
    entry.added = merged.added;
    entry.updated = merged.updated;
    entry.removed = merged.removed;
    if (entry.failedSections.length > 0) failedAny = true;
    resultDocs.push(entry);
    if (!dryRun && (previous === null || stableJson(merged.plan as unknown as JsonValue) !== stableJson(previous as unknown as JsonValue))) {
      await store.save(merged.plan);
    }
  }

  // Plans of deleted docs are removed (reported as orphaned).
  for (const plan of orphanPlans) {
    const entry = entryFor(plan.docUri, 'orphaned');
    entry.removed = plan.features.map((f) => f.id);
    resultDocs.push(entry);
    if (!dryRun) await store.remove(plan.docUri);
  }

  let exitCode: ExitCode = 0;
  if (allDiagnostics().some(isReadError)) exitCode = 2;
  else if (core.meter.since(before).unavailable > 0) exitCode = 3;
  else if (failedAny || allDiagnostics().some((d) => d.severity === 'error')) exitCode = 1;
  return finish(exitCode);
}
