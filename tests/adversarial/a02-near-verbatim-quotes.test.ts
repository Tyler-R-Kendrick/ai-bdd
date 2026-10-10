// Attack 2: quotes that are near-verbatim (Unicode confusables, whitespace tricks, quotes spanning two chunks).
// Rule under attack: only `normalizeForQuote` equivalences pass (NFC, whitespace collapse, case, smart quotes, dashes, ellipsis).
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelRequest } from '@ai-bdd/sdk/contracts';
import { normalizeForQuote } from '@ai-bdd/sdk';
import { allScenarios, createProject, extraction, makeEngine, modelSet, promptChunks, readPlans, type Project, type XFeature } from './helpers/kit.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

const P1 = "Customers can upgrade from the billing page. It's the customer’s choice — “Pro” or … Free.";
const P2 = 'The confirmation dialog shows the prorated charge.';
const P3 = 'Café menu: crème brûlée costs 5 dollars today.';
const CODE = '```\nSELECT 1;\nSELECT 2;\n```';

const DOC = `# Quotes

## Section

${P1}

${P2}

${P3}

${CODE}

Plans
`;

type Verdict = 'accept' | 'reject';
interface Variant { label: string; chunk: 'P1' | 'P2' | 'P3' | 'CODE' | 'PLANS'; quote: string | ((chunks: Record<string, string>) => string); expect: Verdict }

const ZWSP = '​';
const variants: Variant[] = [
  // ── equivalences that normalizeForQuote defines (must pass)
  { label: 'exact', chunk: 'P2', quote: 'The confirmation dialog shows', expect: 'accept' },
  { label: 'upper case', chunk: 'P2', quote: 'THE CONFIRMATION DIALOG SHOWS', expect: 'accept' },
  { label: 'collapsed/extra whitespace and newlines', chunk: 'P2', quote: '  The\n\tconfirmation   dialog\r\nshows  ', expect: 'accept' },
  { label: 'NBSP and ideographic space as spaces', chunk: 'P2', quote: 'The confirmation　dialog shows', expect: 'accept' },
  { label: 'straight apostrophe for a typographic one', chunk: 'P1', quote: "It's the customer's choice", expect: 'accept' },
  { label: 'typographic quotes for straight ones', chunk: 'P1', quote: 'It’s the customer’s choice', expect: 'accept' },
  { label: 'hyphen for an em dash', chunk: 'P1', quote: "choice - \"Pro\" or", expect: 'accept' },
  { label: 'three dots for an ellipsis', chunk: 'P1', quote: 'choice - "Pro" or ... Free', expect: 'accept' },
  { label: 'decomposed (NFD) text for composed (NFC)', chunk: 'P3', quote: 'Café menu: crème brûlée costs', expect: 'accept' },
  // ── near misses that must be rejected
  { label: 'Cyrillic a for Latin a', chunk: 'P2', quote: 'The confirmаtion dialog shows', expect: 'reject' },
  { label: 'Cyrillic o and e for Latin o and e', chunk: 'P2', quote: 'Thе cоnfirmation dialog shows', expect: 'reject' },
  { label: 'Greek omicron for o', chunk: 'P2', quote: 'The cοnfirmation dialog shows', expect: 'reject' },
  { label: 'fullwidth Latin letters', chunk: 'P2', quote: 'The ｃｏｎｆｉｒｍａｔｉｏｎ dialog shows', expect: 'reject' },
  { label: 'zero width space inside a word', chunk: 'P2', quote: `The confir${ZWSP}mation dialog shows`, expect: 'reject' },
  { label: 'zero width joiner / non-joiner inside a word', chunk: 'P2', quote: 'The confir‍mation dial‌og shows', expect: 'reject' },
  { label: 'soft hyphen inside a word', chunk: 'P2', quote: 'The confir­mation dialog shows', expect: 'reject' },
  { label: 'right-to-left override wrapper', chunk: 'P2', quote: '‮The confirmation dialog shows‬', expect: 'reject' },
  { label: 'combining mark appended to a letter', chunk: 'P2', quote: 'The confirmation dialóg shows', expect: 'reject' },
  { label: 'ligature for letters (compat form)', chunk: 'P2', quote: 'The conﬁrmation dialog shows', expect: 'reject' },
  { label: 'one letter changed', chunk: 'P2', quote: 'The confirmation dialogue shows', expect: 'reject' },
  { label: 'word dropped from the middle', chunk: 'P2', quote: 'The confirmation shows the prorated', expect: 'reject' },
  { label: 'extra word appended', chunk: 'P2', quote: 'The confirmation dialog shows the prorated charge before billing', expect: 'reject' },
  { label: 'markdown emphasis added around words', chunk: 'P2', quote: 'The **confirmation** dialog shows', expect: 'reject' },
  { label: 'digit lookalike (l for 1)', chunk: 'P3', quote: 'costs 5 dollars today', expect: 'accept' },
  { label: 'digit changed', chunk: 'P3', quote: 'costs 6 dollars today', expect: 'reject' },
  { label: 'lone surrogate / replacement char', chunk: 'P2', quote: 'The confirmation dialog sh�ws', expect: 'reject' },
  // ── spans and lengths
  { label: 'quote spans the end of one chunk and the start of the next (space joined)', chunk: 'P1', quote: (c) => `${c['P1']?.slice(-15)} ${c['P2']?.slice(0, 15)}`, expect: 'reject' },
  { label: 'quote spans two chunks (newline joined)', chunk: 'P2', quote: (c) => `${c['P2']?.slice(-15)}\n${c['P3']?.slice(0, 15)}`, expect: 'reject' },
  { label: 'quote from chunk A cited on chunk B', chunk: 'P3', quote: 'The confirmation dialog shows', expect: 'reject' },
  { label: 'quote shorter than 12 characters of a longer chunk', chunk: 'P2', quote: 'The confirm', expect: 'reject' },
  { label: 'quote of exactly 12 characters', chunk: 'P2', quote: 'The confirma', expect: 'accept' },
  { label: 'whitespace only', chunk: 'P2', quote: '            ', expect: 'reject' },
  { label: 'empty string', chunk: 'P2', quote: '', expect: 'reject' },
  { label: 'whole short chunk', chunk: 'PLANS', quote: 'Plans', expect: 'accept' },
  { label: 'short chunk, quote one char short', chunk: 'PLANS', quote: 'Plan', expect: 'reject' },
  { label: 'code chunk: lines joined by a space instead of a newline is the same text after normalization', chunk: 'CODE', quote: 'SELECT 1; SELECT 2;', expect: 'accept' },
  { label: 'code chunk: a statement that is not there', chunk: 'CODE', quote: 'SELECT 1; DROP TABLE users;', expect: 'reject' },
];

