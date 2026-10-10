// @ts-nocheck
// Attack 12: plan or recording nondeterminism (key order, locale, CRLF, OS path separators) (R-PL4, R-EX1).
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, stableJson, toPosix } from '@ai-bdd/sdk';
import type { JsonValue, ModelSet } from '@ai-bdd/sdk/contracts';
import { cliOutput, createProject, extraction, makeEngine, modelSet, openEngine, planFiles, quoteFrom, readRecordings, runCli, walkFiles, type Project } from './helpers/kit.ts';
import { CORPUS_DIR } from '../acceptance/helpers/paths.ts';

const projects: Project[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) p.cleanup();
});
const mk = (docs: readonly string[] = ['billing', 'todos', 'checkout']): Project => {
  const p = createProject({ docs });
  projects.push(p);
  return p;
};

describe('A12 R-PL4 plans are byte-identical whatever the environment', () => {
  it('A12 R-PL4 R-EX1: `compile` under different time zones and locales (incl. Turkish dotted/dotless i) writes identical plan bytes', async () => {
    const envs: Record<string, string>[] = [
      { TZ: 'UTC', LANG: 'C', LC_ALL: 'C' },
      { TZ: 'Asia/Kolkata', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' },
      { TZ: 'America/Los_Angeles', LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8' },
      { TZ: 'Pacific/Kiritimati', LANG: 'ja_JP.UTF-8', LC_ALL: 'ja_JP.UTF-8' },
    ];
    const outputs: Record<string, string>[] = [];
    for (const env of envs) {
      const p = mk();
      const r = await runCli(p, ['compile'], { env });
      expect(r.code, cliOutput(r)).toBe(0);
      outputs.push(planFiles(p));
    }
    for (const o of outputs.slice(1)) expect(o).toEqual(outputs[0]);
    expect(Object.keys(outputs[0] ?? {}).length).toBe(3);
  });

  it('A12 R-PL4: the same document with LF, CRLF, CR-only line endings, a UTF-8 BOM, or all of them yields byte-identical plans', async () => {
    const original = readFileSync(join(CORPUS_DIR, 'docs', 'billing.md'), 'utf8');
    const variants: Record<string, string> = {
      lf: original,
      crlf: original.replace(/\n/g, '\r\n'),
      cr: original.replace(/\n/g, '\r'),
      bom: `\ufeff${original}`,
      bomCrlf: `\ufeff${original.replace(/\n/g, '\r\n')}`,
    };
    const plans: Record<string, string> = {};
    for (const [name, text] of Object.entries(variants)) {
      const p = mk(['billing']);
      writeFileSync(p.path('docs', 'billing.md'), text);
      const h = await openEngine(p);
      await h.compile();
      await h.close();
      plans[name] = Object.values(planFiles(p)).join('');
    }
    for (const [name, text] of Object.entries(plans)) expect(text, name).toBe(plans['lf']);
    expect(plans['lf']?.length).toBeGreaterThan(1000);
  });

  it('A12 R-PL4: permuting the key order of the model output and the extraction concurrency changes nothing in the plan bytes', async () => {
    const shuffleKeys = (v: JsonValue, seed: number): JsonValue => {
      if (Array.isArray(v)) return v.map((x) => shuffleKeys(x, seed + 1));
      if (v !== null && typeof v === 'object') {
        const keys = Object.keys(v);
        const rotated = [...keys.slice(seed % Math.max(keys.length, 1)), ...keys.slice(0, seed % Math.max(keys.length, 1))].reverse();
        return Object.fromEntries(rotated.map((k) => [k, shuffleKeys((v as Record<string, JsonValue>)[k] as JsonValue, seed + 3)]));
      }
      return v;
    };
    const results: string[] = [];
    for (const [seed, concurrency] of [[0, 1], [3, 2], [5, 8]] as const) {
      const p = mk(['billing', 'todos', 'checkout']);
      const h = await openEngine(p, {
        overrides: { extract: { concurrency } },
        models: (fake): ModelSet => ({
          ...fake,
          extract: {
            id: fake.extract.id,
            async generate(req) {
              const res = await fake.extract.generate(req);
              return res.object === undefined ? res : { ...res, object: shuffleKeys(res.object, seed) };
            },
          },
        }),
      });
      await h.compile();
      await h.close();
      results.push(JSON.stringify(planFiles(p)));
    }
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });

  it('A12 R-PL4: plan files contain no absolute path of the machine, no timestamp, no run id and no uuid', async () => {
    const p = mk();
    const h = await openEngine(p);
    await h.compile();
    await h.close();
    const text = Object.values(planFiles(p)).join('\n');
    expect(text).not.toContain(p.dir);
    expect(text).not.toContain(process.cwd());
    expect(text).not.toMatch(/\b20\d\d-\d\d-\d\dT\d\d:\d\d/);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(text).not.toContain('\r');
    for (const body of Object.values(planFiles(p))) {
      expect(body.endsWith('\n')).toBe(true);
      expect(body.endsWith('\n\n')).toBe(false);
    }
  });

  it('A12 R-PL4: the same logical document stored under an NFC and an NFD file name gets the same docUri (macOS file systems report NFD)', async () => {
    const nfc = 'caf\u00e9-notes';
    const nfd = 'cafe\u0301-notes';
    expect(nfc).not.toBe(nfd);
    const names: string[] = [];
    for (const name of [nfc, nfd]) {
      const p = mk([]);
      p.writeDoc(name, '# Notes\n\n## Reading\n\nCustomers open the release notes from the primary navigation. The page shows the heading Release notes.\n');
      const models = modelSet({ extract: () => ({ object: extraction([]) }) });
      const h = await makeEngine(p, { models });
      await h.engine.compile();
      await h.close();
      names.push(Object.keys(planFiles(p)).join(','));
    }
    expect(names[1]).toBe(names[0]);
  });

  it('A12 R-PL4: documents in nested directories keep posix docUris, ids and plan paths (no backslashes, no absolute prefix)', async () => {
    const p = mk([]);
    mkdirSync(p.path('docs', 'sub dir', 'deep'), { recursive: true });
    writeFileSync(p.path('docs', 'sub dir', 'deep', 'My Doc.md'), '# Notes\n\n## Reading\n\nCustomers open the release notes from the primary navigation. The page shows the heading Release notes.\n');
    const models = modelSet({
      extract: (req) => {
        const q = quoteFrom(req, 'Customers open');
        return q === null ? { object: extraction([]) } : { object: extraction([{ title: 'Notes', sources: [q], scenarios: [{ title: 'Open', sources: [q], steps: [{ kind: 'when', text: 'the customer opens the notes' }, { kind: 'then', text: 'the heading is shown' }] }] }]) };
      },
    });
    const h = await makeEngine(p, { models });
    await h.engine.compile();
    await h.close();
    const files = Object.keys(planFiles(p));
    expect(files).toEqual(['docs/sub dir/deep/My Doc.md.plan.json']);
    const plan = JSON.parse(Object.values(planFiles(p))[0] as string) as { docUri: string; features: { id: string; scenarios: { id: string }[] }[] };
    expect(plan.docUri).toBe('docs/sub dir/deep/My Doc.md');
    expect(JSON.stringify(plan)).not.toContain('\\\\');
    expect(plan.features[0]?.id).toBe('docs-sub-dir-deep-my-doc--notes');
    expect(toPosix('a\\b\\c')).toBe('a/b/c');
  });
});

describe('A12 R-PL4 recordings are deterministic', () => {
  it('A12 R-PL4 R-CH2: characterizing the same scenario in two fresh projects (different paths, different worker counts) writes byte-identical recordings without paths, times or ids', async () => {
    const bodies: string[] = [];
    for (const workers of [1, 8]) {
      const p = mk(['billing']);
      const h = await openEngine(p);
      await h.compile();
      const report = await h.run({ titles: ['Upgrade from Free to Pro', 'Upgrade button is visible on the Free plan'], workers });
      await h.close();
      expect(report.scenarios.map((s) => s.status)).toEqual(['passed', 'passed']);
      const recs = readRecordings(p);
      expect(recs.length).toBe(2);
      for (const r of recs) {
        const text = readFileSync(r.path, 'utf8');
        expect(text).not.toContain(p.dir);
        expect(text).not.toMatch(/\b20\d\d-\d\d-\d\dT/);
        expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
        expect(text).not.toContain('\r');
        expect(text.endsWith('\n')).toBe(true);
      }
      bodies.push(recs.map((r) => r.path.slice(p.recordingsDir.length) + readFileSync(r.path, 'utf8')).join('\n'));
    }
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('A12 R-PL4: re-characterizing an unchanged scenario with -u reports `unchanged` and does not rewrite the file', async () => {
    const p = mk(['billing']);
    const h = await openEngine(p);
    await h.compile();
    const first = await h.runScenario('Upgrade from Free to Pro');
    const file = readRecordings(p)[0]?.path ?? '';
    const before = readFileSync(file);
    const second = await h.runScenario('Upgrade from Free to Pro', { updateRecordings: true });
    await h.close();
    expect(first.recording).toBe('created');
    expect(second.recording).toBe('unchanged');
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('A12 R-PL4: recording and plan directories can be moved wholesale to another location without any content change', async () => {
    const a = mk(['billing']);
    const h = await openEngine(a);
    await h.compile();
    await h.runScenario('Upgrade from Free to Pro');
    await h.close();
    const b = mk([]);
    rmDirIfAny(b.aiBddDir);
    cpSync(a.aiBddDir, b.aiBddDir, { recursive: true });
    cpSync(a.path('docs', 'billing.md'), b.path('docs', 'billing.md'));
    const h2 = await openEngine(b);
    const status = await h2.engine.status();
    const r = await h2.runScenario('Upgrade from Free to Pro');
    await h2.close();
    expect(status.docs.map((d) => d.state)).toEqual(['fresh']);
    expect(r.mode).toBe('replay');
    expect(r.status).toBe('passed');
    void renameSync;
    void existsSync;
    void walkFiles;
  });
});

function rmDirIfAny(dir: string): void {
  try {
    cpSync(dir, `${dir}.bak`, { recursive: true });
  } catch {
    // nothing to back up
  }
}

describe('A12 R-PL4 stableJson properties', () => {
  const json = fc.jsonValue() as fc.Arbitrary<JsonValue>;

  it('A12 R-PL4: stableJson is key-order independent, idempotent through parse, LF-only and newline terminated', () => {
    fc.assert(
      fc.property(json, (v) => {
        const text = stableJson(v);
        expect(text.endsWith('\n')).toBe(true);
        expect(text.includes('\r')).toBe(false);
        expect(stableJson(JSON.parse(text) as JsonValue)).toBe(text);
        const reversed = (x: JsonValue): JsonValue =>
          Array.isArray(x) ? x.map(reversed) : x !== null && typeof x === 'object' ? Object.fromEntries(Object.keys(x).reverse().map((k) => [k, reversed((x as Record<string, JsonValue>)[k] as JsonValue)])) : x;
        expect(stableJson(reversed(v))).toBe(text);
      }),
      { numRuns: Number(process.env['FC_RUNS'] ?? 200) },
    );
  });

  it('A12 R-PL4: canonicalJson and stableJson agree on content (same parse result) and canonicalJson has no whitespace', () => {
    const hasProtoKey = (x: JsonValue): boolean =>
      Array.isArray(x) ? x.some(hasProtoKey) : x !== null && typeof x === 'object' ? Object.keys(x).some((k) => k === '__proto__') || Object.values(x).some((y) => hasProtoKey(y as JsonValue)) : false;
    fc.assert(
      fc.property(json.filter((v) => !hasProtoKey(v)), (v) => {
        const c = canonicalJson(v);
        expect(JSON.parse(c)).toEqual(JSON.parse(stableJson(v)));
        expect(/\n|\r/.test(c)).toBe(false);
      }),
      { numRuns: Number(process.env['FC_RUNS'] ?? 200) },
    );
  });

  it('A12 R-PL4: an own `__proto__` key (as produced by JSON.parse) is written like any other key, not silently dropped', () => {
    const v = JSON.parse('{"b":1,"10":2,"9":3,"a":4,"__proto__":5,"":6}') as JsonValue;
    const text = stableJson(v);
    expect(stableJson(JSON.parse(text) as JsonValue)).toBe(text);
    expect(text).toContain('"__proto__": 5');
  });
});
