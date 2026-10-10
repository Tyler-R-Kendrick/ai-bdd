import { describe, expect, it } from 'vitest';
import type { Chunk, ChunkedDoc, ChunkRef, DocDirectives, DocPlan, Feature, Scenario, Section, Step } from '../../src/contracts/index.ts';
import {
  chunkAnchor,
  computeDirty,
  forEachRef,
  hasStaleSources,
  indexDoc,
  isContext,
  isIgnored,
  resolveRef,
  sectionAnchor,
  sectionBase,
  sectionsOwningAnchor,
} from '../../src/plan/refs.ts';

const URI = 'doc.md';
const range = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 };

function chunk(anchor: string, hash: string, directives: DocDirectives = {}, docUri = URI): Chunk {
  return { id: `${docUri}#${anchor}`, docUri, anchor, kind: 'paragraph', headingPath: [], sectionId: `${docUri}#x`, text: hash, hash, range, directives };
}

function section(anchor: string, chunkIds: string[], hash = `h-${anchor}`, opts: { sectionAnchor?: string } = {}): Section {
  return { id: `${URI}#${anchor}`, docUri: URI, anchor: opts.sectionAnchor ?? anchor, title: anchor, level: 2, chunkIds, hash, range };
}

function doc(chunks: Chunk[], sections: Section[] = [], contextChunkIds: string[] = []): ChunkedDoc {
  return { doc: { uri: URI, sha256: 'doc', title: 'T' }, chunks, sections, contextChunkIds, diagnostics: [] };
}

function ref(chunk: Chunk | string, hash: string, relation: ChunkRef['relation'] = 'source'): ChunkRef {
  return { chunkId: typeof chunk === 'string' ? chunk : chunk.id, hash, relation };
}

function step(key: string, sources: ChunkRef[]): Step {
  return { key, kind: 'given', text: key, grounding: 'quoted', sources, params: {} };
}

function feature(sectionId: string, sources: ChunkRef[], scenarios: Scenario[] = []): Feature {
  return { id: `f-${sectionId}`, docUri: URI, sectionId, title: 'F', tags: [], sources, scenarios, review: 'unreviewed', fingerprint: 'fp' };
}

function scenario(sources: ChunkRef[], steps: Step[]): Scenario {
  return { id: 's', featureId: 'f', title: 'S', tags: [], sources, steps, review: 'unreviewed', fingerprint: 'sfp' };
}

function plan(opts: { sections: DocPlan['sections']; chunks: Chunk[]; features?: Feature[]; docUri?: string }): DocPlan {
  return {
    schemaVersion: 1,
    docUri: opts.docUri ?? URI,
    docSha256: 'old',
    extractor: { modelId: 'm', promptVersion: 'p' },
    sections: opts.sections,
    chunks: opts.chunks.map((c) => ({ id: c.id, hash: c.hash, kind: c.kind, range, excerpt: c.text })),
    features: opts.features ?? [],
    notTestable: [],
    rejected: [],
    uncovered: [],
  };
}

