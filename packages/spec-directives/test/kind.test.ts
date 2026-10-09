import { describe, expect, it } from 'vitest';
import type { KindsConfig, KindSource, StepKind, StepOptions } from '@ai-bdd/contracts';
import { inferKind } from '../src/index.js';

interface KindRow {
  text: string;
  keyword?: string;
  options?: StepOptions;
  bindingKind?: StepKind | 'any';
  config?: { kinds?: KindsConfig };
  kind: StepKind;
  kindSource: KindSource;
}

const ROWS: KindRow[] = [
  // 1. explicit directive wins over everything.
  { text: 'anything', options: { kind: 'setup' }, kind: 'setup', kindSource: 'directive' },
  { text: 'anything', options: { kind: 'action' }, kind: 'action', kindSource: 'directive' },
  { text: 'anything', options: { kind: 'assertion' }, kind: 'assertion', kindSource: 'directive' },
  { text: 'Given x', keyword: 'Given', options: { kind: 'action' }, kind: 'action', kindSource: 'directive' },
  { text: 'anything', options: { kind: 'setup' }, bindingKind: 'assertion', kind: 'setup', kindSource: 'directive' },
  // 2. dialect keywords (section 7.2).
  { text: 'the user is logged in', keyword: 'Given', kind: 'setup', kindSource: 'keyword' },
  { text: 'I click Save', keyword: 'When', kind: 'action', kindSource: 'keyword' },
  { text: 'the badge reads Pro', keyword: 'Then', kind: 'assertion', kindSource: 'keyword' },
  { text: 'x', keyword: 'Context', kind: 'setup', kindSource: 'keyword' },
  { text: 'x', keyword: 'Action', kind: 'action', kindSource: 'keyword' },
  { text: 'x', keyword: 'Outcome', kind: 'assertion', kindSource: 'keyword' },
  { text: 'x', keyword: 'given', kind: 'setup', kindSource: 'keyword' },
  { text: 'x', keyword: ' when ', kind: 'action', kindSource: 'keyword' },
  // conjunctions and the Gauge step marker inherit, so they fall through.
  { text: 'x', keyword: 'And', kind: 'action', kindSource: 'default' },
  { text: 'x', keyword: 'But', kind: 'action', kindSource: 'default' },
  { text: 'x', keyword: '*', kind: 'action', kindSource: 'default' },
  { text: 'x', kind: 'action', kindSource: 'default' },
  // 3. binding kind.
  { text: 'I click Save', bindingKind: 'assertion', kind: 'assertion', kindSource: 'binding' },
  { text: 'I click Save', bindingKind: 'setup', kind: 'setup', kindSource: 'binding' },
  { text: 'I click Save', bindingKind: 'any', kind: 'action', kindSource: 'default' },
  { text: 'Given x', keyword: 'Given', bindingKind: 'assertion', kind: 'setup', kindSource: 'keyword' },
  // 4. prefix + verb heuristic.
  { text: 'the plan badge reads "Pro"', kind: 'assertion', kindSource: 'prefix' },
  { text: 'a message explains the problem', kind: 'assertion', kindSource: 'prefix' },
  { text: 'no error toast is visible', kind: 'assertion', kindSource: 'prefix' },
  { text: 'verify the invoice equals 10', kind: 'assertion', kindSource: 'prefix' },
  { text: 'check the badge shows Pro', kind: 'assertion', kindSource: 'prefix' },
  { text: 'expect the list contains 3', kind: 'assertion', kindSource: 'prefix' },
  { text: 'assert the button appears', kind: 'assertion', kindSource: 'prefix' },
  { text: 'should the modal is shown', kind: 'assertion', kindSource: 'prefix' },
  { text: 'then the form is displayed', kind: 'assertion', kindSource: 'prefix' },
  { text: 'the user should see X', kind: 'assertion', kindSource: 'prefix' },
  { text: 'the invoice is not paid', kind: 'assertion', kindSource: 'prefix' },
  { text: 'the buttons are disabled', kind: 'assertion', kindSource: 'prefix' },
  { text: 'the badge shows Pro', kind: 'assertion', kindSource: 'prefix' },
  { text: 'The badge reads Pro', kind: 'assertion', kindSource: 'prefix' },
  { text: 'THE BADGE READS PRO', kind: 'assertion', kindSource: 'prefix' },
  { text: 'the plan badge reads "Pro".', kind: 'assertion', kindSource: 'prefix' },
  { text: 'the  plan   badge reads Pro', kind: 'assertion', kindSource: 'prefix' },
  // both a prefix and a verb are required.
  { text: 'verify the invoice', kind: 'action', kindSource: 'default' },
  { text: 'a message about invoices', kind: 'action', kindSource: 'default' },
  { text: 'no ', kind: 'action', kindSource: 'default' },
  { text: '', kind: 'action', kindSource: 'default' },
  // 5. plain actions.
  { text: 'Seed a workspace "Acme"', kind: 'action', kindSource: 'default' },
  { text: 'open billing settings', kind: 'action', kindSource: 'default' },
  { text: 'upgrade to Pro', kind: 'action', kindSource: 'default' },
  { text: 'click the Save button', kind: 'action', kindSource: 'default' },
  // custom configuration.
  {
    text: 'custom thing',
    config: { kinds: { assertionPrefixes: ['custom '], assertionVerbs: [' thing'] } },
    kind: 'assertion',
    kindSource: 'prefix',
  },
  {
    text: 'the badge reads Pro',
    config: { kinds: { assertionPrefixes: ['zzz '], assertionVerbs: [' reads '] } },
    kind: 'action',
    kindSource: 'default',
  },
  {
    text: 'the badge reads Pro',
    config: { kinds: { assertionPrefixes: ['the '], assertionVerbs: [' zzz '] } },
    kind: 'action',
    kindSource: 'default',
  },
];

describe('inferKind (section 7.4)', () => {
  it.each(ROWS)('$text -> $kind ($kindSource)', (row) => {
    const input: Parameters<typeof inferKind>[0] = { text: row.text };
    if (row.keyword !== undefined) input.keyword = row.keyword;
    if (row.options !== undefined) input.options = row.options;
    if (row.bindingKind !== undefined) input.bindingKind = row.bindingKind;
    if (row.config !== undefined) input.config = row.config;
    expect(inferKind(input)).toEqual({ kind: row.kind, kindSource: row.kindSource });
  });

  it('covers at least 40 sentences', () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(40);
  });
});
