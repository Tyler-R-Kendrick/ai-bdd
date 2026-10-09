import { describe, expect, it } from 'vitest';
import { parseGaugeSpec, printGaugeSpec } from '../../src/index.js';

const SPEC = [
  '# Workspace billing',
  'Tags: billing, smoke',
  '* Seed a workspace "Acme" on the "free" plan',
  '## Member upgrades to Pro',
  '* Open billing settings',
  '* The plan badge reads "Pro"',
  '___',
  '* Reset test data',
].join('\n');

describe('R-K17: Gauge-format compatibility (not a Gauge plugin)', () => {
  it('parses the documented constructs into the shared AST', () => {
    const { document, diagnostics } = parseGaugeSpec(SPEC, 'billing.spec.md');
    expect(diagnostics).toEqual([]);
    expect(document.dialect).toBe('gauge');
    expect(document.name).toBe('Workspace billing');
    expect(document.tags).toEqual(['billing', 'smoke']);
    expect(document.scenarios).toHaveLength(1);
    // P8: a scenario's step list is contexts + scenario steps + teardown.
    expect(document.scenarios[0]?.steps.map((step) => step.text)).toEqual([
      'Seed a workspace "Acme" on the "free" plan',
      'Open billing settings',
      'The plan badge reads "Pro"',
      'Reset test data',
    ]);
    expect(document.teardown.map((step) => step.text)).toEqual(['Reset test data']);
  });

  it('keeps the printer and parser in sync (round trip without locations)', () => {
    const first = parseGaugeSpec(SPEC, 'billing.spec.md').document;
    const second = parseGaugeSpec(printGaugeSpec(first), 'billing.spec.md').document;
    const strip = (doc: typeof first) => ({
      name: doc.name,
      tags: doc.tags,
      contexts: doc.contexts.map((step) => step.text),
      teardown: doc.teardown.map((step) => step.text),
      scenarios: doc.scenarios.map((scenario) => ({
        name: scenario.name,
        steps: scenario.steps.map((step) => step.text),
      })),
    });
    expect(strip(second)).toEqual(strip(first));
  });

  it('accepts CRLF input and a UTF-8 BOM (P1)', () => {
    const crlf = `\uFEFF${SPEC.replace(/\n/gu, '\r\n')}`;
    const { diagnostics } = parseGaugeSpec(crlf, 'billing.spec.md');
    expect(diagnostics).toEqual([]);
  });

  it('never throws on arbitrary input (P10)', () => {
    for (const input of ['', '\u0000\u0000', '# '.repeat(500), '* '.repeat(200), '|', '___']) {
      expect(() => parseGaugeSpec(input, 'x.spec.md')).not.toThrow();
    }
  });
});