describe('indexDoc', () => {
  it('indexes chunks by id and in document order', () => {
    const a = chunk('a', 'ha');
    const b = chunk('b', 'hb');
    const idx = indexDoc(doc([a, b]));
    expect([...idx.byId.keys()]).toEqual([a.id, b.id]);
    expect(idx.byId.get(b.id)).toBe(b);
    expect([...idx.order.entries()]).toEqual([[a.id, 0], [b.id, 1]]);
  });

  it('a chunk flagged with the context directive is a context chunk', () => {
    const c = chunk('c', 'hc', { context: true });
    const idx = indexDoc(doc([c]));
    expect([...idx.contextIds]).toEqual([c.id]);
    expect(isContext(idx, c)).toBe(true);
  });

  it('a chunk listed in contextChunkIds is a context chunk; others are not', () => {
    const a = chunk('a', 'ha');
    const b = chunk('b', 'hb', { context: false });
    const idx = indexDoc(doc([a, b], [], [a.id]));
    expect([...idx.contextIds]).toEqual([a.id]);
    expect(isContext(idx, a)).toBe(true);
    expect(isContext(idx, b)).toBe(false);
  });

  it('source chunks are neither ignored nor context; context chunks are not ignored', () => {
    const plain = chunk('p', 'h1');
    const dup = chunk('q', 'h1');
    const ctx = chunk('c', 'h2', { context: true });
    const ign = chunk('i', 'h3', { ignore: true });
    const fuzzy = chunk('f', 'h4', { fuzzy: true });
    const idx = indexDoc(doc([plain, dup, ctx, ign, fuzzy]));
    expect([...idx.sourceByHash.entries()]).toEqual([['h1', [plain, dup]], ['h4', [fuzzy]]]);
    expect([...idx.contextByHash.entries()]).toEqual([['h1', [plain, dup]], ['h2', [ctx]], ['h4', [fuzzy]]]);
  });

  it('an ignored context chunk is in neither hash index', () => {
    const c = chunk('c', 'h', { context: true, ignore: true });
    const idx = indexDoc(doc([c]));
    expect(idx.sourceByHash.size).toBe(0);
    expect(idx.contextByHash.size).toBe(0);
  });

  it('keeps the doc and isIgnored reflects the ignore directive only', () => {
    const d = doc([chunk('a', 'h')]);
    expect(indexDoc(d).doc).toBe(d);
    expect(isIgnored(chunk('a', 'h', { ignore: true }))).toBe(true);
    expect(isIgnored(chunk('a', 'h', { ignore: false }))).toBe(false);
    expect(isIgnored(chunk('a', 'h', { context: true }))).toBe(false);
  });
});

describe('resolveRef', () => {
  it('same: the chunk still exists with the recorded hash', () => {
    const a = chunk('a', 'ha');
    expect(resolveRef(ref(a, 'ha'), indexDoc(doc([a])))).toEqual({ kind: 'same' });
    expect(resolveRef(ref(a, 'ha', 'context'), indexDoc(doc([a])))).toEqual({ kind: 'same' });
  });

  it('a source ref to a chunk that became context is not the same: it relocates or is changed', () => {
    const a = chunk('a', 'ha', { context: true });
    expect(resolveRef(ref(a, 'ha', 'source'), indexDoc(doc([a])))).toEqual({ kind: 'changed' });
    const other = chunk('b', 'ha');
    expect(resolveRef(ref(a, 'ha', 'source'), indexDoc(doc([a, other])))).toEqual({ kind: 'moved', chunk: other });
  });

  it('a context ref to a context chunk is the same', () => {
    const a = chunk('a', 'ha', { context: true });
    expect(resolveRef(ref(a, 'ha', 'context'), indexDoc(doc([a])))).toEqual({ kind: 'same' });
  });

  it('a context ref to a chunk listed in contextChunkIds is the same', () => {
    const a = chunk('a', 'ha');
    expect(resolveRef(ref(a, 'ha', 'context'), indexDoc(doc([a], [], [a.id])))).toEqual({ kind: 'same' });
  });

  it('a source ref to a chunk listed in contextChunkIds is not the same', () => {
    const a = chunk('a', 'ha');
    expect(resolveRef(ref(a, 'ha', 'source'), indexDoc(doc([a], [], [a.id])))).toEqual({ kind: 'changed' });
  });

  it('an ignored chunk with the recorded hash does not resolve as the same', () => {
    const a = chunk('a', 'ha', { ignore: true });
    expect(resolveRef(ref(a, 'ha'), indexDoc(doc([a])))).toEqual({ kind: 'changed' });
    expect(resolveRef(ref(a, 'ha', 'context'), indexDoc(doc([a])))).toEqual({ kind: 'changed' });
  });

  it('moved: exactly one current chunk has the old hash (a different id)', () => {
    const b = chunk('b', 'hold');
    const idx = indexDoc(doc([chunk('a', 'hnew'), b]));
    expect(resolveRef(ref(`${URI}#a`, 'hold'), idx)).toEqual({ kind: 'moved', chunk: b });
    expect(resolveRef(ref(`${URI}#gone`, 'hold', 'context'), idx)).toEqual({ kind: 'moved', chunk: b });
  });

  it('ambiguous: two or more current chunks have the old hash', () => {
    const idx = indexDoc(doc([chunk('a', 'hnew'), chunk('b', 'hold'), chunk('c', 'hold'), chunk('d', 'hold')]));
    expect(resolveRef(ref(`${URI}#a`, 'hold'), idx)).toEqual({ kind: 'ambiguous' });
    expect(resolveRef(ref(`${URI}#a`, 'hold', 'context'), idx)).toEqual({ kind: 'ambiguous' });
  });

  it('exactly two candidates are ambiguous', () => {
    const idx = indexDoc(doc([chunk('b', 'hold'), chunk('c', 'hold')]));
    expect(resolveRef(ref(`${URI}#a`, 'hold'), idx)).toEqual({ kind: 'ambiguous' });
  });

  it('changed: no current chunk has the old hash', () => {
    const idx = indexDoc(doc([chunk('a', 'hnew')]));
    expect(resolveRef(ref(`${URI}#a`, 'hold'), idx)).toEqual({ kind: 'changed' });
    expect(resolveRef(ref(`${URI}#gone`, 'hold'), idx)).toEqual({ kind: 'changed' });
  });

  it('source refs relocate only to source chunks; context refs also to context chunks', () => {
    const ctx = chunk('c', 'hold', { context: true });
    const idx = indexDoc(doc([ctx]));
    expect(resolveRef(ref(`${URI}#gone`, 'hold', 'source'), idx)).toEqual({ kind: 'changed' });
    expect(resolveRef(ref(`${URI}#gone`, 'hold', 'context'), idx)).toEqual({ kind: 'moved', chunk: ctx });
  });

  it('relocation never targets ignored chunks', () => {
    const idx = indexDoc(doc([chunk('c', 'hold', { ignore: true })]));
    expect(resolveRef(ref(`${URI}#gone`, 'hold', 'source'), idx)).toEqual({ kind: 'changed' });
    expect(resolveRef(ref(`${URI}#gone`, 'hold', 'context'), idx)).toEqual({ kind: 'changed' });
  });

  it('a source ref whose own chunk changed hash and sits where another chunk has the old hash is moved to that chunk', () => {
    const a = chunk('a', 'hnew');
    const b = chunk('b', 'hold');
    expect(resolveRef(ref(a, 'hold'), indexDoc(doc([a, b])))).toEqual({ kind: 'moved', chunk: b });
  });
});

