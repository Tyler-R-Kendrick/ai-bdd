import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAriaSnapshot, structuralTreeHash } from '../../src/tree.js';

/**
 * The golden is captured from the real headless shell (`scripts/capture-aria.mts`),
 * so this pins the format Playwright actually emits: a wrapper role (`main`),
 * quoted text content, and a `[level=n]` suffix for headings.
 */
const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/aria-snapshots.json', import.meta.url)), 'utf8'),
) as { synthetic: boolean; snapshots: Record<string, string> };

describe('V8: ariaSnapshot parser golden (captured from chromium-headless-shell)', () => {
  it('is a real capture, not a hand-written fixture', () => {
    expect(fixtures.synthetic).toBe(false);
    expect(Object.keys(fixtures.snapshots)).toContain('/settings/billing');
  });

  it('parses the wrapper role, headings and text content', () => {
    const parsed = parseAriaSnapshot(fixtures.snapshots['/settings/billing']!, 1);
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.nodes.map((node) => node.role)).toEqual(['main']);
    const children = parsed.nodes[0]?.children ?? [];
    expect(children.map((node) => `${node.role}:${node.name || (node.text ?? '')}`)).toEqual([
      'heading[1]:Billing settings',
      'paragraph:Plan: Free plan',
      'paragraph:Workspace: Acme',
      'button:Upgrade to Pro',
      'button:Downgrade',
    ]);
    expect(children[0]?.state).toEqual({ level: 1 });
  });

  it('nests dialog children and keeps accessible names', () => {
    const parsed = parseAriaSnapshot(fixtures.snapshots['/settings/billing?dialog=upgrade']!, 2);
    const dialog = parsed.nodes[0]?.children?.find((node) => node.role === 'dialog');
    expect(dialog?.name).toBe('Upgrade to Pro');
    expect(parsed.nodes[0]?.children?.map((node) => node.name || (node.text ?? ''))).toContain('Confirm upgrade');
    expect(parsed.nodes[0]?.children?.map((node) => node.name || (node.text ?? ''))).toContain('Cancel');
  });

  it('gives every node a revision-scoped ref', () => {
    const first = parseAriaSnapshot(fixtures.snapshots['/settings/billing']!, 1);
    const second = parseAriaSnapshot(fixtures.snapshots['/settings/billing']!, 2);
    expect(first.nodes[0]?.ref).toBe('r1-1');
    expect(second.nodes[0]?.ref).toBe('r2-1');
    const firstRefs = new Set([first.nodes[0]!.ref, ...(first.nodes[0]?.children ?? []).map((node) => node.ref)]);
    const secondRefs = [second.nodes[0]!.ref, ...(second.nodes[0]?.children ?? []).map((node) => node.ref)];
    expect(secondRefs.some((ref) => firstRefs.has(ref))).toBe(false);
  });

  it('records a locator descriptor per ref, with nth() for duplicates', () => {
    const parsed = parseAriaSnapshot(fixtures.snapshots['/forms/two']!, 1);
    const submits = (parsed.nodes[0]?.children ?? []).filter((node) => node.name === 'Submit');
    expect(submits.length).toBeGreaterThanOrEqual(2);
    expect(parsed.descriptors.get(submits[0]!.ref)?.selector).toMatchObject({ role: 'button', name: 'Submit' });
    expect(parsed.descriptors.get(submits[1]!.ref)?.nth).toBe(1);
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