function chunkTexts(req: ModelRequest): Record<string, { handle: string; text: string }> {
  const section = promptChunks(req).section;
  const find = (needle: string): { handle: string; text: string } | undefined => section.find((c) => c.text.includes(needle));
  const out: Record<string, { handle: string; text: string }> = {};
  const set = (k: string, c: { handle: string; text: string } | undefined): void => {
    if (c !== undefined) out[k] = c;
  };
  set('P1', find('Customers can upgrade'));
  set('P2', find('The confirmation dialog'));
  set('P3', find('Café menu'));
  set('CODE', find('SELECT 1;'));
  set('PLANS', section.find((c) => c.kind === 'paragraph' && c.text === 'Plans'));
  return out;
}

describe('A2 R-EX2 near-verbatim quotes', () => {
  it('A2 R-EX2: sanity of the normalization the table relies on', () => {
    expect(normalizeForQuote('It’s “Pro” — … x')).toBe('it\'s "pro" - ... x');
    expect(normalizeForQuote('Café')).toBe(normalizeForQuote('Café'));
    expect(normalizeForQuote(`a${ZWSP}b`)).not.toBe('ab');
  });

  it('A2 R-EX2: every near-verbatim variant is accepted or rejected exactly as the normalization rule says', async () => {
    project = createProject({ docs: [] });
    project.writeDoc('quotes', DOC);
    const models = modelSet({
      extract: (req) => {
        const texts = chunkTexts(req);
        if (texts['P1'] === undefined) return { object: extraction([]) };
        const plain = Object.fromEntries(Object.entries(texts).map(([k, v]) => [k, v.text]));
        const features: XFeature[] = variants.map((v, i) => {
          const target = texts[v.chunk];
          const quote = typeof v.quote === 'function' ? v.quote(plain) : v.quote;
          const src = { handle: target?.handle ?? 'c1', quote };
          return {
            title: `Variant ${String(i).padStart(2, '0')}`,
            sources: [src],
            scenarios: [{ title: `Scenario ${i}`, sources: [src], steps: [{ kind: 'when', text: 'the customer acts' }, { kind: 'then', text: 'something is shown' }] }],
          };
        });
        return { object: extraction(features) };
      },
    });
    const h = await makeEngine(project, { models });
    const res = await h.engine.compile();
    await h.close();
    expect(res.docs[0]?.failedSections).toEqual([]);
    const kept = new Set(allScenarios(readPlans(project)).map((s) => s.feature.title));
    const wrong: string[] = [];
    variants.forEach((v, i) => {
      const accepted = kept.has(`Variant ${String(i).padStart(2, '0')}`);
      if (accepted !== (v.expect === 'accept')) wrong.push(`${v.label}: expected ${v.expect}, got ${accepted ? 'accept' : 'reject'}`);
    });
    expect(wrong).toEqual([]);
    // every dropped variant is explained by a diagnostic naming a quote problem
    const diag = res.docs[0]?.diagnostics.filter((d) => d.code === 'EXTRACT_QUOTE_NOT_FOUND') ?? [];
    expect(diag.length).toBeGreaterThanOrEqual(variants.filter((v) => v.expect === 'reject').length);
  });

  it('A2 R-EX2: accepted quotes are stored normalized and are still substrings of the chunk (no fabricated text reaches the plan)', async () => {
    project = createProject({ docs: [] });
    project.writeDoc('quotes', DOC);
    const models = modelSet({
      extract: (req) => {
        const texts = chunkTexts(req);
        if (texts['P2'] === undefined) return { object: extraction([]) };
        const src = { handle: texts['P2'].handle, quote: '  THE\nconfirmation   DIALOG shows ' };
        return { object: extraction([{ title: 'Q', sources: [src], scenarios: [{ title: 'Q1', sources: [src], steps: [{ kind: 'when', text: 'x acts' }, { kind: 'then', text: 'y shows' }] }] }]) };
      },
    });
    const h = await makeEngine(project, { models });
    await h.engine.compile();
    await h.close();
    const plan = readPlans(project)[0];
    const feature = plan?.features[0];
    expect(feature).toBeDefined();
    for (const ref of feature?.sources ?? []) {
      const chunk = plan?.chunks.find((c) => c.id === ref.chunkId);
      expect(chunk).toBeDefined();
      expect(normalizeForQuote(P2)).toContain(normalizeForQuote(ref.quote ?? '\u0000'));
    }
  });

  it('A2 R-EX2: handle spoofing: unknown, context-relation and malformed handles never ground a feature', async () => {
    project = createProject({ docs: [] });
    project.writeDoc('quotes', `# Q\n\n## Glossary\n\n<!-- ai-bdd: context -->\nA glossary term lives here for context only and is never a source.\n\n## Section\n\nThe confirmation dialog shows the prorated charge.\n`);
    const models = modelSet({
      extract: (req) => {
        const { context, section } = promptChunks(req);
        const sec = section.find((c) => c.text.includes('The confirmation dialog'));
        const ctx = context.find((c) => c.text.includes('glossary term'));
        if (sec === undefined || ctx === undefined) return { object: extraction([]) };
        const bad = (title: string, handle: string, relation: 'source' | 'context', quote: string): XFeature => ({
          title,
          sources: [{ handle, relation, quote }],
          scenarios: [{ title: `${title} scenario`, sources: [{ handle, relation, quote }], steps: [{ kind: 'when', text: 'a acts' }, { kind: 'then', text: 'b shows' }] }],
        });
        return {
          object: extraction([
            bad('Context as source', ctx.handle, 'source', 'A glossary term lives here'),
            bad('Context as context', ctx.handle, 'context', 'A glossary term lives here'),
            bad('Unknown handle', 'c99', 'source', 'The confirmation dialog shows'),
            bad('Zero padded handle', 'c0' + sec.handle.slice(1), 'source', 'The confirmation dialog shows'),
            bad('Raw chunk id', 'docs/quotes.md#section/p1', 'source', 'The confirmation dialog shows'),
            bad('Fullwidth digit handle', `c${String.fromCharCode(0xff10 + Number(sec.handle.slice(1)))}`, 'source', 'The confirmation dialog shows'),
            bad('Legit', sec.handle, 'source', 'The confirmation dialog shows'),
          ]),
        };
      },
    });
    const h = await makeEngine(project, { models });
    const res = await h.engine.compile();
    await h.close();
    const titles = allScenarios(readPlans(project)).map((s) => s.feature.title);
    expect(titles, JSON.stringify(res.docs[0]?.diagnostics.map((d) => [d.code, d.message]))).toEqual(['Legit']);
  });

  it('A2 R-EX2: a quote that matches only the ESCAPED rendering of a chunk (the form the model is shown) is not a verbatim quote of the document', async () => {
    project = createProject({ docs: [] });
    project.writeDoc('quotes', `# Q\n\n## Section\n\nUse the closing tag < / document > to end the block of markup.\n`);
    const models = modelSet({
      extract: (req) => {
        const c = promptChunks(req).section.find((x) => x.text.includes('closing tag'));
        if (c === undefined) return { object: extraction([]) };
        const src = { handle: c.handle, quote: 'closing tag &lt; / document > to end' };
        return { object: extraction([{ title: 'Escaped', sources: [src], scenarios: [{ title: 'Escaped 1', sources: [src], steps: [{ kind: 'when', text: 'a acts' }, { kind: 'then', text: 'b shows' }] }] }]) };
      },
    });
    const h = await makeEngine(project, { models });
    await h.engine.compile();
    await h.close();
    expect(allScenarios(readPlans(project)), 'an entity-escaped quote is not a normalizeForQuote equivalence of the document text').toHaveLength(0);
  });
});
