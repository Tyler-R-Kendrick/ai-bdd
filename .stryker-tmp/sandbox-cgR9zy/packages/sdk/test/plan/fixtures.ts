// @ts-nocheck
import type {
  Chunk,
  ChunkedDoc,
  DocDirectives,
  DocPlan,
  DraftFeature,
  DraftRef,
  DraftScenario,
  DraftStep,
  ExtractionResult,
  Section,
  StepKind,
} from '../../src/contracts/index.ts';
import { sha256Hex, slugify } from '../../src/util/index.ts';

export interface ParaSpec {
  text: string;
  directives?: DocDirectives;
}
export interface SectionSpec {
  title: string;
  paras: (string | ParaSpec)[];
}

const range = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 };

/** Hand-built ChunkedDoc: one heading chunk plus paragraph chunks per level-2 section. */
export function buildDoc(docUri: string, specs: readonly SectionSpec[]): ChunkedDoc {
  const chunks: Chunk[] = [];
  const sections: Section[] = [];
  const contextChunkIds: string[] = [];
  for (const spec of specs) {
    const slug = slugify(spec.title);
    const sectionId = `${docUri}#${slug}`;
    const chunkIds: string[] = [];
    const headingText = spec.title;
    const add = (kind: Chunk['kind'], anchor: string, text: string, directives: DocDirectives): void => {
      const id = `${docUri}#${anchor}`;
      chunks.push({
        id,
        docUri,
        anchor,
        kind,
        headingPath: [slug],
        sectionId,
        text,
        hash: sha256Hex(text),
        range,
        directives,
      });
      if (directives.ignore === true) return;
      if (directives.context === true) contextChunkIds.push(id);
      else chunkIds.push(id);
    };
    add('heading', `${slug}/h`, headingText, {});
    spec.paras.forEach((p, i) => {
      const ps = typeof p === 'string' ? { text: p } : p;
      add('paragraph', `${slug}/p${i + 1}`, ps.text, ps.directives ?? {});
    });
    const hashes = chunkIds.map((id) => (chunks.find((c) => c.id === id) as Chunk).hash);
    sections.push({
      id: sectionId,
      docUri,
      anchor: slug,
      title: spec.title,
      level: 2,
      chunkIds,
      hash: sha256Hex(hashes.join('\n')),
      range,
    });
  }
  const text = chunks.map((c) => c.text).join('\n');
  return {
    doc: { uri: docUri, sha256: sha256Hex(text), title: docUri },
    chunks,
    sections,
    contextChunkIds,
    diagnostics: [],
  };
}

export function chunkIdOf(doc: ChunkedDoc, text: string): string {
  const c = doc.chunks.find((x) => x.text === text);
  if (c === undefined) throw new Error(`no chunk with text ${text}`);
  return c.id;
}

export function ref(doc: ChunkedDoc, text: string, relation: 'source' | 'context' = 'source', quote?: string): DraftRef {
  const r: DraftRef = { chunkId: chunkIdOf(doc, text), relation };
  if (quote !== undefined) r.quote = quote;
  return r;
}

export function step(kind: StepKind, text: string, sources: DraftRef[] = []): DraftStep {
  return { kind, text, grounding: sources.length > 0 ? 'quoted' : 'inferred', sources, params: {} };
}

export function scenario(title: string, steps: DraftStep[], sources: DraftRef[], tags: string[] = []): DraftScenario {
  return { title, tags, sources, steps };
}

export function feature(title: string, sources: DraftRef[], scenarios: DraftScenario[], tags: string[] = []): DraftFeature {
  return { title, tags, sources, scenarios };
}

export function result(sectionId: string, drafts: DraftFeature[], notTestable: { chunkId: string; reason: string }[] = []): ExtractionResult {
  return {
    sectionId,
    failed: false,
    drafts,
    notTestable,
    diagnostics: [],
    usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1 },
    modelId: 'fake',
    promptVersion: 'extract-v1',
  };
}

export function failedResult(sectionId: string): ExtractionResult {
  return { ...result(sectionId, []), failed: true };
}

export const META = { extractor: { modelId: 'fake', promptVersion: 'extract-v1' } };

export function mapOf(...results: ExtractionResult[]): Map<string, ExtractionResult> {
  return new Map(results.map((r) => [r.sectionId, r]));
}

/** A small two-section doc used by most unit tests. */
export const BILLING_PARAS = {
  upgrade: 'Customers can upgrade from the Free plan to the Pro plan from the billing page.',
  downgrade: 'Customers can downgrade from Pro to Free at any time.',
  invoices: 'Unpaid invoices must be settled before a downgrade is possible.',
  perf: 'The billing page should load in under two seconds.',
};

export function billingDoc(overrides: Partial<typeof BILLING_PARAS> = {}, extra: SectionSpec[] = []): ChunkedDoc {
  const p = { ...BILLING_PARAS, ...overrides };
  return buildDoc('docs/billing.md', [
    { title: 'Upgrading', paras: [p.upgrade, p.perf] },
    { title: 'Downgrading', paras: [p.downgrade, p.invoices] },
    ...extra,
  ]);
}

export function upgradeDraft(doc: ChunkedDoc, title = 'Upgrade to Pro'): DraftFeature {
  const r = ref(doc, doc.chunks.find((c) => c.text.startsWith('Customers can upgrade'))?.text ?? '');
  return feature(title, [r], [
    scenario(
      'Upgrade a free account',
      [step('given', 'the customer is on the Free plan'), step('when', 'the customer clicks Upgrade to Pro', [r]), step('then', 'the plan shows Pro', [r])],
      [r],
    ),
  ]);
}

export function downgradeDraft(doc: ChunkedDoc, title = 'Downgrade to Free'): DraftFeature {
  const r1 = ref(doc, doc.chunks.find((c) => c.text.startsWith('Customers can downgrade'))?.text ?? '');
  const r2 = ref(doc, doc.chunks.find((c) => c.text.startsWith('Unpaid invoices'))?.text ?? '');
  return feature(title, [r1], [
    scenario('Downgrade a pro account', [step('given', 'the customer is on the Pro plan'), step('when', 'the customer clicks Downgrade', [r1]), step('then', 'the plan shows Free', [r1])], [r1]),
    scenario('Downgrade blocked by unpaid invoices', [step('given', 'the customer has unpaid invoices'), step('when', 'the customer clicks Downgrade', [r2]), step('then', 'an alert says invoices are unpaid', [r2])], [r2]),
  ]);
}

export function firstSectionId(doc: ChunkedDoc, i: number): string {
  return (doc.sections[i] as Section).id;
}

export type { DocPlan };
