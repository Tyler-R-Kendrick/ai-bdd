import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { treeHash } from '@ai-bdd/sdk';
import type { ObservedNode } from '@ai-bdd/sdk/contracts';
import { ariaRole, buildNodes, cleanLabel, parseElements, settleHash, type CuaElement } from '@ai-bdd/driver-cua';
import { cpuMs, hostileString, jsonValue, params } from './helpers.ts';

// ───────────────────────── generators

const PLATFORM_ROLES = [
  'push button', 'toggle button', 'check box', 'radio button', 'entry', 'password text', 'text', 'label', 'static', 'link', 'heading', 'list', 'list item', 'panel', 'filler',
  'section', 'document web', 'frame', 'dialog', 'status bar', 'progress bar', 'page tab', 'table cell', 'tree item', 'menu item', 'combo box', 'unknown', 'Push-Button', 'PushButton',
  'AXButton', 'AXSecureTextField', 'status', 'timer', 'log', 'marquee', '', ' ', '___', '😀', 'constructor', '__proto__',
];
const role = fc.oneof({ weight: 5, arbitrary: fc.constantFrom(...PLATFORM_ROLES) }, { weight: 1, arbitrary: hostileString({ maxLength: 16 }) });
const label = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom('Sign in', 'Name', '• Item', '\ufffc', 'a\ufffcb', '  spaced   out  ', 'Password', '') },
  { weight: 2, arbitrary: hostileString({ maxLength: 40 }) },
);

interface Secret { value: string }
const secretValue = fc.string({ minLength: 4, maxLength: 12, unit: fc.constantFrom(...'ABCDEFGHJKLMNPQRSTUVWXYZ23456789-_.@') });