describe('forEachRef', () => {
  it('visits feature, then each scenario with its steps, in order', () => {
    const r = (id: string): ChunkRef => ref(`${URI}#${id}`, `h-${id}`);
    const f = feature(
      `${URI}#s`,
      [r('f1'), r('f2')],
      [
        scenario([r('s1a'), r('s1b')], [step('k1', [r('t1a'), r('t1b')]), step('k2', [r('t2')])]),
        scenario([r('s2')], [step('k3', [r('t3')])]),
      ],
    );
    const seen: string[] = [];
    forEachRef(f, (x) => seen.push(x.chunkId.slice(URI.length + 1)));
    expect(seen).toEqual(['f1', 'f2', 's1a', 's1b', 't1a', 't1b', 't2', 's2', 't3']);
  });

  it('visits nothing for a feature without refs', () => {
    const seen: ChunkRef[] = [];
    forEachRef(feature(`${URI}#s`, []), (x) => seen.push(x));
    expect(seen).toEqual([]);
  });

  it('visits feature-level refs, scenario-level refs and step-level refs, each separately', () => {
    const only = (f: Feature): string[] => {
      const seen: string[] = [];
      forEachRef(f, (x) => seen.push(x.chunkId));
      return seen;
    };
    const r = ref(`${URI}#x`, 'h');
    expect(only(feature('s', [r]))).toEqual([r.chunkId]);
    expect(only(feature('s', [], [scenario([r], [])]))).toEqual([r.chunkId]);
    expect(only(feature('s', [], [scenario([], [step('k', [r])])]))).toEqual([r.chunkId]);
  });
});

