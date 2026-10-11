import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
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

  describe('manifest shape (EVIDENCE_CORRUPT)', () => {
    async function verifyWithManifest(manifestText: string): Promise<{ ok: boolean; problems: string[] }> {
      const { dir } = await makeRun();
      await writeFile(join(dir, 'manifest.json'), manifestText);
      return verifyRun(dir);
    }

    it('R-EV1 a manifest that is not valid JSON says so and quotes the parser message', async () => {
      const r = await verifyWithManifest('{not json');
      expect(r.ok).toBe(false);
      expect(r.problems).toHaveLength(1);
      expect(r.problems[0]).toMatch(/^EVIDENCE_CORRUPT: manifest\.json is not valid JSON \(.+\)$/);
    });

    it.each([['an array', '[]'], ['null', 'null'], ['a string', '"text"'], ['a number', '42']])('R-EV1 a manifest that is %s is not an object', async (_n, text) => {
      expect(await verifyWithManifest(text)).toEqual({ ok: false, problems: ['EVIDENCE_CORRUPT: manifest.json is not an object'] });
    });

    it.each([
      ['runId', { digest: 'd', artifacts: [] }, 'manifest.json has no runId'],
      ['a non-string runId', { runId: 5, digest: 'd', artifacts: [] }, 'manifest.json has no runId'],
      ['digest', { runId: 'r', artifacts: [] }, 'manifest.json has no digest'],
      ['a non-string digest', { runId: 'r', digest: 5, artifacts: [] }, 'manifest.json has no digest'],
      ['artifacts', { runId: 'r', digest: 'd' }, 'manifest.json has no artifacts array'],
      ['an artifacts array', { runId: 'r', digest: 'd', artifacts: {} }, 'manifest.json has no artifacts array'],
    ])('R-EV1 a manifest without %s is reported precisely', async (_n, manifest, message) => {
      expect(await verifyWithManifest(JSON.stringify(manifest))).toEqual({ ok: false, problems: [`EVIDENCE_CORRUPT: ${message}`] });
    });

    const good = { sha256: 'a'.repeat(64), path: `artifacts/${'a'.repeat(64)}.txt`, kind: 'report', bytes: 1 };
    it.each([
      ['null', null],
      ['a string', 'x'],
      ['a number', 7],
      ['without sha256', { ...good, sha256: undefined }],
      ['with a numeric sha256', { ...good, sha256: 1 }],
      ['without path', { ...good, path: undefined }],
      ['without kind', { ...good, kind: undefined }],
      ['with a string bytes', { ...good, bytes: '1' }],
    ])('R-EV1 an artifact entry that is %s is malformed', async (_n, entry) => {
      const r = await verifyWithManifest(JSON.stringify({ runId: 'r', digest: 'd', artifacts: [good, entry] }));
      expect(r).toEqual({ ok: false, problems: ['EVIDENCE_CORRUPT: manifest.json has a malformed artifact entry'] });
    });
  });

  describe('artifact entries', () => {
    it.each([
      ['a backslash', 'artifacts\\x.txt'],
      ['a ".." segment', 'artifacts/sub/../x.txt'],
      ['an absolute path', '/etc/passwd'],
      ['the artifacts directory itself', 'artifacts'],
      ['a file outside the artifacts directory', 'manifest.json'],
      ['a sibling directory', 'artifacts-extra/x.txt'],
    ])('R-EV1 a manifest path with %s is unsafe and never read', async (_n, path) => {
      const { dir } = await makeRun();
      await rewriteManifest(
        dir,
        (m) => {
          m.artifacts.push({ sha256: sha256Hex('x'), path, kind: 'report', bytes: 1 });
        },
        true,
      );
      const r = await verifyRun(dir);
      expect(r.ok).toBe(false);
      expect(r.problems).toEqual([`unsafe path in manifest: ${JSON.stringify(path)}`]);
    });

    it('R-EV1 an entry whose path does not embed its sha256 is inconsistent even when the file content matches', async () => {
      const { dir, a } = await makeRun();
      await rename(join(dir, a.path), join(dir, 'artifacts', 'renamed.txt'));
      await rewriteManifest(
        dir,
        (m) => {
          (m.artifacts.find((x) => x['path'] === a.path) as { path: string }).path = 'artifacts/renamed.txt';
        },
        true,
      );
      const r = await verifyRun(dir);
      expect(r).toEqual({ ok: false, problems: [`manifest entry inconsistent: artifacts/renamed.txt does not match sha256 ${a.sha256}`] });
    });

    it('R-EV1 an entry whose sha256 is not 64 lowercase hex digits is inconsistent and also reported as modified', async () => {
      const { dir, a } = await makeRun();
      await rewriteManifest(
        dir,
        (m) => {
          (m.artifacts.find((x) => x['path'] === a.path) as { sha256: string }).sha256 = a.sha256.toUpperCase();
        },
        true,
      );
      const r = await verifyRun(dir);
      expect(r.ok).toBe(false);
      expect(r.problems).toHaveLength(2);
      expect(r.problems[0]).toBe(`manifest entry inconsistent: ${a.path} does not match sha256 ${a.sha256.toUpperCase()}`);
      expect(r.problems[1]).toContain(`modified: ${a.path} (expected ${a.sha256.toUpperCase()}, found ${a.sha256})`);
    });

    it('R-EV1 an artifact path that is a directory is reported as not a regular file', async () => {
      const { dir, a } = await makeRun();
      await rm(join(dir, a.path));
      await mkdir(join(dir, a.path));
      const r = await verifyRun(dir);
      expect(r).toEqual({ ok: false, problems: [`not a regular file: ${a.path}`] });
    });

    it('R-EV1 an artifact replaced by a symlink is not followed, even when the target has identical content', async () => {
      const { dir, b } = await makeRun();
      const target = join(dir, 'elsewhere.txt');
      await writeFile(target, 'two');
      await rm(join(dir, b.path));
      await symlink(target, join(dir, b.path));
      const r = await verifyRun(dir);
      expect(r.ok).toBe(false);
      expect(r.problems).toEqual([`not a regular file: ${b.path}`]);
    });

    it('R-EV1 files nested in subdirectories of artifacts/ that the manifest does not list are extra', async () => {
      const { dir } = await makeRun();
      await mkdir(join(dir, 'artifacts', 'sub', 'deeper'), { recursive: true });
      await writeFile(join(dir, 'artifacts', 'sub', 'deeper', 'z.txt'), 'z');
      await writeFile(join(dir, 'artifacts', 'sub', 'a.txt'), 'a');
      const r = await verifyRun(dir);
      expect(r.ok).toBe(false);
      expect(r.problems).toEqual(['extra: artifacts/sub/a.txt', 'extra: artifacts/sub/deeper/z.txt']);
    });

    it('R-EV1 a run whose artifacts directory is gone reports every artifact as missing instead of throwing', async () => {
      const { dir, a, b, c } = await makeRun();
      await rm(join(dir, 'artifacts'), { recursive: true });
      const r = await verifyRun(dir);
      expect(r.ok).toBe(false);
      expect([...r.problems].sort()).toEqual([`missing: ${a.path}`, `missing: ${b.path}`, `missing: ${c.path}`].sort());
    });

    it('R-EV1 a run with no artifacts and an empty manifest list verifies clean', async () => {
      const t = await tempDir();
      cleanups.push(t.cleanup);
      const store = await createEvidenceStore({ runsDir: t.dir, runId: 'run-empty', redactor: createRedactor({}) });
      await store.finalize();
      expect(await verifyRun(store.dir)).toEqual({ ok: true, problems: [] });
    });
  });
});