function elementsArb(opts: { unique: boolean; secrets: readonly string[] }): fc.Arbitrary<CuaElement[]> {
  const embed = (base: fc.Arbitrary<string>): fc.Arbitrary<string> =>
    opts.secrets.length === 0 ? base : fc.oneof({ weight: 3, arbitrary: base }, { weight: 2, arbitrary: fc.tuple(base, fc.constantFrom(...opts.secrets), base).map(([a, s, b]) => `${a}${s}${b}`) });
  return fc.integer({ min: 0, max: 40 }).chain((n) =>
    fc.array(
      fc.record(
        {
          role,
          label: embed(label),
          value: embed(fc.oneof(label, fc.constant(''))),
          description: label,
          enabled: fc.boolean(),
          selected: fc.boolean(),
          checked: fc.boolean(),
          expanded: fc.boolean(),
          focused: fc.boolean(),
          in_web_content: fc.boolean(),
          parent_index: fc.oneof(fc.integer({ min: -2, max: Math.max(1, n) + 2 }), fc.constant(undefined)),
          actions: fc.array(fc.string({ maxLength: 5 }), { maxLength: 2 }),
          element_index: fc.integer({ min: 0, max: Math.max(1, n) + 2 }),
        },
        { requiredKeys: ['role'] },
      ),
      { maxLength: n },
    ).map((rows) =>
      rows.map((r, i) => {
        const idx = opts.unique ? i : (r.element_index ?? i);
        const out: CuaElement = { element_index: idx, element_token: `tok${i}`, role: r.role };
        for (const k of ['label', 'value', 'description', 'enabled', 'selected', 'checked', 'expanded', 'focused', 'in_web_content', 'parent_index', 'actions'] as const) {
          if (r[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = r[k];
        }
        return out;
      }),
    ),
  );
}

const unique = elementsArb({ unique: true, secrets: [] });
const BUILD = { scope: 'window' as const, secrets: [] as string[] };

describe('fuzz: parseElements', () => {
  it('never throws on arbitrary structured content, and returns well-typed rows ordered by element_index', () => {
    const rows = fc.array(jsonValue({ maxDepth: 2, maxKeys: 6 }), { maxLength: 8 });
    fc.assert(
      fc.property(fc.oneof(rows.map((r) => ({ elements: r })), jsonValue({ maxDepth: 3, maxKeys: 5 }).map((v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : { elements: v })), unique.map((e) => ({ elements: e }))), (structured) => {
        const parsed = parseElements(structured as Record<string, unknown>);
        let last = Number.NEGATIVE_INFINITY;
        for (const e of parsed) {
          expect(Number.isInteger(e.element_index)).toBe(true);
          expect(typeof e.element_token).toBe('string');
          expect(typeof e.role).toBe('string');
          expect(e.element_index).toBeGreaterThanOrEqual(last);
          last = e.element_index;
          for (const k of ['label', 'value', 'description'] as const) if (e[k] !== undefined) expect(typeof e[k]).toBe('string');
          for (const k of ['enabled', 'selected', 'checked', 'expanded', 'focused', 'in_web_content'] as const) if (e[k] !== undefined) expect(typeof e[k]).toBe('boolean');
          if (e.parent_index !== undefined) expect(typeof e.parent_index).toBe('number');
          if (e.actions !== undefined) expect(e.actions.every((a) => typeof a === 'string')).toBe(true);
        }
      }),
      params(),
    );
  });

  it('keeps every addressable row and drops the others', () => {
    fc.assert(
      fc.property(unique, (els) => {
        expect(parseElements({ elements: els }).map((e) => e.element_index)).toEqual(els.map((e) => e.element_index).sort((a, b) => a - b));
        // rows without an index, token or role are skipped
        expect(parseElements({ elements: [{ element_token: 't', role: 'r' }, { element_index: 1.5, element_token: 't', role: 'r' }, { element_index: 1, role: 'r' }, { element_index: 1, element_token: 't' }, null, 5, 'x', []] })).toEqual([]);
      }),
      params(),
    );
  });
});

describe('fuzz: buildNodes', () => {
  it('builds unique refs, a parent that always comes earlier, depth = parent depth + 1, and tokens/checked maps that point at real refs', () => {
    fc.assert(
      fc.property(unique, fc.integer({ min: 0, max: 9 }), fc.constantFrom<'window' | 'content'>('window', 'content'), (els, revision, scope) => {
        const built = buildNodes(parseElements({ elements: els }), revision, { scope, secrets: [] });
        const position = new Map<string, number>();
        built.nodes.forEach((n, i) => {
          expect(n.ref).toBe(n.ref.trim());
          expect(n.ref).toMatch(new RegExp(`^r${revision}:e\\d+$`));
          expect(position.has(n.ref), `duplicate ref ${n.ref}`).toBe(false);
          position.set(n.ref, i);
          expect(n.role).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
          expect(n.name).toBe(n.name.trim());
          expect(n.name).not.toMatch(/\s\s|\ufffc/);
          if (n.parentRef === undefined) expect(n.depth).toBe(0);
          else {
            const p = position.get(n.parentRef);
            expect(p, `parent ${n.parentRef} of ${n.ref} must come earlier`).toBeDefined();
            expect(p as number).toBeLessThan(i);
            expect(n.depth).toBe((built.nodes[p as number] as ObservedNode).depth + 1);
          }
        });
        expect([...built.tokens.keys()].sort()).toEqual([...position.keys()].sort());
        for (const ref of built.checked.keys()) expect(position.has(ref)).toBe(true);
        expect(typeof built.busy).toBe('boolean');
      }),
      params(),
    );
  });

  it('never throws on duplicated indices, self- and cyclic parents, forward and dangling parents', () => {
    fc.assert(
      fc.property(elementsArb({ unique: false, secrets: [] }), (els) => {
        const built = buildNodes(els, 1, BUILD);
        for (const n of built.nodes) {
          expect(n.depth).toBeGreaterThanOrEqual(0);
          if (n.parentRef === undefined) expect(n.depth).toBe(0);
        }
      }),
      params(),
    );
  });

  it('never emits the value of a password field, whatever the role is spelled like', () => {
    const passwordRole = fc.tuple(fc.constantFrom('password text', 'Password Text', 'password-text', 'PasswordText', 'PASSWORD_TEXT', 'password  text', 'Password.Text'), fc.nat(0)).map(([r]) => r);
    fc.assert(
      fc.property(passwordRole, secretValue, label, (r, value, name) => {
        const built = buildNodes([{ element_index: 0, element_token: 't', role: r, label: name, value }], 1, BUILD);
        const node = built.nodes[0];
        expect(node?.role).toBe('textbox');
        expect(node?.value).toBeUndefined();
        expect(JSON.stringify(built.nodes)).not.toContain(value);
      }),
      params(),
    );
  });

  it('scrubs every secret from names and values; the longest secret wins over a secret it contains', () => {
    const secrets = fc.uniqueArray(secretValue, { minLength: 1, maxLength: 3 });
    fc.assert(
      fc.property(secrets.chain((s) => fc.record({ secrets: fc.constant(s), els: elementsArb({ unique: true, secrets: s }) })), ({ secrets: s, els }) => {
        const built = buildNodes(parseElements({ elements: els }), 1, { scope: 'window', secrets: s });
        const text = JSON.stringify(built.nodes);
        for (const secret of s) expect(text.includes(JSON.stringify(secret).slice(1, -1)), `${secret} leaked`).toBe(false);
      }),
      params(),
    );
    // overlapping secrets: a secret that is a prefix/suffix/part of another must not leave the rest of the longer one behind
    fc.assert(
      fc.property(secretValue, fc.stringMatching(/^[A-Z0-9]{1,6}$/), fc.constantFrom('prefix', 'suffix', 'middle'), (short, extra, where) => {
        const long = where === 'prefix' ? `${short}${extra}` : where === 'suffix' ? `${extra}${short}` : `${extra}${short}${extra}`;
        fc.pre(long !== short);
        for (const order of [[short, long], [long, short]]) {
          const built = buildNodes([{ element_index: 0, element_token: 't', role: 'entry', label: 'Field', value: long }], 1, { scope: 'window', secrets: order });
          const value = built.nodes[0]?.value ?? '';
          // the whole long secret is gone and so is every character of it: only placeholders remain
          expect(value.replace(/\[secret\]/g, ''), `secrets ${JSON.stringify(order)} left ${JSON.stringify(value)}`).toBe('');
        }
      }),
      params(),
    );
  });

  it('settleHash ignores the text of live regions and nothing else: the hash is stable when only status/timer/log/marquee text changes', () => {
    const live = new Set(['status', 'timer', 'log', 'marquee']);
    fc.assert(
      fc.property(unique, fc.stringMatching(/^[a-z0-9 ]{1,12}$/), fc.stringMatching(/^[a-z0-9 ]{1,12}$/), (els, a, b) => {
        const nodes = buildNodes(parseElements({ elements: els }), 1, BUILD).nodes;
        const retext = (suffix: string): ObservedNode[] => nodes.map((n) => (live.has(n.role) ? { ...n, name: `${n.name}${suffix}`, ...(n.value === undefined ? {} : { value: `${n.value}${suffix}` }), text: `t${suffix}` } : n));
        const before = JSON.stringify(nodes);
        expect(settleHash(retext(a), treeHash)).toBe(settleHash(retext(b), treeHash));
        expect(settleHash(nodes, treeHash)).toBe(settleHash(retext(a), treeHash));
        expect(JSON.stringify(nodes)).toBe(before);
        // text of any other role still decides: changing the first non-live node's name changes the hash
        const i = nodes.findIndex((n) => !live.has(n.role));
        if (i >= 0) {
          const changed = nodes.map((n, k) => (k === i ? { ...n, name: `${n.name}!changed` } : n));
          expect(settleHash(changed, treeHash)).not.toBe(settleHash(nodes, treeHash));
        }
      }),
      params(),
    );
  });

  it('stays fast on 5000 elements in one long parent chain and on a cycle (CPU budget)', () => {
    const chain: CuaElement[] = Array.from({ length: 5000 }, (_, i) => ({ element_index: i, element_token: `t${i}`, role: i % 3 === 0 ? 'panel' : 'push button', label: i % 3 === 0 ? '' : `b${i}`, parent_index: i - 1 }));
    const cycle = chain.map((e, i) => (i === 0 ? { ...e, parent_index: 4999 } : e));
    for (const els of [chain, cycle]) {
      const used = cpuMs(() => {
        buildNodes(els, 1, BUILD);
      });
      expect(used).toBeLessThan(5000);
    }
  });
});

describe('fuzz: ariaRole / cleanLabel', () => {
  const rawRole = fc.oneof(role, fc.string({ unit: 'binary', maxLength: 20 }), hostileString({ maxLength: 30 }));

  it('ariaRole always returns a non-empty lower-case slug (letters, digits, single hyphens) and is deterministic', () => {
    fc.assert(
      fc.property(rawRole, (raw) => {
        const r = ariaRole(raw);
        expect(r).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(ariaRole(raw)).toBe(r);
      }),
      params(),
    );
  });

  it('ariaRole is idempotent on its own output, except for the one alias that is also a platform role name ("text")', () => {
    // 'label' / 'static' / 'caption' map to the ARIA-ish "text"; as platform input, "text" is an editable entry (textbox).
    // ariaRole translates platform names once; it is never applied to its own output, so that single collision is by design.
    fc.assert(
      fc.property(rawRole, (raw) => {
        const r = ariaRole(raw);
        if (r === 'text') return;
        expect(ariaRole(r)).toBe(r);
      }),
      params({ scale: 2 }),
    );
  });

  it('ariaRole ignores case, spaces, hyphens and underscores in platform role names', () => {
    fc.assert(
      fc.property(fc.constantFrom('push button', 'check box', 'radio button', 'list item', 'table cell', 'page tab', 'status bar', 'menu item'), fc.constantFrom(' ', '-', '_', '', '  '), fc.boolean(), (name, sep, upper) => {
        const spelled = name.split(' ').join(sep);
        expect(ariaRole(upper ? spelled.toUpperCase() : spelled)).toBe(ariaRole(name));
      }),
      params(),
    );
  });

  it('cleanLabel returns trimmed text with single spaces and no object-replacement characters; an undefined label is empty', () => {
    fc.assert(
      fc.property(fc.oneof(label, hostileString({ maxLength: 60 })), role.map((r) => ariaRole(r)), (raw, r) => {
        const c = cleanLabel(raw, r);
        expect(c).not.toMatch(/\s\s|^\s|\s$|\ufffc/);
        expect(c).not.toMatch(/[^\S ]/);
        expect(cleanLabel(raw, r)).toBe(c);
        expect(c.length).toBeLessThanOrEqual(raw.length);
      }),
      params(),
    );
    expect(cleanLabel(undefined, 'button')).toBe('');
  });

  it('cleanLabel is idempotent (list markers included)', () => {
    fc.assert(
      fc.property(fc.oneof(label, hostileString({ maxLength: 40 }), fc.array(fc.constantFrom('•', '◦', ' ', '\ufffc', 'x', '\n'), { maxLength: 8 }).map((p) => p.join(''))), fc.constantFrom('listitem', 'button', 'generic'), (raw, r) => {
        const once = cleanLabel(raw, r);
        expect(cleanLabel(once, r), `${JSON.stringify(raw)} -> ${JSON.stringify(once)}`).toBe(once);
      }),
      params({ scale: 2 }),
    );
  });
});

export type { Secret };
