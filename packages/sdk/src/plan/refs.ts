import type { Chunk, ChunkedDoc, ChunkRef, DocPlan, Feature, Section } from '../contracts/index.ts';

/** Lookup structures over a chunked doc, built once per planner call. */
export interface DocIndex {
  doc: ChunkedDoc;
  byId: Map<string, Chunk>;
  /** Document order of every chunk id. */
  order: Map<string, number>;
  contextIds: Set<string>;
  /** Chunks that may be a `source`: not ignored, not context. */
  sourceByHash: Map<string, Chunk[]>;
  /** Chunks that may be a `context` ref: not ignored. */
  contextByHash: Map<string, Chunk[]>;
}

export function indexDoc(doc: ChunkedDoc): DocIndex {
  const byId = new Map<string, Chunk>();
  const order = new Map<string, number>();
  const contextIds = new Set<string>(doc.contextChunkIds);
  const sourceByHash = new Map<string, Chunk[]>();
  const contextByHash = new Map<string, Chunk[]>();
  doc.chunks.forEach((c, i) => {
    byId.set(c.id, c);
    order.set(c.id, i);
    if (c.directives.context === true) contextIds.add(c.id);
  });
  for (const c of doc.chunks) {
    if (c.directives.ignore === true) continue;
    push(contextByHash, c.hash, c);
    if (!contextIds.has(c.id)) push(sourceByHash, c.hash, c);
  }
  return { doc, byId, order, contextIds, sourceByHash, contextByHash };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a === undefined) m.set(k, [v]);
  else a.push(v);
}

export function isIgnored(c: Chunk): boolean {
  return c.directives.ignore === true;
}

export function isContext(idx: DocIndex, c: Chunk): boolean {
  return idx.contextIds.has(c.id);
}

export type RefResolution =
  | { kind: 'same' }
  | { kind: 'moved'; chunk: Chunk }
  | { kind: 'changed' }
  | { kind: 'ambiguous' };

/** §8.3 relocation: a ref whose chunk changed or vanished is moved iff exactly one current chunk has the old hash. */
export function resolveRef(ref: ChunkRef, idx: DocIndex): RefResolution {
  const cur = idx.byId.get(ref.chunkId);
  const isSource = ref.relation === 'source';
  if (cur !== undefined && cur.hash === ref.hash && !isIgnored(cur) && (!isSource || !isContext(idx, cur))) return { kind: 'same' };
  const candidates = (isSource ? idx.sourceByHash : idx.contextByHash).get(ref.hash) ?? [];
  if (candidates.length === 1) return { kind: 'moved', chunk: candidates[0] as Chunk };
  if (candidates.length > 1) return { kind: 'ambiguous' };
  return { kind: 'changed' };
}

export function forEachRef(feature: Feature, fn: (ref: ChunkRef) => void): void {
  feature.sources.forEach(fn);
  for (const s of feature.scenarios) {
    s.sources.forEach(fn);
    for (const st of s.steps) st.sources.forEach(fn);
  }
}

/** True when a `source` ref of the feature can no longer be resolved unambiguously. */
export function hasStaleSources(feature: Feature, idx: DocIndex): boolean {
  let stale = false;
  forEachRef(feature, (ref) => {
    if (ref.relation !== 'source') return;
    const r = resolveRef(ref, idx);
    if (r.kind === 'changed' || r.kind === 'ambiguous') stale = true;
  });
  return stale;
}

export function sectionAnchor(section: Section): string {
  const i = section.id.indexOf('#');
  return section.anchor !== '' ? section.anchor : section.id.slice(i + 1);
}

/** Heading-path anchor of a section, without the `/part-N` split suffix. */
export function sectionBase(section: Section): string {
  return sectionAnchor(section).replace(/\/part-\d+$/, '');
}

export function chunkAnchor(id: string, docUri: string): string {
  return id.startsWith(`${docUri}#`) ? id.slice(docUri.length + 1) : id.slice(id.indexOf('#') + 1);
}