describe('hasStaleSources', () => {
  const a = chunk('a', 'ha');
  const idx = indexDoc(doc([a, chunk('b', 'hb'), chunk('c', 'hdup'), chunk('d', 'hdup')]));
  const same = ref(a, 'ha');
  const changed = ref(`${URI}#a`, 'hmissing');
  const ambiguous = ref(`${URI}#a`, 'hdup');
  const moved = ref(`${URI}#a`, 'hb');

  it('is false when every source ref is same or moved', () => {
    expect(hasStaleSources(feature('s', [same, moved]), idx)).toBe(false);
  });

  it('is true for a changed source ref', () => {
    expect(hasStaleSources(feature('s', [changed]), idx)).toBe(true);
  });

  it('is true for an ambiguous source ref', () => {
    expect(hasStaleSources(feature('s', [ambiguous]), idx)).toBe(true);
  });

  it('looks into scenario and step refs', () => {
    expect(hasStaleSources(feature('s', [same], [scenario([same], [step('k', [changed])])]), idx)).toBe(true);
    expect(hasStaleSources(feature('s', [same], [scenario([ambiguous], [])]), idx)).toBe(true);
  });

  it('ignores context refs, however broken', () => {
    expect(hasStaleSources(feature('s', [], [scenario([], [step('k', [{ ...changed, relation: 'context' }, { ...ambiguous, relation: 'context' }])])]), idx)).toBe(false);
  });

  it('is false without refs', () => {
    expect(hasStaleSources(feature('s', []), idx)).toBe(false);
  });
});

describe('sectionAnchor / sectionBase / chunkAnchor', () => {
  it('sectionAnchor returns the explicit anchor when set', () => {
    expect(sectionAnchor(section('intro', [], 'h', { sectionAnchor: 'custom/anchor' }))).toBe('custom/anchor');
  });

  it('sectionAnchor falls back to the part of the id after the first #', () => {
    expect(sectionAnchor(section('intro/part-2', [], 'h', { sectionAnchor: '' }))).toBe('intro/part-2');
    expect(sectionAnchor({ ...section('x', []), id: 'a#b#c', anchor: '' })).toBe('b#c');
  });

  it('sectionAnchor of an id without # is the whole id', () => {
    expect(sectionAnchor({ ...section('x', []), id: 'plain', anchor: '' })).toBe('plain');
  });

  it('sectionBase strips a trailing /part-N', () => {
    expect(sectionBase(section('intro', []))).toBe('intro');
    expect(sectionBase(section('intro/part-2', []))).toBe('intro');
    expect(sectionBase(section('a/b/part-12', []))).toBe('a/b');
    expect(sectionBase(section('x', [], 'h', { sectionAnchor: 'q/part-3' }))).toBe('q');
  });

  it('sectionBase leaves everything else alone', () => {
    expect(sectionBase(section('intro/part-2/more', []))).toBe('intro/part-2/more');
    expect(sectionBase(section('intro/part-x', []))).toBe('intro/part-x');
    expect(sectionBase(section('intro/part-', []))).toBe('intro/part-');
    expect(sectionBase(section('intro-part-2', []))).toBe('intro-part-2');
    expect(sectionBase(section('intro/part-2x', []))).toBe('intro/part-2x');
  });

  it('chunkAnchor strips the doc uri of the chunk id', () => {
    expect(chunkAnchor('doc.md#a/p1', 'doc.md')).toBe('a/p1');
  });

  it('chunkAnchor with a doc uri that contains # strips exactly the uri', () => {
    expect(chunkAnchor('a#b.md#sec/p1', 'a#b.md')).toBe('sec/p1');
  });

  it('chunkAnchor of an id from another doc takes everything after the first #', () => {
    expect(chunkAnchor('other.md#x/p1', 'doc.md')).toBe('x/p1');
    expect(chunkAnchor('other-longer-name.md#x#y', 'doc.md')).toBe('x#y');
  });

  it('chunkAnchor requires the # right after the doc uri', () => {
    expect(chunkAnchor('doc.mdx#a/p1', 'doc.md')).toBe('a/p1');
    expect(chunkAnchor('doc.md#a#doc.md#b', 'doc.md')).toBe('a#doc.md#b');
  });
});

