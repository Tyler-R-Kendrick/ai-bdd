import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderTree } from '@ai-bdd/sdk';
import { verify } from '@ai-bdd/verify';
import { buildNodes, parseElements, settleHash } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** A window state captured from a real cua-driver 0.34 (Linux, X11, AT-SPI) driving Chromium on the Acme billing page. */
const captured = JSON.parse(readFileSync(join(here, 'fixtures', 'acme-billing.window-state.json'), 'utf8')) as { window_title: string; elements: Record<string, unknown>[] };
const elements = parseElements({ elements: captured.elements });

describe('mapping of a window state captured from the real Cua Driver', () => {
  it('the whole window, as the driver would hand it to ai-bdd', async () => {
    await verify(renderTree(buildNodes(elements, 1, { scope: 'window', secrets: [] }).nodes, { refs: true }), { extension: 'txt' });
  });

  it('the page content only (what a browser session observes), the part the scenarios and recordings depend on', async () => {
    await verify(renderTree(buildNodes(elements, 1, { scope: 'content', secrets: [] }).nodes, { refs: false }), { extension: 'txt' });
  });

  it('the settle hash does not depend on the text of live regions', () => {
    const base = buildNodes(elements, 1, { scope: 'content', secrets: [] }).nodes;
    expect(base.some((n) => n.role === 'status')).toBe(true);
    const later = base.map((n) => (n.role === 'status' ? { ...n, name: `${n.name} (later)` } : n));
    const hash = (nodes: typeof base) => settleHash(nodes, (ns) => renderTree(ns, { refs: false }));
    expect(hash(later)).toBe(hash(base));
  });
});