/** Current sections that would have owned a chunk anchor (longest heading-path prefix wins; all `part-N` siblings qualify). */
export function sectionsOwningAnchor(anchor: string, sections: readonly Section[]): Section[] {
  let best = -1;
  for (const s of sections) {
    const base = sectionBase(s);
    if ((anchor === base || anchor.startsWith(`${base}/`)) && base.length > best) best = base.length;
  }
  return best < 0 ? [] : sections.filter((s) => sectionBase(s).length === best && (anchor === sectionBase(s) || anchor.startsWith(`${sectionBase(s)}/`)));
}

/**
 * §8.3 `dirtySections`. Returns dirty section ids in document order.
 *
 * A section whose hash differs from the plan is still clean when the difference is explained purely by moves:
 * every current chunk of the section already existed in the previous plan (same id, or same hash elsewhere),
 * no previous chunk disappeared from it, and all source refs resolve after relocation.
 */
export function computeDirty(doc: ChunkedDoc, previous: DocPlan | null, full: boolean, idx: DocIndex): string[] {
  if (full || previous === null) return doc.sections.map((s) => s.id);
  const prevSection = new Map(previous.sections.map((s) => [s.id, s]));
  const featuresBySection = new Map<string, Feature[]>();
  for (const f of previous.features) push(featuresBySection, f.sectionId, f);

  const { newChunkIds, vanishedAnchors } = classifyChunks(doc, previous, idx);
  const dirty = new Set<string>();
  for (const a of vanishedAnchors) for (const s of sectionsOwningAnchor(a, doc.sections)) dirty.add(s.id);

  for (const s of doc.sections) {
    const prev = prevSection.get(s.id);
    if (prev === undefined || prev.failed === true) {
      dirty.add(s.id);
      continue;
    }
    if (prev.hash !== s.hash && s.chunkIds.some((id) => newChunkIds.has(id))) dirty.add(s.id);
    else if (prev.hash !== s.hash && !s.chunkIds.every((id) => previous.chunks.some((c) => c.id === id) || !newChunkIds.has(id))) dirty.add(s.id);
    for (const f of featuresBySection.get(s.id) ?? []) {
      forEachRef(f, (ref) => {
        if (ref.relation !== 'source') return;
        const r = resolveRef(ref, idx);
        if (r.kind === 'changed' || r.kind === 'ambiguous') dirty.add(s.id);
      });
    }
  }
  return doc.sections.filter((s) => dirty.has(s.id)).map((s) => s.id);
}

/**
 * Multiset comparison of the previous plan's chunk list with the current doc.
 * A current chunk is "new" when no previous chunk with its hash is left over after in-place matches and moves.
 * A previous chunk is "vanished" when no current chunk accounts for it.
 */
function classifyChunks(doc: ChunkedDoc, previous: DocPlan, _idx: DocIndex): { newChunkIds: Set<string>; vanishedAnchors: string[] } {
  const curActive = doc.chunks.filter((c) => !isIgnored(c));
  const prevInPlace = new Set<string>();
  const curInPlace = new Set<string>();
  const curById = new Map(curActive.map((c) => [c.id, c]));
  for (const p of previous.chunks) {
    const c = curById.get(p.id);
    if (c !== undefined && c.hash === p.hash) {
      prevInPlace.add(p.id);
      curInPlace.add(c.id);
    }
  }
  const prevLeft = new Map<string, string[]>();
  for (const p of previous.chunks) if (!prevInPlace.has(p.id)) push(prevLeft, p.hash, p.id);
  const newChunkIds = new Set<string>();
  for (const c of curActive) {
    if (curInPlace.has(c.id)) continue;
    const pool = prevLeft.get(c.hash);
    if (pool !== undefined && pool.length > 0) pool.shift();
    else newChunkIds.add(c.id);
  }
  const vanishedAnchors: string[] = [];
  for (const ids of prevLeft.values()) for (const id of ids) vanishedAnchors.push(chunkAnchor(id, previous.docUri));
  return { newChunkIds, vanishedAnchors };
}