describe('sectionsOwningAnchor', () => {
  const ids = (xs: Section[]): string[] => xs.map((s) => s.id);

  it('no sections, no owner', () => {
    expect(sectionsOwningAnchor('a/p1', [])).toEqual([]);
  });

  it('an anchor equal to a section base is owned by it', () => {
    expect(ids(sectionsOwningAnchor('intro', [section('intro', []), section('other', [])]))).toEqual([`${URI}#intro`]);
  });

  it('an anchor below a section base is owned by it', () => {
    expect(ids(sectionsOwningAnchor('intro/p1', [section('intro', []), section('other', [])]))).toEqual([`${URI}#intro`]);
  });

  it('a mere string prefix is not ownership', () => {
    expect(sectionsOwningAnchor('introduction/p1', [section('intro', [])])).toEqual([]);
    expect(sectionsOwningAnchor('zzz', [section('intro', [])])).toEqual([]);
  });

  it('the longest heading path wins, whatever the section order', () => {
    const outer = section('a', []);
    const inner = section('a/b', []);
    expect(ids(sectionsOwningAnchor('a/b/p1', [outer, inner]))).toEqual([inner.id]);
    expect(ids(sectionsOwningAnchor('a/b/p1', [inner, outer]))).toEqual([inner.id]);
    expect(ids(sectionsOwningAnchor('a/c/p1', [inner, outer]))).toEqual([outer.id]);
  });

  it('all part-N siblings of the winning base qualify, in document order', () => {
    const p1 = section('a/b/part-1', []);
    const p2 = section('a/b/part-2', []);
    const outer = section('a', []);
    expect(ids(sectionsOwningAnchor('a/b/p3', [outer, p1, p2]))).toEqual([p1.id, p2.id]);
    expect(ids(sectionsOwningAnchor('a/b', [p1, outer, p2]))).toEqual([p1.id, p2.id]);
  });

  it('an empty heading path owns an empty anchor', () => {
    const root = section('', []);
    expect(ids(sectionsOwningAnchor('', [root, section('a', [])]))).toEqual([root.id]);
  });
});

