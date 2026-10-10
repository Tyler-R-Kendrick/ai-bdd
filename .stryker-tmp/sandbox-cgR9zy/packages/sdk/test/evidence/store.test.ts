// @ts-nocheck
import fc from 'fast-check';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/contracts/index.ts';
import { createEvidenceStore, createRedactor } from '../../src/evidence/index.ts';
import { canonicalJson, sha256Hex } from '../../src/util/index.ts';
import { FC_RUNS, dumpTree, tempDir } from './helpers.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
async function setup() {
  const t = await tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

const SECRET = 'hunter2-Pa55/w0rd';
const redactor = createRedactor({ adminPassword: SECRET });

describe('evidence store (R-EV1, R-SE1)', () => {
  it('R-EV1 puts content-addressed artifacts under ${runsDir}/${runId}/artifacts/<sha256>.<ext>', async () => {
    const runsDir = await setup();
    const store = await createEvidenceStore({ runsDir, runId: 'run-1', redactor });
    expect(store.runId).toBe('run-1');
    expect(store.dir).toBe(join(runsDir, 'run-1'));

    const json = await store.putArtifact('observation', JSON.stringify({ a: 1 }));
    const txt = await store.putArtifact('act-transcript', 'plain text, not json');
    const png = await store.putArtifact('screenshot', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]));

    expect(json).toMatchObject({ kind: 'observation', sha256: sha256Hex('{"a":1}'), path: `artifacts/${sha256Hex('{"a":1}')}.json`, bytes: 7 });
    expect(txt.path).toBe(`artifacts/${sha256Hex('plain text, not json')}.txt`);
    expect(png.path.endsWith('.png')).toBe(true);
    expect(png.bytes).toBe(6);
    expect([...(await readFile(join(store.dir, png.path)))]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 255]);
    expect(await readFile(join(store.dir, txt.path), 'utf8')).toBe('plain text, not json');
    // no temp files left behind
    expect((await readdir(join(store.dir, 'artifacts'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('R-SE1 R-EV1 text is redacted BEFORE hashing: the hash and bytes are those of the redacted text', async () => {
    const runsDir = await setup();
    const store = await createEvidenceStore({ runsDir, runId: 'run-2', redactor });
    const ref = await store.putArtifact('judge-request', `password=${SECRET}&q=${encodeURIComponent(SECRET)}`);
    const redacted = 'password=<secret:adminPassword>&q=<secret:adminPassword>';
    expect(ref.sha256).toBe(sha256Hex(redacted));
    expect(ref.bytes).toBe(Buffer.byteLength(redacted));
    expect(await readFile(join(store.dir, ref.path), 'utf8')).toBe(redacted);
    // identical content with and without the secret collapses to the same artifact
    const again = await store.putArtifact('judge-request', redacted);
    expect(again.sha256).toBe(ref.sha256);
  });

  it('R-SE1 text passed as bytes (non-screenshot kinds) is redacted too', async () => {
    const runsDir = await setup();
    const store = await createEvidenceStore({ runsDir, runId: 'run-3', redactor });
    const ref = await store.putArtifact('checkgen', Buffer.from(JSON.stringify({ v: SECRET })));
    expect(await readFile(join(store.dir, ref.path), 'utf8')).toBe('{"v":"<secret:adminPassword>"}');
    expect(ref.path.endsWith('.json')).toBe(true);
  });

  it('R-SE1 the secret never appears in any file under the run dir (artifacts, events.jsonl, manifest)', async () => {
    const runsDir = await setup();
    const store = await createEvidenceStore({ runsDir, runId: 'run-4', redactor });
    const b64 = Buffer.from(SECRET).toString('base64');
    await store.putArtifact('observation', JSON.stringify({ field: SECRET, url: `/login?pw=${encodeURIComponent(SECRET)}` }));
    await store.putArtifact('act-transcript', `typed ${SECRET}; header ${b64}`);
    await store.record({ type: 'log', message: `filled ${SECRET}`, nested: [{ enc: b64 }] });
    await store.finalize();
    const dump = await dumpTree(store.dir);
    for (const needle of [SECRET, encodeURIComponent(SECRET), b64]) expect(dump).not.toContain(needle);
    expect(dump).toContain('<secret:adminPassword>');
  });

  it('R-SE1 property: random secrets in text/JSON artifacts and events never reach disk', async () => {
    const alphabet = [...'abcXYZ019 &=/+?#%"\\é'];
    const secretArb = fc.string({ minLength: 4, maxLength: 20, unit: fc.constantFrom(...alphabet) });
    let n = 0;
    await fc.assert(
      fc.asyncProperty(secretArb, fc.string({ maxLength: 10 }), async (secret, noise) => {
        const red = createRedactor({ s: secret });
        const runsDir = await setup();
        const store = await createEvidenceStore({ runsDir, runId: `r${(n += 1)}`, redactor: red });
        const forms = [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')];
        for (const f of forms) {
          await store.putArtifact('observation', `${noise}${f}${noise}`);
          await store.putArtifact('observation', JSON.stringify({ k: `${noise}${f}`, [f]: 1 }));
          await store.record({ f: `${noise}${f}` });
        }
        await store.finalize();
        const files = await readdir(store.dir, { recursive: true });
        let dump = '';
        for (const f of files) {
          try {
            dump += (await readFile(join(store.dir, f))).toString('utf8');
          } catch {
            /* directory */
          }
        }
        for (const f of forms) {
          expect(dump).not.toContain(f);
          expect(dump).not.toContain(JSON.stringify(f).slice(1, -1));
        }
      }),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  });

  it('R-SE1 record() appends one redacted JSON line per call, in call order, even when concurrent', async () => {
    const runsDir = await setup();
    const store = await createEvidenceStore({ runsDir, runId: 'run-5', redactor });
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.record({ i, secret: SECRET })));
    const lines = (await readFile(join(store.dir, 'events.jsonl'), 'utf8')).split('\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(20);
    const parsed = lines.map((l) => JSON.parse(l) as { i: number; secret: string });
    expect(parsed.map((p) => p.i)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(parsed.every((p) => p.secret === '<secret:adminPassword>')).toBe(true);
  });

  it('R-EV1 finalize writes manifest.json {runId, artifacts sorted by path, digest} and returns it', async () => {
    const runsDir = await setup();
    const store = await createEvidenceStore({ runsDir, runId: 'run-6', redactor });
    for (const t of ['zulu', 'alpha', 'mike', 'bravo']) await store.putArtifact('report', t);
    await store.putArtifact('report', 'alpha'); // duplicate: one entry
    const fin = await store.finalize();
    expect(fin.runId).toBe('run-6');
    expect(fin.artifacts).toHaveLength(4);
    const paths = fin.artifacts.map((a) => a.path);
    expect(paths).toEqual([...paths].sort());
    expect(fin.digest).toBe(sha256Hex(canonicalJson(fin.artifacts as unknown as JsonValue)));
    const onDisk = JSON.parse(await readFile(join(store.dir, 'manifest.json'), 'utf8')) as typeof fin;
    expect(onDisk).toEqual(fin);
    expect((await readFile(join(store.dir, 'manifest.json'), 'utf8')).endsWith('\n')).toBe(true);
  });

  it('R-EV1 an empty run finalizes with an empty artifact list', async () => {
    const runsDir = await setup();
    const store = await createEvidenceStore({ runsDir, runId: 'empty', redactor });
    const fin = await store.finalize();
    expect(fin.artifacts).toEqual([]);
    expect(fin.digest).toBe(sha256Hex('[]'));
  });

  it('R-EV1 same bytes stored under two kinds yield two manifest entries for one file', async () => {
    const runsDir = await setup();
    const store = await createEvidenceStore({ runsDir, runId: 'kinds', redactor });
    const a = await store.putArtifact('judge-request', 'same');
    const b = await store.putArtifact('checkgen', 'same');
    expect(a.path).toBe(b.path);
    const fin = await store.finalize();
    expect(fin.artifacts.map((x) => x.kind)).toEqual(['checkgen', 'judge-request']);
  });

  it('R-EV1 run ids that could escape the runs directory are rejected', async () => {
    const runsDir = await setup();
    for (const runId of ['', '.', '..', '../x', 'a/b', 'a\\b']) {
      await expect(createEvidenceStore({ runsDir, runId, redactor })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    }
  });
});
