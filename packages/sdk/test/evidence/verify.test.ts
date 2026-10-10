import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/contracts/index.ts';
import { createEvidenceStore, createRedactor, verifyRun } from '../../src/evidence/index.ts';
import { canonicalJson, sha256Hex, stableJson } from '../../src/util/index.ts';
import { tempDir } from './helpers.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function makeRun() {
  const t = await tempDir();
  cleanups.push(t.cleanup);
  const store = await createEvidenceStore({ runsDir: t.dir, runId: 'run-v', redactor: createRedactor({}) });
  const a = await store.putArtifact('observation', JSON.stringify({ tree: 'one' }));
  const b = await store.putArtifact('act-transcript', 'two');
  const c = await store.putArtifact('screenshot', new Uint8Array([1, 2, 3, 4]));
  await store.record({ type: 'log' });
  const manifest = await store.finalize();
  return { dir: store.dir, a, b, c, manifest };
}

async function rewriteManifest(dir: string, edit: (m: { runId: string; artifacts: Record<string, unknown>[]; digest: string }) => void, redigest = false) {
  const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { runId: string; artifacts: Record<string, unknown>[]; digest: string };
  edit(m);
  if (redigest) m.digest = sha256Hex(canonicalJson(m.artifacts as unknown as JsonValue));
  await writeFile(join(dir, 'manifest.json'), stableJson(m as unknown as JsonValue));
}

describe('verifyRun (R-EV1)', () => {
  it('R-EV1 an untouched run verifies clean (exit 0 semantics)', async () => {
    const { dir } = await makeRun();
    expect(await verifyRun(dir)).toEqual({ ok: true, problems: [] });
  });

  it('R-EV1 detects a modified artifact (one flipped byte)', async () => {
    const { dir, b } = await makeRun();
    const p = join(dir, b.path);
    const bytes = await readFile(p);
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    await writeFile(p, bytes);
    const r = await verifyRun(dir);
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain(`modified: ${b.path}`);
  });

  it('R-EV1 detects a modification that keeps the byte length (binary artifact)', async () => {
    const { dir, c } = await makeRun();
    await writeFile(join(dir, c.path), new Uint8Array([1, 2, 3, 5]));
    const r = await verifyRun(dir);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain(`modified: ${c.path}`);
  });

  it('R-EV1 detects a missing artifact', async () => {
    const { dir, a } = await makeRun();
    await rm(join(dir, a.path));
    const r = await verifyRun(dir);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([`missing: ${a.path}`]);
  });

  it('R-EV1 detects an extra (unlisted) artifact file, including in subdirectories', async () => {
    const { dir } = await makeRun();
    await writeFile(join(dir, 'artifacts', 'smuggled.txt'), 'x');
    const r = await verifyRun(dir);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['extra: artifacts/smuggled.txt']);
  });

  it('R-EV1 detects a digest edit', async () => {
    const { dir } = await makeRun();
    await rewriteManifest(dir, (m) => {
      m.digest = '0'.repeat(64);
    });
    const r = await verifyRun(dir);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain('digest mismatch');
  });

  it('R-EV1 detects an edited manifest entry (bytes/kind changed without recomputing the digest)', async () => {
    const { dir } = await makeRun();
    await rewriteManifest(dir, (m) => {
      (m.artifacts[0] as { bytes: number }).bytes += 1;
    });
    const r = await verifyRun(dir);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain('digest mismatch');
  });

  it('R-EV1 detects a manifest edited consistently (digest recomputed) when the entry no longer matches the file', async () => {
    const { dir, a } = await makeRun();
    await rewriteManifest(
      dir,
      (m) => {
        const e = m.artifacts.find((x) => x['path'] === a.path) as { bytes: number };
        e.bytes += 5;
      },
      true,
    );
    const r = await verifyRun(dir);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain(`modified: ${a.path}`);
  });

  it('R-EV1 reports multiple problems together', async () => {
    const { dir, a, b } = await makeRun();
    await rm(join(dir, a.path));
    await writeFile(join(dir, b.path), 'tampered');
    await writeFile(join(dir, 'artifacts', 'extra.json'), '{}');
    const r = await verifyRun(dir);
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(3);
  });

  it('R-EV1 manifest paths cannot escape the run directory (traversal)', async () => {
    const { dir } = await makeRun();
    await writeFile(join(dir, '..', 'outside.txt'), 'outside');
    cleanups.push(() => rm(join(dir, '..', 'outside.txt'), { force: true }));
    await rewriteManifest(
      dir,
      (m) => {
        m.artifacts.push({ sha256: sha256Hex('outside'), path: 'artifacts/../../outside.txt', kind: 'report', bytes: 7 });
      },
      true,
    );
    const r = await verifyRun(dir);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain('unsafe path');
  });

  it('R-EV1 EVIDENCE_CORRUPT: missing, non-JSON and malformed manifests give ok:false', async () => {
    const { dir } = await makeRun();
    await writeFile(join(dir, 'manifest.json'), '{not json');
    let r = await verifyRun(dir);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/^EVIDENCE_CORRUPT:/);

    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ runId: 'x', digest: 'y' }));
    r = await verifyRun(dir);
    expect(r.problems[0]).toMatch(/^EVIDENCE_CORRUPT:/);

    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ runId: 'x', digest: 'y', artifacts: [{ path: 3 }] }));
    r = await verifyRun(dir);
    expect(r.problems[0]).toMatch(/^EVIDENCE_CORRUPT:/);

    await rm(join(dir, 'manifest.json'));
    r = await verifyRun(dir);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/^EVIDENCE_CORRUPT: cannot read manifest.json/);
  });

  it('R-EV1 EVIDENCE_CORRUPT: a nonexistent run dir does not throw', async () => {
    const { dir } = await makeRun();
    const r = await verifyRun(join(dir, 'does-not-exist'));
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/^EVIDENCE_CORRUPT:/);
  });
});