describe('computeDirty', () => {
  function two(): { a: Chunk; b: Chunk; secA: Section; secB: Section } {
    const a = chunk('a/p1', 'ha');
    const b = chunk('b/p1', 'hb');
    return { a, b, secA: section('a', [a.id], 'sa'), secB: section('b', [b.id], 'sb') };
  }

  it('returns every section for a full run or without a previous plan', () => {
    const { a, b, secA, secB } = two();
    const d = doc([a, b], [secA, secB]);
    const prev = plan({ sections: [{ id: secA.id, hash: 'sa' }], chunks: [a] });
    expect(computeDirty(d, null, false, indexDoc(d))).toEqual([secA.id, secB.id]);
    expect(computeDirty(d, prev, true, indexDoc(d))).toEqual([secA.id, secB.id]);
  });

  it('is empty when nothing changed', () => {
    const { a, b, secA, secB } = two();
    const d = doc([a, b], [secA, secB]);
    const prev = plan({ sections: [{ id: secA.id, hash: 'sa' }, { id: secB.id, hash: 'sb' }], chunks: [a, b] });
    expect(computeDirty(d, prev, false, indexDoc(d))).toEqual([]);
  });

  it('a section absent from the previous plan is dirty; so is one that failed', () => {
    const { a, b, secA, secB } = two();
    const d = doc([a, b], [secA, secB]);
    const absent = plan({ sections: [{ id: secA.id, hash: 'sa' }], chunks: [a, b] });
    expect(computeDirty(d, absent, false, indexDoc(d))).toEqual([secB.id]);
    const failed = plan({ sections: [{ id: secA.id, hash: 'sa', failed: true }, { id: secB.id, hash: 'sb', failed: false }], chunks: [a, b] });
    expect(computeDirty(d, failed, false, indexDoc(d))).toEqual([secA.id]);
  });

  it('a section whose hash differs and that holds a new chunk is dirty', () => {
    const { a, b, secA, secB } = two();
    const a2 = chunk('a/p1', 'ha2');
    const d = doc([a2, b], [{ ...secA, hash: 'sa2' }, secB]);
    const prev = plan({ sections: [{ id: secA.id, hash: 'sa' }, { id: secB.id, hash: 'sb' }], chunks: [a, b] });
    expect(computeDirty(d, prev, false, indexDoc(d))).toEqual([secA.id]);
  });

  it('a new chunk in a section whose hash is unchanged does not dirty it', () => {
    // Two chunks share the text 'dup'. The previous plan had one of them (x, in section a); now the earlier one (z, in section z)
    // takes the leftover previous chunk, so a's chunk y counts as new - but a's hash, built from chunk hashes only, did not change.
    const x = chunk('a/p1', 'dup');
    const z = chunk('z/p1', 'dup');
    const y = chunk('a/p2', 'dup');
    const secZ = section('z', [z.id], 'sz');
    const secA = section('a', [y.id], 'sa');
    const d = doc([z, y], [secZ, secA]);
    const prev = plan({ sections: [{ id: secA.id, hash: 'sa' }, { id: secZ.id, hash: 'sz' }], chunks: [x] });
    expect(computeDirty(d, prev, false, indexDoc(d))).toEqual([]);
    // the same situation with a changed hash for a is dirty
    const d2 = doc([z, y], [secZ, { ...secA, hash: 'sa2' }]);
    expect(computeDirty(d2, prev, false, indexDoc(d2))).toEqual([secA.id]);
  });

  it('a chunk that merely moved to another section leaves both sections clean despite their changed hashes', () => {
    const a = chunk('a/p1', 'ha');
    const b = chunk('b/p1', 'hb');
    const secA = section('a', [a.id], 'sa');
    const secB = section('b', [b.id], 'sb');
    // current: chunk with hash ha now lives under b (new id), a's chunk is gone; hashes of both sections changed
    const moved = chunk('b/p2', 'ha');
    const d = doc([moved, b], [{ ...secA, chunkIds: [], hash: 'sa2' }, { ...secB, chunkIds: [b.id, moved.id], hash: 'sb2' }]);
    const prev = plan({ sections: [{ id: secA.id, hash: 'sa' }, { id: secB.id, hash: 'sb' }], chunks: [a, b] });
    // the moved chunk is accounted for by the old chunk: nothing is new and nothing vanished.
    expect(computeDirty(d, prev, false, indexDoc(d))).toEqual([]);
  });

  it('a vanished chunk dirties the section that would have owned its anchor', () => {
    const { a, b, secA, secB } = two();
    const d = doc([b], [{ ...secA, chunkIds: [], hash: 'sa2' }, secB]);
    const prev = plan({ sections: [{ id: secA.id, hash: 'sa' }, { id: secB.id, hash: 'sb' }], chunks: [a, b] });
    expect(computeDirty(d, prev, false, indexDoc(d))).toEqual([secA.id]);
  });

  it('a vanished context chunk does not dirty anything', () => {
    const { a, b, secA, secB } = two();
    const ctx = chunk('a/p2', 'hctx', { context: true });
    const d = doc([a, b, { ...ctx, text: 'edited', hash: 'hctx2' }], [secA, secB]);
    const prev = plan({ sections: [{ id: secA.id, hash: 'sa' }, { id: secB.id, hash: 'sb' }], chunks: [a, b, ctx] });
    expect(computeDirty(d, prev, false, indexDoc(d))).toEqual([]);
  });

  it('a chunk that became ignored counts as vanished and dirties its section', () => {
    const { a, b, secA, secB } = two();
    const nowIgnored = { ...a, directives: { ignore: true } };
    const d = doc([nowIgnored, b], [{ ...secA, chunkIds: [] }, secB]);
    const prev = plan({ sections: [{ id: secA.id, hash: 'sa' }, { id: secB.id, hash: 'sb' }], chunks: [a, b] });
    expect(computeDirty(d, prev, false, indexDoc(d))).toEqual([secA.id]);
  });

  it('duplicate chunk texts are matched in place by id, so the right one is reported as vanished', () => {
    const a = chunk('a/p1', 'same');
    const b = chunk('b/p1', 'same');
    const secA = section('a', [a.id], 'sa');
    const secB = section('b', [b.id], 'sb');
    // a is deleted, b stays; the previous chunk of a (not of b) must be the vanished one.
    const d = doc([b], [{ ...secA, chunkIds: [], hash: 'sa2' }, secB]);
    const prev = plan({ sections: [{ id: secA.id, hash: 'sa' }, { id: secB.id, hash: 'sb' }], chunks: [a, b] });
    expect(computeDirty(d, prev, false, indexDoc(d))).toEqual([secA.id]);
  });

  it('the multiset accounting only forgives as many new chunks as the previous plan lost', () => {
    const p1 = chunk('a/p1', 'dup');
    const secA = section('a', [p1.id], 'sa');
    // previous: one chunk with hash dup under a/p1; current: two chunks with hash dup under new ids.
    const c1 = chunk('a/q1', 'dup');
    const c2 = chunk('a/q2', 'dup');
    const d = doc([c1, c2], [{ ...secA, chunkIds: [c1.id, c2.id], hash: 'sa2' }]);
    const prev = plan({ sections: [{ id: secA.id, hash: 'sa' }], chunks: [p1] });
    expect(computeDirty(d, prev, false, indexDoc(d))).toEqual([secA.id]);
  });

  it('a pure move of every chunk of a section leaves it clean', () => {
    const p1 = chunk('a/p1', 'dup');
    const secA = section('a', [p1.id], 'sa');
    const c1 = chunk('a/q1', 'dup');
    const d = doc([c1], [{ ...secA, chunkIds: [c1.id], hash: 'sa2' }]);
    const prev = plan({ sections: [{ id: secA.id, hash: 'sa' }], chunks: [p1] });
    // the old chunk is accounted for by the new one (same hash): nothing is new and nothing vanished.
    expect(computeDirty(d, prev, false, indexDoc(d))).toEqual([]);
  });

  it('a changed source ref of a feature of the section makes it dirty', () => {
    const { a, b, secA, secB } = two();
    const f = feature(secB.id, [ref(b, 'hb-old')]);
    const d = doc([a, b], [secA, secB]);
    const prev = plan({ sections: [{ id: secA.id, hash: 'sa' }, { id: secB.id, hash: 'sb' }], chunks: [a, b], features: [f] });
    expect(computeDirty(d, prev, false, indexDoc(d))).toEqual([secB.id]);
  });

  it('an ambiguous source ref of a feature of the section makes it dirty', () => {
    const a = chunk('a/p1', 'dup');
    const b = chunk('b/p1', 'dup');
    const secA = section('a', [a.id], 'sa');
    const secB = section('b', [b.id], 'sb');
    const f = feature(secB.id, [], [scenario([], [step('k', [ref(`${URI}#gone`, 'dup')])])]);
    const d = doc([a, b], [secA, secB]);
    const prev = plan({ sections: [{ id: secA.id, hash: 'sa' }, { id: secB.id, hash: 'sb' }], chunks: [a, b], features: [f] });
    expect(computeDirty(d, prev, false, indexDoc(d))).toEqual([secB.id]);
  });

  it('a moved source ref and a broken context ref leave the section clean', () => {
    const { a, b, secA, secB } = two();
    const f = feature(secB.id, [ref(`${URI}#elsewhere`, 'hb'), { chunkId: `${URI}#gone`, hash: 'hmissing', relation: 'context' }]);
    const d = doc([a, b], [secA, secB]);
    const prev = plan({ sections: [{ id: secA.id, hash: 'sa' }, { id: secB.id, hash: 'sb' }], chunks: [a, b], features: [f] });
    expect(computeDirty(d, prev, false, indexDoc(d))).toEqual([]);
  });

  it('features of other sections do not dirty the section', () => {
    const { a, b, secA, secB } = two();
    const f = feature(secA.id, [ref(a, 'broken')]);
    const d = doc([a, b], [secA, secB]);
    const prev = plan({ sections: [{ id: secA.id, hash: 'sa' }, { id: secB.id, hash: 'sb' }], chunks: [a, b], features: [f] });
    expect(computeDirty(d, prev, false, indexDoc(d))).toEqual([secA.id]);
  });

  it('returns dirty ids in document order, not discovery order', () => {
    const a = chunk('a/p1', 'ha');
    const b = chunk('b/p1', 'hb');
    const c = chunk('c/p1', 'hc');
    const secs = [section('a', [a.id], 'sa'), section('b', [b.id], 'sb'), section('c', [c.id], 'sc')];
    // c absent from the previous plan (found in the section loop), a only through a vanished anchor (found first)
    const prev = plan({ sections: [{ id: secs[0]!.id, hash: 'sa' }, { id: secs[1]!.id, hash: 'sb' }], chunks: [a, b, chunk('a/p9', 'gone')] });
    const d = doc([a, b, c], secs);
    expect(computeDirty(d, prev, false, indexDoc(d))).toEqual([secs[0]!.id, secs[2]!.id]);
  });
});
