import { describe, expect, it } from 'vitest';
import type { ExtractionInput, ExtractionResult } from '../../src/contracts/index.ts';
import { canonicalJson, sha256Hex, normalizeForQuote } from '../../src/util/index.ts';
import { createExtractor } from '../../src/extract/index.ts';
import type { Extraction } from '../../src/extract/schema.ts';
import {
  DOWNGRADE_QUOTE,
  H,
  UPGRADE_QUOTE,
  extraction,
  feature,
  makeConfig,
  makeDoc,
  makeInput,
  makeRedactor,
  ref,
  scenario,
  step,
  stubModel,
} from './helpers.ts';

interface RunOpts {
  minQuoteChars?: number;
  input?: Partial<ExtractionInput>;
}

async function run(ex: Extraction, opts: RunOpts = {}): Promise<ExtractionResult> {
  const model = stubModel([ex]);
  const extractor = createExtractor({ model, redactor: makeRedactor(), config: makeConfig(opts.minQuoteChars) });
  return extractor.extractSection(makeInput(opts.input ?? {}));
}

const codes = (r: ExtractionResult): string[] => r.diagnostics.map((d) => d.code);
const chunks = makeDoc().chunks;

function firstFeature(r: ExtractionResult) {
  const f = r.drafts[0];
  if (f === undefined) throw new Error('expected a draft feature');
  return f;
}
function firstScenario(r: ExtractionResult) {
  const s = firstFeature(r).scenarios[0];
  if (s === undefined) throw new Error('expected a draft scenario');
  return s;
}

interface Case {
  name: string;
  ex: Extraction;
  opts?: RunOpts;
  check: (r: ExtractionResult) => void;
}

/** A feature whose only scenario holds the given steps (scenario cites the upgrade chunk itself). */
function withSteps(steps: ReturnType<typeof step>[]): Extraction {
  return extraction([feature({ scenarios: [scenario({ steps })] })]);
}

const when = step('when', 'the customer clicks the Upgrade to Pro button');
const then = step('then', 'the plan badge shows Pro');

