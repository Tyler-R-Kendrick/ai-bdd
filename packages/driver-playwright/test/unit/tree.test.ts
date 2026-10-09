import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAriaSnapshot, structuralTreeHash } from '../../src/tree.js';

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/aria-snapshots.json', import.meta.url)), 'utf8'),
) as { snapshots: Record<string, string> };

describe('V8: ariaSnapshot parser golden', () => {
  it('parses headings, paragraphs, buttons and dialogs', () => {
    const parsed = parseAriaSnapshot(fixtures.snapshots['/settings/billing']!, 1);
    expect(parsed.unparsed).toEqual([]);
    // ariaSnapshot puts text content in `: value`, so a paragraph has no accessible name.
    expect(parsed.nodes.map((node) => `${node.role}:${node.name || (node.text ?? '')}`)).toEqual([
      'heading[1]:Billing settings',
      'paragraph:Plan: Free plan',
      'paragraph:Workspace: none',
      'button:Upgrade to Pro',
      'button:Downgrade',
    ]);
    expect(parsed.nodes[0]?.state).toEqual({ level: 1 });
    expect(parsed.nodes[1]?.text).toBe('Plan: Free plan');
  });

  it('nests dialog children and keeps the accessible names', () => {
    const parsed = parseAriaSnapshot(fixtures.snapshots['/settings/billing?dialog=upgrade']!, 2);
    const dialog = parsed.nodes.find((node) => node.role === 'dialog');
    expect(dialog?.name).toBe('Upgrade to Pro');
    expect(dialog?.children?.map((child) => child.name || (child.text ?? ''))).toEqual([
      'You are upgrading to the Pro plan',
      'Confirm upgrade',
      'Cancel',
    ]);
  });

  it('gives every node a revision-scoped ref', () => {
    const first = parseAriaSnapshot(fixtures.snapshots['/settings/billing']!, 1);
    const second = parseAriaSnapshot(fixtures.snapshots['/settings/billing']!, 2);
    expect(first.nodes[0]?.ref).toBe('r1-1');
    expect(second.nodes[0]?.ref).toBe('r2-1');
    const firstRefs = new Set(first.nodes.map((node) => node.ref));
    expect(second.nodes.some((node) => firstRefs.has(node.ref))).toBe(false);
  });

  it('records a locator descriptor per ref, with nth() for duplicates', () => {
    const parsed = parseAriaSnapshot(fixtures.snapshots['/forms/two']!, 1);
    const submits = parsed.nodes.flatMap((node) => node.children ?? []).filter((node) => node.name === 'Submit');
    expect(submits).toHaveLength(2);
    expect(parsed.descriptors.get(submits[0]!.ref)?.nth).toBe(0);
    expect(parsed.descriptors.get(submits[1]!.ref)?.nth).toBe(1);
    expect(parsed.descriptors.get(submits[0]!.ref)?.selector).toMatchObject({ role: 'button', name: 'Submit' });
  });

  it('hashes the structure, not the refs, so settle detection works', () => {
    const first = parseAriaSnapshot(fixtures.snapshots['/settings/billing']!, 1);
    const second = parseAriaSnapshot(fixtures.snapshots['/settings/billing']!, 9);
    expect(structuralTreeHash(second.nodes)).toBe(structuralTreeHash(first.nodes));
    const changed = parseAriaSnapshot(fixtures.snapshots['/settings/billing?plan=pro']!, 3);
    expect(structuralTreeHash(changed.nodes)).not.toBe(structuralTreeHash(first.nodes));
  });

  it('collects unparsable lines instead of dropping them', () => {
    const parsed = parseAriaSnapshot('!!! nonsense\n- button "Ok"', 1);
    expect(parsed.unparsed).toEqual(['!!! nonsense']);
    expect(parsed.nodes).toHaveLength(1);
  });
});
