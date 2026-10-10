import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { NodeStates, ObservedNode } from '@ai-bdd/sdk/contracts';
import { parseAriaSnapshot, pruneWrappers } from '@ai-bdd/driver-playwright';
import { cpuMs, hostileString, params } from './helpers.ts';

// ───────────────────────── a serializer for the observed grammar (see the header of driver-playwright/src/aria.ts)

interface Spec {
  depth: number;
  role: string;
  name: string;
  attrs: { checked?: true | 'mixed'; disabled?: true; expanded?: true; selected?: true; pressed?: true | 'mixed'; active?: true; level?: number };
  inline: string | undefined;
  quoted: boolean;
}

const ROLES = ['button', 'link', 'heading', 'textbox', 'checkbox', 'generic', 'list', 'listitem', 'navigation', 'combobox', 'option', 'dialog', 'status', 'tab', 'region', 'img'];
const names = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom('', 'Save', 'Sign in', 'Link with: colon', 'a "quoted" word', 'it\'s', 'back\\slash', '[ref=e99]', '[checked]', 'x: y', 'trailing:', '- dash', 'ünï', '😀') },
  { weight: 2, arbitrary: hostileString({ maxLength: 30 }).map((s) => s.replace(/[\r\n\u2028\u2029]/g, ' ')) },
);
const specArb: fc.Arbitrary<Spec> = fc.record({
  depth: fc.nat({ max: 4 }),
  role: fc.constantFrom(...ROLES),
  name: names,
  attrs: fc.record({ checked: fc.constantFrom(true as const, 'mixed' as const), disabled: fc.constant(true as const), expanded: fc.constant(true as const), selected: fc.constant(true as const), pressed: fc.constantFrom(true as const, 'mixed' as const), active: fc.constant(true as const), level: fc.integer({ min: 1, max: 6 }) }, { requiredKeys: [] }),
  inline: fc.option(fc.oneof(fc.constantFrom('plain text', 'Plan: Free', 'a@b.c', '12'), hostileString({ maxLength: 20 }).map((s) => s.replace(/[\r\n]/g, ' ').trim()).filter((s) => s.length > 0 && !/^['"]/.test(s))), { nil: undefined }),
  quoted: fc.boolean(),
});

/** Depth never jumps by more than one level below the previous line, as in a real tree. */
function normalizeDepths(specs: readonly Spec[]): Spec[] {
  let prev = -1;
  return specs.map((s) => {
    const depth = Math.min(s.depth, prev + 1);
    prev = depth;
    return { ...s, depth };
  });
}

function line(s: Spec, ref: string): string {
  const attrs = Object.entries(s.attrs).map(([k, v]) => (k === 'level' ? ` [level=${v}]` : v === true ? ` [${k}]` : ` [${k}=${v}]`)).join('');
  let key = `${s.role}${s.name === '' ? '' : ` ${JSON.stringify(s.name)}`}${attrs} [ref=${ref}]`;
  const hasValue = s.inline !== undefined;
  const needsQuote = s.quoted || key.includes(': ') || key.endsWith(':');
  const suffix = hasValue ? `: ${s.inline}` : '';
  if (needsQuote) {
    // the whole key is single-quoted; the value stays outside the quotes
    key = `'${key.replace(/'/g, "''")}'`;
  }
  return `${'  '.repeat(s.depth)}- ${key}${suffix}`;
}

function serialize(specs: readonly Spec[]): { text: string; refs: string[] } {
  const refs = specs.map((_, i) => `e${i + 1}`);
  return { text: specs.map((s, i) => line(s, refs[i] as string)).join('\n'), refs };
}

const VALUE_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'slider', 'combobox']);

// ───────────────────────── invariants shared by all inputs

function checkTree(nodes: readonly ObservedNode[]): void {
  const seen: ObservedNode[] = [];
  for (const n of nodes) {
    expect(Number.isInteger(n.depth) && n.depth >= 0).toBe(true);
    expect(typeof n.ref).toBe('string');
    expect(typeof n.role).toBe('string');
    expect(typeof n.name).toBe('string');
    if (n.parentRef === undefined) expect(n.depth).toBe(0);
    else {
      // the parent was read earlier and sits exactly one level up
      const parents = seen.filter((p) => p.ref === n.parentRef);
      expect(parents.length, `parent ${n.parentRef} of ${n.ref}`).toBeGreaterThan(0);
      expect(parents.some((p) => p.depth === n.depth - 1)).toBe(true);
    }
    seen.push(n);
  }
}

const isWrapper = (n: ObservedNode): boolean => n.role === 'generic' && n.name.length === 0 && n.text === undefined && n.value === undefined && n.url === undefined;

describe('fuzz: parseAriaSnapshot', () => {
  it('round-trips well-formed snapshots: role, name (hostile text included), states, level, ref, depth, parent and inline text', () => {
    fc.assert(
      fc.property(fc.array(specArb, { minLength: 1, maxLength: 12 }).map(normalizeDepths), (specs) => {
        const { text, refs } = serialize(specs);
        const nodes = parseAriaSnapshot(text);
        expect(nodes).toHaveLength(specs.length);
        const stack: number[] = [];
        specs.forEach((s, i) => {
          const n = nodes[i] as ObservedNode;
          while (stack.length > 0 && (specs[stack[stack.length - 1] as number] as Spec).depth >= s.depth) stack.pop();
          const parent = stack[stack.length - 1];
          stack.push(i);
          expect(n.ref).toBe(refs[i]);
          expect(n.role).toBe(s.role);
          expect(n.depth).toBe(s.depth);
          expect(n.parentRef).toBe(parent === undefined ? undefined : refs[parent]);
          if (s.name !== '') expect(n.name).toBe(s.name);
          const expected: NodeStates = {};
          if (s.attrs.checked !== undefined) expected.checked = s.attrs.checked;
          if (s.attrs.disabled) expected.disabled = true;
          if (s.attrs.expanded) expected.expanded = true;
          if (s.attrs.selected) expected.selected = true;
          if (s.attrs.pressed !== undefined) expected.pressed = s.attrs.pressed;
          if (s.attrs.active) expected.focused = true;
          expect(n.states).toEqual(expected);
          expect(n.level).toBe(s.attrs.level);
          if (s.inline !== undefined) {
            if (VALUE_ROLES.has(s.role)) expect(n.value).toBe(s.inline);
            else expect(n.text).toBe(s.inline);
          }
        });
        checkTree(nodes);
      }),
      params({ scale: 2 }),
    );
  });

  it('never throws and keeps the parent/depth invariants on arbitrary text, hostile and malformed lines included', () => {
    const pieces = ['- ', '  ', '    ', '\t', '"', "'", "''", ':', ': ', '[ref=e1]', '[ref=e2]', '[ref=n3]', '[level=2]', '[level=x]', '[checked=mixed]', '[', ']', 'generic', 'button', 'text', '/url', '- text: ', '"a\\"b"', '"\\u00', '\\x4', '\r', '\n', 'link ', 'heading ', '😀', '\u0000', '__proto__', 'constructor'];
    const lines = fc.array(fc.array(fc.constantFrom(...pieces), { maxLength: 8 }).map((p) => p.join('')), { maxLength: 20 }).map((l) => l.join('\n'));
    fc.assert(
      fc.property(fc.oneof(lines, hostileString({ maxLength: 300 }), fc.string({ unit: 'binary', maxLength: 100 }), fc.array(specArb, { maxLength: 8 }).map((s) => serialize(s).text)), (text) => {
        const nodes = parseAriaSnapshot(text);
        checkTree(nodes);
        for (const n of nodes) for (const key of Object.keys(n.states)) expect(['checked', 'disabled', 'expanded', 'selected', 'pressed', 'focused', 'invalid', 'busy']).toContain(key);
      }),
      params({ scale: 2 }),
    );
  });
});

describe('fuzz: pruneWrappers', () => {
  const trees = fc.array(specArb, { minLength: 1, maxLength: 14 }).map(normalizeDepths).map((specs) => parseAriaSnapshot(serialize(specs).text));
  /** Trees whose refs are not unique (the parser takes `[ref=...]` from the text as is) and whose generic nodes are often empty. */
  const duplicated = fc.array(fc.record({ depth: fc.nat({ max: 3 }), role: fc.constantFrom('generic', 'generic', 'button', 'list'), ref: fc.constantFrom('e1', 'e2', 'e3'), name: fc.constantFrom('', 'x') }), { minLength: 1, maxLength: 10 }).map((rows) => {
    let prev = -1;
    return parseAriaSnapshot(rows.map((r) => { const d = Math.min(r.depth, prev + 1); prev = d; return `${'  '.repeat(d)}- ${r.role}${r.name === '' ? '' : ` "${r.name}"`} [ref=${r.ref}]`; }).join('\n'));
  });

  it('removes exactly the presentational wrappers, keeps document order, re-parents to the nearest kept ancestor and recomputes depth', () => {
    fc.assert(
      fc.property(trees, (nodes) => {
        const pruned = pruneWrappers(nodes);
        const expectedRefs = nodes.filter((n) => !isWrapper(n)).map((n) => n.ref);
        expect(pruned.map((n) => n.ref)).toEqual(expectedRefs);
        expect(pruned.some(isWrapper)).toBe(false);
        checkTree(pruned);
        // a kept node's new parent is its nearest kept ancestor in the original tree
        const byRef = new Map(nodes.map((n) => [n.ref, n]));
        for (const n of pruned) {
          let cur = nodes.find((o) => o.ref === n.ref)?.parentRef;
          while (cur !== undefined && isWrapper(byRef.get(cur) as ObservedNode)) cur = (byRef.get(cur) as ObservedNode).parentRef;
          expect(n.parentRef).toBe(cur);
        }
        // everything but depth and parentRef is untouched, and the input is not mutated
        pruned.forEach((n) => {
          const o = nodes.find((x) => x.ref === n.ref) as ObservedNode;
          expect({ ...n, depth: 0, parentRef: undefined }).toEqual({ ...o, depth: 0, parentRef: undefined });
        });
      }),
      params(),
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(trees, (nodes) => {
        const once = pruneWrappers(nodes);
        expect(pruneWrappers(once)).toEqual(once);
      }),
      params(),
    );
  });

  it('terminates on trees with repeated refs and keeps the structural invariants', () => {
    fc.assert(
      fc.property(duplicated, (nodes) => {
        const pruned = pruneWrappers(nodes);
        expect(pruned.length).toBe(nodes.filter((n) => !isWrapper(n)).length);
        for (const n of pruned) {
          expect(n.depth).toBeGreaterThanOrEqual(0);
          if (n.parentRef === undefined) expect(n.depth).toBe(0);
        }
      }),
      params(),
    );
  });

  it('stays fast on deep and wide snapshots (CPU budget)', () => {
    const deep = Array.from({ length: 3000 }, (_, i) => `${'  '.repeat(Math.min(i, 400))}- generic [ref=e${i}]`).join('\n');
    const wide = Array.from({ length: 20_000 }, (_, i) => `- button "b${i}" [ref=e${i}]`).join('\n');
    for (const text of [deep, wide, '- '.repeat(50_000), `- ${'"'.repeat(100_000)}`]) {
      const used = cpuMs(() => {
        pruneWrappers(parseAriaSnapshot(text));
      });
      expect(used).toBeLessThan(5000);
    }
  });
});