// ───────────────────────── R-EX2: handles, quotes, grounding
const handleCases: Case[] = [
  {
    name: 'R-EX2: keeps a feature whose quotes are verbatim and maps handles to chunk ids',
    ex: extraction(),
    check: (r) => {
      expect(r.failed).toBe(false);
      expect(r.drafts).toHaveLength(1);
      expect(firstFeature(r).sources).toEqual([{ chunkId: chunks.upgrade.id, relation: 'source', quote: UPGRADE_QUOTE }]);
      expect(firstScenario(r).sources[0]?.chunkId).toBe(chunks.upgrade.id);
      expect(r.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    },
  },
  {
    name: 'R-EX2: drops features whose quotes are not verbatim',
    ex: extraction([feature({ sources: [ref(H.upgrade, 'Customers can downgrade from Pro to Free at any time')] })]),
    check: (r) => {
      expect(r.drafts).toEqual([]);
      expect(codes(r)).toContain('EXTRACT_QUOTE_NOT_FOUND');
      expect(codes(r)).toContain('EXTRACT_UNGROUNDED');
    },
  },
  {
    name: 'R-EX2: drops unknown handles with EXTRACT_QUOTE_NOT_FOUND',
    ex: extraction([feature({ sources: [ref('c99', UPGRADE_QUOTE)] })]),
    check: (r) => {
      expect(r.drafts).toEqual([]);
      expect(codes(r)).toContain('EXTRACT_QUOTE_NOT_FOUND');
      expect(codes(r)).toContain('EXTRACT_UNGROUNDED');
    },
  },
  {
    name: 'R-EX2: keeps a feature when only one of its refs has an unknown handle',
    ex: extraction([feature({ sources: [ref('c99', UPGRADE_QUOTE), ref(H.upgrade, UPGRADE_QUOTE)] })]),
    check: (r) => {
      expect(firstFeature(r).sources).toHaveLength(1);
      expect(codes(r)).toContain('EXTRACT_QUOTE_NOT_FOUND');
    },
  },
  {
    name: 'R-EX2: accepts the bracketed handle form [c3]',
    ex: extraction([feature({ sources: [ref('[c3]', UPGRADE_QUOTE)] })]),
    check: (r) => expect(firstFeature(r).sources[0]?.chunkId).toBe(chunks.upgrade.id),
  },
  {
    name: 'R-EX2: accepts an upper-case handle C3',
    ex: extraction([feature({ sources: [ref('C3', UPGRADE_QUOTE)] })]),
    check: (r) => expect(firstFeature(r).sources[0]?.chunkId).toBe(chunks.upgrade.id),
  },
  {
    name: 'R-EX2: refuses raw chunk ids instead of handles (no fabricated addresses)',
    ex: extraction([feature({ sources: [ref(chunks.upgrade.id, UPGRADE_QUOTE)] })]),
    check: (r) => {
      expect(r.drafts).toEqual([]);
      expect(codes(r)).toContain('EXTRACT_QUOTE_NOT_FOUND');
    },
  },
  {
    name: 'R-EX2: downgrades a source ref that points at a context chunk to relation context',
    ex: extraction([feature({ sources: [ref(H.context, 'paid tier of the product'), ref(H.upgrade, UPGRADE_QUOTE)] })]),
    check: (r) => {
      const refs = firstFeature(r).sources;
      expect(refs).toContainEqual({ chunkId: chunks.context.id, relation: 'context', quote: 'paid tier of the product' });
      expect(refs).toContainEqual({ chunkId: chunks.upgrade.id, relation: 'source', quote: UPGRADE_QUOTE });
    },
  },
  {
    name: 'R-EX2: a feature that cites only a context chunk is ungrounded and dropped',
    ex: extraction([feature({ sources: [ref(H.context, 'paid tier of the product')] })]),
    check: (r) => {
      expect(r.drafts).toEqual([]);
      expect(codes(r)).toContain('EXTRACT_UNGROUNDED');
    },
  },
  {
    name: 'R-EX2: a context-relation ref on a section chunk never grounds a feature',
    ex: extraction([feature({ sources: [ref(H.upgrade, UPGRADE_QUOTE, 'context')] })]),
    check: (r) => expect(r.drafts).toEqual([]),
  },
  {
    name: 'R-EX2: a context ref with a non-verbatim quote is kept without the quote',
    ex: extraction([feature({ sources: [ref(H.upgrade, UPGRADE_QUOTE), ref(H.context, 'something invented here', 'context')] })]),
    check: (r) => {
      const ctxRef = firstFeature(r).sources.find((s) => s.relation === 'context');
      expect(ctxRef).toEqual({ chunkId: chunks.context.id, relation: 'context' });
    },
  },
];

const quoteCases: Case[] = [
  {
    name: 'R-EX2: quote matching ignores case and whitespace runs',
    ex: extraction([feature({ sources: [ref(H.upgrade, 'UPGRADE   from the\nfree PLAN to the pro plan')] })]),
    check: (r) => expect(firstFeature(r).sources[0]?.quote).toBe('UPGRADE from the free PLAN to the pro plan'),
  },
  {
    name: 'R-EX2: quote matching treats curly quotes, dashes and ellipses as equivalent (normalizeForQuote)',
    ex: extraction([feature({ sources: [ref(H.curly, `says "you'll lose Pro features" - and a refund note...`)] })]),
    check: (r) => expect(firstFeature(r).sources[0]?.chunkId).toBe(chunks.curly.id),
  },
  {
    name: 'R-EX2: rejects a quote shorter than minQuoteChars of a longer chunk',
    ex: extraction([feature({ sources: [ref(H.upgrade, 'Free plan')] })]),
    check: (r) => expect(r.drafts).toEqual([]),
  },
  {
    name: 'R-EX2: accepts a quote of exactly minQuoteChars characters',
    ex: extraction([feature({ sources: [ref(H.upgrade, 'Customers ca')] })]),
    check: (r) => expect(r.drafts).toHaveLength(1),
  },
  {
    name: 'R-EX2: rejects a quote one character below minQuoteChars',
    ex: extraction([feature({ sources: [ref(H.upgrade, 'Customers c')] })]),
    check: (r) => expect(r.drafts).toEqual([]),
  },
  {
    name: 'R-EX2: a short chunk may be quoted in full below minQuoteChars (min rule)',
    ex: extraction([feature({ sources: [ref(H.short, 'Pro shown')] })]),
    check: (r) => expect(firstFeature(r).sources[0]?.chunkId).toBe(chunks.short.id),
  },
  {
    name: 'R-EX2: a partial quote of a short chunk below its length is rejected',
    ex: extraction([feature({ sources: [ref(H.short, 'Pro')] })]),
    check: (r) => expect(r.drafts).toEqual([]),
  },
  {
    name: 'R-EX2: minQuoteChars from config is honored (30 rejects a 26-char quote)',
    ex: extraction([feature({ sources: [ref(H.upgrade, 'upgrade from the Free plan')] })]),
    opts: { minQuoteChars: 30 },
    check: (r) => expect(r.drafts).toEqual([]),
  },
  {
    name: 'R-EX2: minQuoteChars from config is honored (12 accepts the same 26-char quote)',
    ex: extraction([feature({ sources: [ref(H.upgrade, 'upgrade from the Free plan')] })]),
    opts: { minQuoteChars: 12 },
    check: (r) => expect(r.drafts).toHaveLength(1),
  },
  {
    name: 'R-EX2: rejects a null quote on a source ref',
    ex: extraction([feature({ sources: [ref(H.upgrade, null)] })]),
    check: (r) => expect(r.drafts).toEqual([]),
  },
  {
    name: 'R-EX2: rejects an empty and a whitespace-only quote',
    ex: extraction([feature({ sources: [ref(H.upgrade, ''), ref(H.upgrade, '   ')] })]),
    check: (r) => expect(r.drafts).toEqual([]),
  },
  {
    name: 'R-EX2: rejects a quote spanning two chunks',
    ex: extraction([feature({ sources: [ref(H.upgrade, 'from the billing page. Downgrading to Free shows')] })]),
    check: (r) => expect(r.drafts).toEqual([]),
  },
  {
    name: 'R-EX2: rejects a Unicode confusable (Cyrillic a) in a quote',
    ex: extraction([feature({ sources: [ref(H.upgrade, 'upgrаde from the Free plan')] })]),
    check: (r) => expect(r.drafts).toEqual([]),
  },
  {
    name: 'R-EX2: rejects a quote taken from a different chunk than the cited handle',
    ex: extraction([feature({ sources: [ref(H.upgrade, DOWNGRADE_QUOTE)] })]),
    check: (r) => expect(r.drafts).toEqual([]),
  },
  {
    name: 'R-EX2: deduplicates identical references',
    ex: extraction([feature({ sources: [ref(H.upgrade, UPGRADE_QUOTE), ref(H.upgrade, UPGRADE_QUOTE)] })]),
    check: (r) => expect(firstFeature(r).sources).toHaveLength(1),
  },
];

const groundingCases: Case[] = [
  {
    name: 'R-EX2: drops a feature without sources and all its scenarios (EXTRACT_UNGROUNDED)',
    ex: extraction([feature({ sources: [], scenarios: [scenario(), scenario({ title: 'Second' })] })]),
    check: (r) => {
      expect(r.drafts).toEqual([]);
      expect(codes(r)).toContain('EXTRACT_UNGROUNDED');
    },
  },
  {
    name: 'R-EX2: a scenario without its own sources inherits the feature refs when titles share a non-stopword token',
    ex: extraction([feature({ scenarios: [scenario({ sources: [], title: 'Upgrade to Pro succeeds' })] })]),
    check: (r) => expect(firstScenario(r).sources).toEqual(firstFeature(r).sources),
  },
  {
    name: 'R-EX2: a scenario without sources and without shared tokens is dropped',
    ex: extraction([feature({ scenarios: [scenario({ sources: [], title: 'Delete every user account' }), scenario({ title: 'Kept' })] })]),
    check: (r) => {
      expect(firstFeature(r).scenarios.map((s) => s.title)).toEqual(['Kept']);
      expect(codes(r)).toContain('EXTRACT_UNGROUNDED');
    },
  },
  {
    name: 'R-EX2: stopword-only overlap does not let a scenario inherit',
    ex: extraction([feature({ scenarios: [scenario({ sources: [], title: 'To the from' })] })]),
    check: (r) => expect(r.drafts).toEqual([]),
  },
  {
    name: 'R-EX2: a scenario with its own valid source is kept regardless of its title',
    ex: extraction([feature({ scenarios: [scenario({ title: 'Completely unrelated words' })] })]),
    check: (r) => expect(firstScenario(r).title).toBe('Completely unrelated words'),
  },
  {
    name: 'R-EX2: a scenario whose own quote is invalid falls back to inheritance when titles overlap',
    ex: extraction([feature({ scenarios: [scenario({ sources: [ref(H.upgrade, 'an invented sentence about upgrade')] })] })]),
    check: (r) => expect(firstScenario(r).sources).toEqual(firstFeature(r).sources),
  },
  {
    name: 'R-EX2: inherited scenario refs are independent copies of the feature refs',
    ex: extraction([feature({ scenarios: [scenario({ sources: [] })] })]),
    check: (r) => {
      const f = firstFeature(r);
      expect(firstScenario(r).sources[0]).not.toBe(f.sources[0]);
    },
  },
  {
    name: 'R-EX2: a quoted step without a valid source ref is downgraded to inferred (info)',
    ex: withSteps([step('given', 'the customer is on the Free plan', { grounding: 'quoted' }), when, then]),
    check: (r) => {
      expect(firstScenario(r).steps[0]?.grounding).toBe('inferred');
      expect(r.diagnostics.find((d) => d.code === 'EXTRACT_UNGROUNDED' && d.severity === 'info')).toBeDefined();
    },
  },
  {
    name: 'R-EX2: a quoted step with a valid source ref stays quoted',
    ex: withSteps([step('given', 'the customer is on the Free plan', { grounding: 'quoted', sources: [ref(H.upgrade, 'from the Free plan to the Pro plan')] }), when, then]),
    check: (r) => {
      const st = firstScenario(r).steps[0];
      expect(st?.grounding).toBe('quoted');
      expect(st?.sources[0]?.chunkId).toBe(chunks.upgrade.id);
    },
  },
  {
    name: 'R-EX2: a quoted step whose quote is not verbatim is downgraded to inferred',
    ex: withSteps([step('given', 'the customer is on the Free plan', { grounding: 'quoted', sources: [ref(H.upgrade, 'nothing like the real text here')] }), when, then]),
    check: (r) => {
      const st = firstScenario(r).steps[0];
      expect(st?.grounding).toBe('inferred');
      expect(st?.sources).toEqual([]);
    },
  },
  {
    name: 'R-EX2: an inferred step is kept as inferred without diagnostics',
    ex: withSteps([step('given', 'the customer is on the Free plan'), when, then]),
    check: (r) => {
      expect(firstScenario(r).steps[0]?.grounding).toBe('inferred');
      expect(r.diagnostics).toEqual([]);
    },
  },
];

// ───────────────────────── step sanity
const sanityCases: Case[] = [
  {
    name: 'R-EX2: drops a scenario with only given steps',
    ex: withSteps([step('given', 'the customer is on the Free plan'), step('given', 'the customer is logged in')]),
    check: (r) => {
      expect(r.drafts).toEqual([]);
      expect(codes(r)).toContain('EXTRACT_UNGROUNDED');
    },
  },
  {
    name: 'R-EX2: drops a scenario with no steps',
    ex: withSteps([]),
    check: (r) => expect(r.drafts).toEqual([]),
  },
  {
    name: 'R-EX2: keeps a scenario with exactly 25 steps',
    ex: withSteps([...Array.from({ length: 24 }, (_, i) => step('given', `precondition number ${i + 1}`)), when]),
    check: (r) => expect(firstScenario(r).steps).toHaveLength(25),
  },
  {
    name: 'R-EX2: drops a scenario with 26 steps',
    ex: withSteps([...Array.from({ length: 25 }, (_, i) => step('given', `precondition number ${i + 1}`)), when]),
    check: (r) => expect(r.drafts).toEqual([]),
  },
  {
    name: 'R-EX2: normalizes step text whitespace',
    ex: withSteps([step('given', '  the customer \n is   on the Free plan '), when, then]),
    check: (r) => expect(firstScenario(r).steps[0]?.text).toBe('the customer is on the Free plan'),
  },
  {
    name: 'R-EX2: drops steps with empty text',
    ex: withSteps([step('given', '   '), when, then]),
    check: (r) => expect(firstScenario(r).steps.map((s) => s.kind)).toEqual(['when', 'then']),
  },
  {
    name: 'R-EX2: drops a scenario with an empty title',
    ex: extraction([feature({ scenarios: [scenario({ title: '  ' }), scenario({ title: 'Kept' })] })]),
    check: (r) => expect(firstFeature(r).scenarios.map((s) => s.title)).toEqual(['Kept']),
  },
  {
    name: 'R-EX2: nature is kept only on then steps',
    ex: withSteps([
      step('given', 'the customer is on the Free plan', { nature: 'subjective' }),
      step('when', 'the customer clicks the Upgrade to Pro button', { nature: 'objective' }),
      step('then', 'the confirmation tone feels friendly', { nature: 'subjective' }),
    ]),
    check: (r) => {
      const steps = firstScenario(r).steps;
      expect(steps.map((s) => s.nature)).toEqual([undefined, undefined, 'subjective']);
      expect(Object.keys(steps[0] ?? {})).not.toContain('nature');
    },
  },
  {
    name: 'R-EX2: requiresState is kept only on given steps',
    ex: withSteps([
      step('given', 'a customer with state the UI cannot create', { requiresState: true }),
      step('when', 'the customer clicks the Upgrade to Pro button', { requiresState: true }),
      step('then', 'the plan badge shows Pro', { requiresState: true }),
    ]),
    check: (r) => expect(firstScenario(r).steps.map((s) => s.requiresState)).toEqual([true, undefined, undefined]),
  },
  {
    name: 'R-EX3: model tags cannot smuggle the runner-honored fuzzy directive tag',
    ex: extraction([feature({ tags: ['@fuzzy', 'Billing', 'billing', 'bad tag!'], scenarios: [scenario({ tags: ['FUZZY', '@smoke'] })] })]),
    check: (r) => {
      expect(firstFeature(r).tags).toEqual(['Billing', 'billing']);
      expect(firstScenario(r).tags).toEqual(['smoke']);
    },
  },
  {
    name: 'R-EX2: story and description are normalized and optional parts omitted',
    ex: extraction([feature({ story: { asA: ' customer ', iWant: 'to  upgrade', soThat: null }, description: '  A  description ' })]),
    check: (r) => {
      expect(firstFeature(r).story).toEqual({ asA: 'customer', iWant: 'to upgrade' });
      expect(firstFeature(r).description).toBe('A description');
    },
  },
];

// ───────────────────────── params
const paramCases: Case[] = [
  {
    name: 'R-EX2: keeps a param whose value occurs verbatim in the step text',
    ex: withSteps([step('when', 'the customer selects the Pro plan', { params: [{ name: 'plan', value: 'Pro' }] }), then]),
    check: (r) => expect(firstScenario(r).steps[0]?.params).toEqual({ plan: 'Pro' }),
  },
  {
    name: 'R-EX2: param matching is case-insensitive and keeps the text casing',
    ex: withSteps([step('when', 'the customer selects the Pro plan', { params: [{ name: 'plan', value: 'pro plan' }] }), then]),
    check: (r) => expect(firstScenario(r).steps[0]?.params).toEqual({ plan: 'Pro plan' }),
  },
  {
    name: 'R-EX2: drops a param whose value is not in the step text',
    ex: withSteps([step('when', 'the customer selects the Pro plan', { params: [{ name: 'plan', value: 'Enterprise' }] }), then]),
    check: (r) => expect(firstScenario(r).steps[0]?.params).toEqual({}),
  },
  {
    name: 'R-EX2: the first of two params with the same name wins',
    ex: withSteps([
      step('when', 'the customer selects the Pro plan', {
        params: [
          { name: 'plan', value: 'Pro' },
          { name: 'plan', value: 'plan' },
        ],
      }),
      then,
    ]),
    check: (r) => expect(firstScenario(r).steps[0]?.params).toEqual({ plan: 'Pro' }),
  },
  {
    name: 'R-EX3: param names that could pollute prototypes are dropped',
    ex: withSteps([step('when', 'the customer selects the Pro plan', { params: [{ name: '__proto__', value: 'Pro' }] }), then]),
    check: (r) => expect(Object.keys(firstScenario(r).steps[0]?.params ?? { x: 1 })).toEqual([]),
  },
  {
    name: 'R-EX2: drops a param with an empty value',
    ex: withSteps([step('when', 'the customer selects the Pro plan', { params: [{ name: 'plan', value: '' }] }), then]),
    check: (r) => expect(firstScenario(r).steps[0]?.params).toEqual({}),
  },
];

// ───────────────────────── fixtures (R-FX1, R-EX3)
const fxText = 'the account is on the pro plan with 2 unpaid invoices';
function fx(args: { name: string; value: string | number | boolean }[], over: { name?: string; kind?: 'given' | 'when'; text?: string } = {}): Extraction {
  const kind = over.kind ?? 'given';
  return withSteps([
    step(kind, over.text ?? fxText, { requiresState: kind === 'given' ? true : null, fixture: { name: over.name ?? 'seedAccount', args } }),
    ...(kind === 'given' ? [when] : []),
    then,
  ]);
}
const fixtureCases: Case[] = [
  {
    name: 'R-FX1: keeps a catalog fixture whose args match the descriptor and the step text',
    ex: fx([
      { name: 'plan', value: 'pro' },
      { name: 'unpaid', value: 2 },
    ]),
    check: (r) => {
      const st = firstScenario(r).steps[0];
      expect(st?.fixture).toEqual({ name: 'seedAccount', args: { plan: 'pro', unpaid: 2 } });
      expect(st?.requiresState).toBe(true);
      expect(codes(r)).not.toContain('EXTRACT_FIXTURE_INVALID');
    },
  },
  {
    name: 'R-FX1: optional params may be omitted',
    ex: fx([{ name: 'plan', value: 'pro' }]),
    check: (r) => expect(firstScenario(r).steps[0]?.fixture).toEqual({ name: 'seedAccount', args: { plan: 'pro' } }),
  },
  {
    name: 'R-FX1: string args match the step text case-insensitively',
    ex: fx([{ name: 'plan', value: 'pro' }], { text: 'the account is on the PRO plan' }),
    check: (r) => expect(firstScenario(r).steps[0]?.fixture?.args).toEqual({ plan: 'pro' }),
  },
  {
    name: 'R-FX1: a non-derived boolean arg is rejected (it cannot be tied to the step text)',
    ex: fx([
      { name: 'plan', value: 'pro' },
      { name: 'trial', value: true },
    ]),
    check: (r) => {
      expect(firstScenario(r).steps[0]?.fixture).toBeUndefined();
      expect(codes(r)).toContain('EXTRACT_FIXTURE_INVALID');
    },
  },
  {
    name: 'R-FX1: a derived boolean arg is accepted when typed correctly',
    ex: fx([{ name: 'flag', value: false }], { name: 'toggleFlag', text: 'the feature flag is switched' }),
    opts: { input: { fixtures: [{ name: 'toggleFlag', description: 'Sets a flag', params: { flag: { type: 'boolean', derived: true } } }] } },
    check: (r) => expect(firstScenario(r).steps[0]?.fixture?.args).toEqual({ flag: false }),
  },
  {
    name: 'R-FX1: a number arg must occur as a whole token in the step text',
    ex: fx([
      { name: 'plan', value: 'pro' },
      { name: 'unpaid', value: 7 },
    ]),
    check: (r) => {
      expect(firstScenario(r).steps[0]?.fixture).toBeUndefined();
      expect(codes(r)).toContain('EXTRACT_FIXTURE_INVALID');
    },
  },
  {
    name: 'R-FX1: a number arg that is only a fragment of a longer number is rejected',
    ex: fx([
      { name: 'plan', value: 'pro' },
      { name: 'unpaid', value: 2 },
    ], { text: 'the account is on the pro plan with 120 unpaid invoices' }),
    check: (r) => expect(firstScenario(r).steps[0]?.fixture).toBeUndefined(),
  },
  {
    name: 'R-FX1: a derived number arg need not occur in the step text',
    ex: fx([{ name: 'count', value: 7 }], { name: 'seedCount', text: 'the account has many invoices' }),
    opts: { input: { fixtures: [{ name: 'seedCount', description: 'Seeds invoices', params: { count: { type: 'number', derived: true } } }] } },
    check: (r) => expect(firstScenario(r).steps[0]?.fixture?.args).toEqual({ count: 7 }),
  },
  {
    name: 'R-FX1: a derived string param need not occur verbatim in the step text',
    ex: fx([
      { name: 'plan', value: 'pro' },
      { name: 'note', value: 'computed elsewhere' },
    ]),
    check: (r) => expect(firstScenario(r).steps[0]?.fixture?.args).toEqual({ plan: 'pro', note: 'computed elsewhere' }),
  },
  {
    name: 'R-FX1: removes a fixture that is not in the catalog and sets requiresState',
    ex: fx([{ name: 'plan', value: 'pro' }], { name: 'dropAllTables' }),
    check: (r) => {
      const st = firstScenario(r).steps[0];
      expect(st?.fixture).toBeUndefined();
      expect(st?.requiresState).toBe(true);
      expect(r.diagnostics.find((d) => d.code === 'EXTRACT_FIXTURE_INVALID')?.severity).toBe('warning');
    },
  },
  {
    name: 'R-EX3: a string arg that does not occur in the step text removes the fixture (off-text args)',
    ex: fx([{ name: 'plan', value: 'enterprise' }]),
    check: (r) => {
      expect(r.drafts).toHaveLength(1);
      expect(firstScenario(r).steps[0]?.fixture).toBeUndefined();
      expect(firstScenario(r).steps[0]?.requiresState).toBe(true);
      expect(codes(r)).toContain('EXTRACT_FIXTURE_INVALID');
    },
  },
  {
    name: 'R-FX1: a missing required param removes the fixture',
    ex: fx([{ name: 'unpaid', value: 2 }]),
    check: (r) => {
      expect(firstScenario(r).steps[0]?.fixture).toBeUndefined();
      expect(codes(r)).toContain('EXTRACT_FIXTURE_INVALID');
    },
  },
  {
    name: 'R-FX1: a wrongly typed arg (string for number) removes the fixture',
    ex: fx([
      { name: 'plan', value: 'pro' },
      { name: 'unpaid', value: 'two' },
    ]),
    check: (r) => expect(firstScenario(r).steps[0]?.fixture).toBeUndefined(),
  },
  {
    name: 'R-FX1: a wrongly typed arg (number for boolean) removes the fixture',
    ex: fx([
      { name: 'plan', value: 'pro' },
      { name: 'trial', value: 1 },
    ]),
    check: (r) => expect(firstScenario(r).steps[0]?.fixture).toBeUndefined(),
  },
  {
    name: 'R-FX1: an enum violation removes the fixture even when the text contains the value',
    ex: fx([{ name: 'plan', value: 'enterprise' }], { text: 'the account is on the enterprise plan' }),
    check: (r) => expect(firstScenario(r).steps[0]?.fixture).toBeUndefined(),
  },
  {
    name: 'R-EX3: an arg that is not declared by the descriptor removes the fixture',
    ex: fx([
      { name: 'plan', value: 'pro' },
      { name: 'isAdmin', value: true },
    ]),
    check: (r) => expect(firstScenario(r).steps[0]?.fixture).toBeUndefined(),
  },
  {
    name: 'R-FX1: duplicate arg names remove the fixture',
    ex: fx([
      { name: 'plan', value: 'pro' },
      { name: 'plan', value: 'free' },
    ]),
    check: (r) => expect(firstScenario(r).steps[0]?.fixture).toBeUndefined(),
  },
  {
    name: 'R-FX1: fixtures on when steps are removed',
    ex: fx([{ name: 'plan', value: 'pro' }], { kind: 'when' }),
    check: (r) => {
      expect(firstScenario(r).steps[0]?.fixture).toBeUndefined();
      expect(codes(r)).toContain('EXTRACT_FIXTURE_INVALID');
    },
  },
  {
    name: 'R-EX3: object-prototype names cannot be used as fixture arg names',
    ex: fx([{ name: 'constructor', value: 'pro' }]),
    check: (r) => expect(firstScenario(r).steps[0]?.fixture).toBeUndefined(),
  },
  {
    name: 'R-FX1: with an empty catalog every fixture is rejected',
    ex: fx([{ name: 'plan', value: 'pro' }]),
    opts: { input: { fixtures: [] } },
    check: (r) => {
      expect(firstScenario(r).steps[0]?.fixture).toBeUndefined();
      expect(codes(r)).toContain('EXTRACT_FIXTURE_INVALID');
    },
  },
];

// ───────────────────────── secrets
const secretCases: Case[] = [
  {
    name: 'R-EX3: a known secret token in step text is kept as written',
    ex: withSteps([step('when', 'the admin fills the password with <secret:adminPassword>'), then]),
    check: (r) => expect(firstScenario(r).steps[0]?.text).toBe('the admin fills the password with <secret:adminPassword>'),
  },
  {
    name: 'R-EX3: a step with an unknown secret token is dropped with SECRET_MISSING',
    ex: withSteps([step('given', 'the admin is known'), step('when', 'the admin fills the password with <secret:rootKey>'), when, then]),
    check: (r) => {
      expect(firstScenario(r).steps.map((s) => s.kind)).toEqual(['given', 'when', 'then']);
      expect(firstScenario(r).steps.some((s) => s.text.includes('rootKey'))).toBe(false);
      const d = r.diagnostics.find((x) => x.code === 'SECRET_MISSING');
      expect(d?.severity).toBe('warning');
    },
  },
  {
    name: 'R-EX3: dropping a secret step that leaves no when/then drops the scenario',
    ex: withSteps([step('given', 'the admin is known'), step('then', 'the secret <secret:nope> is displayed')]),
    check: (r) => {
      expect(r.drafts).toEqual([]);
      expect(codes(r)).toContain('SECRET_MISSING');
    },
  },
  {
    name: 'R-EX3: secret token names are case-sensitive',
    ex: withSteps([step('when', 'the admin fills the password with <secret:AdminPassword>'), when, then]),
    check: (r) => expect(codes(r)).toContain('SECRET_MISSING'),
  },
  {
    name: 'R-EX3: no secrets configured means every secret token is rejected',
    ex: withSteps([step('when', 'the admin fills the password with <secret:adminPassword>'), when, then]),
    opts: { input: { secretNames: [] } },
    check: (r) => expect(codes(r)).toContain('SECRET_MISSING'),
  },
];

// ───────────────────────── rejected fingerprints (R-EX5) and notTestable
function fingerprintOf(title: string, steps: { kind: string; text: string }[]): string {
  return sha256Hex(canonicalJson({ t: normalizeForQuote(title), s: steps.map((s) => [s.kind, normalizeForQuote(s.text)]) }));
}
const defaultSteps = scenario().steps.map((s) => ({ kind: s.kind, text: s.text }));
const rejectedCases: Case[] = [
  {
    name: 'R-EX5: drops scenarios whose fingerprint is in the rejected list (info)',
    ex: extraction([feature({ scenarios: [scenario(), scenario({ title: 'Other', steps: [when, then] })] })]),
    opts: { input: { rejected: [{ fingerprint: fingerprintOf('Upgrade to Pro', defaultSteps), title: 'Upgrade to Pro' }] } },
    check: (r) => {
      expect(firstFeature(r).scenarios.map((s) => s.title)).toEqual(['Other']);
      expect(r.diagnostics.find((d) => d.details !== undefined && d.details !== null && typeof d.details === 'object' && 'fingerprint' in d.details)?.severity).toBe('info');
    },
  },
  {
    name: 'R-EX5: the rejected fingerprint ignores case and whitespace like the planner fingerprint',
    ex: extraction([feature({ scenarios: [scenario({ title: '  UPGRADE   to pro ' })] })]),
    opts: { input: { rejected: [{ fingerprint: fingerprintOf('Upgrade to Pro', defaultSteps), title: 'x' }] } },
    check: (r) => expect(r.drafts).toEqual([]),
  },
  {
    name: 'R-EX5: scenarios with other fingerprints are kept',
    ex: extraction(),
    opts: { input: { rejected: [{ fingerprint: 'f'.repeat(64), title: 'Something else' }] } },
    check: (r) => expect(r.drafts).toHaveLength(1),
  },
  {
    name: 'R-EX5: a feature whose scenarios were all rejected is dropped',
    ex: extraction(),
    opts: { input: { rejected: [{ fingerprint: fingerprintOf('Upgrade to Pro', defaultSteps), title: 'Upgrade to Pro' }] } },
    check: (r) => expect(r.drafts).toEqual([]),
  },
];

const notTestableCases: Case[] = [
  {
    name: 'R-EX4: notTestable handles are mapped back to chunk ids',
    ex: extraction([], [{ handle: H.perf, reason: 'Latency target, not observable in the UI' }]),
    check: (r) => expect(r.notTestable).toEqual([{ chunkId: chunks.perf.id, reason: 'Latency target, not observable in the UI' }]),
  },
  {
    name: 'R-EX4: unknown notTestable handles are ignored',
    ex: extraction([], [{ handle: 'c42', reason: 'whatever' }]),
    check: (r) => {
      expect(r.notTestable).toEqual([]);
      expect(codes(r)).toContain('EXTRACT_QUOTE_NOT_FOUND');
    },
  },
  {
    name: 'R-EX4: notTestable entries for context chunks are ignored',
    ex: extraction([], [{ handle: H.context, reason: 'glossary' }]),
    check: (r) => expect(r.notTestable).toEqual([]),
  },
  {
    name: 'R-EX4: duplicate notTestable chunks keep the first reason',
    ex: extraction([], [
      { handle: H.perf, reason: 'first' },
      { handle: 'c5', reason: 'second' },
    ]),
    check: (r) => expect(r.notTestable).toEqual([{ chunkId: chunks.perf.id, reason: 'first' }]),
  },
];

const allCases: Case[] = [
  ...handleCases,
  ...quoteCases,
  ...groundingCases,
  ...sanityCases,
  ...paramCases,
  ...fixtureCases,
  ...secretCases,
  ...rejectedCases,
  ...notTestableCases,
];

describe('extract validators (table)', () => {
  it('has at least 40 validator cases', () => {
    expect(allCases.length).toBeGreaterThanOrEqual(40);
  });

  it('R-EX2: every case name carries a requirement id', () => {
    for (const c of allCases) expect(c.name).toMatch(/^R-(EX|FX)\d/);
  });

  it.each(allCases)('$name', async ({ ex, opts, check }) => {
    check(await run(ex, opts));
  });
});

describe('extract validator ordering', () => {
  it('R-EX2: reports every stage over a mixed output without throwing', async () => {
    const r = await run(
      extraction([
        feature({ title: 'Ungrounded', sources: [] }),
        feature({
          scenarios: [
            scenario({ sources: [ref(H.upgrade, 'not in the text at all')], title: 'Upgrade works' }),
            scenario({ title: 'Secret step', steps: [step('when', 'uses <secret:zzz>')] }),
          ],
        }),
      ]),
    );
    expect(codes(r)).toEqual(expect.arrayContaining(['EXTRACT_QUOTE_NOT_FOUND', 'EXTRACT_UNGROUNDED', 'SECRET_MISSING']));
    expect(r.failed).toBe(false);
    expect(r.diagnostics.every((d) => d.uri === 'docs/billing.md')).toBe(true);
  });
});
