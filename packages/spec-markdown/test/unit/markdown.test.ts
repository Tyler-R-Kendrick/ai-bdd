import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseMarkdownSpec, inferKind } from '../../src/index.js';

const PRD = readFileSync(fileURLToPath(new URL('../../../../fixtures/specs/prd-billing.md', import.meta.url)), 'utf8');

describe('the core markdown dialect reads a PRD as a spec', () => {
  it('reads the title, the contexts and every section', () => {
    const { result } = parseMarkdownSpec(PRD, 'prd-billing.md');
    expect(result.diagnostics).toEqual([]);
    expect(result.document.name).toBe('Workspace billing');
    expect(result.document.dialect).toBe('markdown');
    expect(result.document.contexts.map((step) => step.text)).toEqual(['Seed a workspace "Acme" on the "free" plan']);
    const names = result.document.scenarios.map((scenario) => scenario.name);
    expect(names).toContain('Member upgrades to Pro');
    expect(names).toContain('Downgrade is blocked with unpaid invoices');
  });

  it('reads checkbox bullets as steps and classifies intent versus expectation', () => {
    const { result } = parseMarkdownSpec(PRD, 'prd-billing.md');
    const upgrade = result.document.scenarios.find((scenario) => scenario.name === 'Member upgrades to Pro')!;
    expect(upgrade.steps.map((step) => `${step.kind}:${step.text}`)).toEqual([
      'action:Open billing settings',
      'action:Upgrade the workspace to the Pro plan',
      'assertion:The plan badge reads "Pro"',
      'assertion:The invoice preview shows a prorated amount',
      'assertion:No error toast is visible',
    ]);
  });

  it('keeps the prose as the intent handed to the actor', () => {
    const parsed = parseMarkdownSpec(PRD, 'prd-billing.md');
    const intent = parsed.intent.get('md:prd-billing-md#member-upgrades-to-pro');
    expect(intent).toContain('pick the plan, confirm it');
    expect(parsed.specIntent).toContain('Plans are shown as tiers');
  });

  it('turns a section table into one scenario instance per row', () => {
    const { result } = parseMarkdownSpec(PRD, 'prd-billing.md');
    const rows = result.document.scenarios.filter((scenario) => scenario.name === 'Plans by row');
    expect(rows).toHaveLength(3);
    expect(rows.map((scenario) => scenario.dataRow)).toEqual([
      ['Acme', 'free'],
      ['Globex', 'pro'],
      ['Initech', 'free'],
    ]);
    expect(new Set(rows.map((scenario) => scenario.id)).size).toBe(3);
  });

  it('reads a directive into the scenario options', () => {
    const { result } = parseMarkdownSpec(PRD, 'prd-billing.md');
    const upgrade = result.document.scenarios.find((scenario) => scenario.name === 'Member upgrades to Pro')!;
    expect(upgrade.options.mode).toBe('judge');
    expect(upgrade.options.threshold).toBe(0.85);
  });
});

describe('markdown documents that are not carefully written', () => {
  it('accepts plain and numbered bullets', () => {
    const { result } = parseMarkdownSpec('# Spec\n\n## Flow\n\n- one\n* two\n+ three\n1. four\n', 'x.md');
    expect(result.document.scenarios[0]!.steps.map((step) => step.text)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('treats fenced code as opaque', () => {
    const { result } = parseMarkdownSpec('# Spec\n\n## Flow\n\n```js\n- not a step\n```\n\n- a step\n', 'x.md');
    expect(result.document.scenarios[0]!.steps.map((step) => step.text)).toEqual(['a step']);
  });

  it('reads a spec fence as nested spec text', () => {
    const { result } = parseMarkdownSpec('# Spec\n\n## Flow\n\n```spec\n- inner step\n```\n', 'x.md');
    const steps = result.document.scenarios.flatMap((scenario) => scenario.steps);
    expect(steps.map((step) => step.text)).toContain('inner step');
  });

  it('warns about a duplicate section instead of losing one', () => {
    const { result } = parseMarkdownSpec('# Spec\n\n## Flow\n\n- one\n\n## Flow\n\n- two\n', 'x.md');
    expect(result.document.scenarios).toHaveLength(2);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('MARKDOWN_DUPLICATE_SCENARIO');
    expect(new Set(result.document.scenarios.map((scenario) => scenario.id)).size).toBe(2);
  });

  it('falls back to the file name when there is no title', () => {
    const { result } = parseMarkdownSpec('- a step\n', 'notes.md');
    expect(result.document.name).toBe('notes');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('MARKDOWN_NO_TITLE');
  });

  it('reports an unknown directive key as an error', () => {
    const { result } = parseMarkdownSpec('# Spec\n<!-- ai-bdd: nonsense=1 -->\n\n## Flow\n\n- a step\n', 'x.md');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('DIRECTIVE_UNKNOWN_KEY');
  });

  it('handles CRLF, a BOM and tabs', () => {
    const { result } = parseMarkdownSpec('\uFEFF# Spec\r\n\r\n## Flow\r\n\r\n-\ta step\r\n', 'x.md');
    expect(result.document.name).toBe('Spec');
    expect(result.document.scenarios[0]!.steps.map((step) => step.text)).toEqual(['a step']);
  });

  it('never throws, whatever it is given', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(() => parseMarkdownSpec(text, 'fuzz.md')).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('keeps every location inside the input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (text) => {
        const { result } = parseMarkdownSpec(text, 'fuzz.md');
        const lineCount = text.split(/\r\n|\n|\r/u).length;
        for (const scenario of result.document.scenarios) {
          expect(scenario.location.line).toBeGreaterThanOrEqual(1);
          expect(scenario.location.line).toBeLessThanOrEqual(Math.max(lineCount, 1));
          for (const step of scenario.steps) {
            expect(step.location.line).toBeGreaterThanOrEqual(1);
            expect(step.location.line).toBeLessThanOrEqual(Math.max(lineCount, 1));
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('parses a long document quickly', () => {
    const long = ['# Spec', '', '## Flow', '', ...Array.from({ length: 5000 }, (_value, index) => `- step ${index}`)].join('\n');
    const started = performance.now();
    const { result } = parseMarkdownSpec(long, 'long.md');
    const elapsed = performance.now() - started;
    expect(result.document.scenarios[0]!.steps).toHaveLength(5000);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('kind inference', () => {
  const table: Array<[string, 'action' | 'assertion']> = [
    ['Open billing settings', 'action'],
    ['Click the upgrade button', 'action'],
    ['The plan badge reads "Pro"', 'assertion'],
    ['The invoice preview shows a prorated amount', 'assertion'],
    ['No error toast is visible', 'assertion'],
    ['A message explains that unpaid invoices must be settled first', 'assertion'],
    ['Verify the badge says Pro', 'assertion'],
    ['Expect the dialog to appear', 'assertion'],
    ['It shows the workspace name', 'assertion'],
    ['Seed 2 unpaid invoices for "Acme"', 'action'],
    ['Try to downgrade to the free plan', 'action'],
    ['Reset test data', 'action'],
    ['The dashboard heading is visible', 'assertion'],
    ['Submit the form', 'action'],
  ];
  for (const [text, expected] of table) {
    it(`classifies "${text}" as ${expected}`, () => {
      expect(inferKind(text).kind).toBe(expected);
    });
  }

  it('honours project overrides', () => {
    expect(inferKind('Open billing settings', { assertionPrefixes: ['open '], assertionVerbs: [' settings'] }).kind).toBe('assertion');
  });
});
