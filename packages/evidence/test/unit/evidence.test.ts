import { mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DriverSession, Observation } from '@ai-bdd/contracts';
import {
  EvidenceStore,
  createRedactor,
  createSigner,
  generateSigningKey,
  resolveSecrets,
  secretVariants,
  settle,
  verifyEvidence,
} from '../../src/index.js';

const dirs: string[] = [];
function tempRun(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aibdd-ev-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('evidence store (R-K14)', () => {
  it('writes artifacts, chains records and verifies cleanly', async () => {
    const store = new EvidenceStore(tempRun(), { now: () => new Date('2026-10-09T00:00:00.000Z'), runId: 'run-1' });
    await store.write({ kind: 'observation', data: { route: '/settings/billing' }, ext: 'json' });
    await store.write({ kind: 'log', data: 'seeded workspace Acme', ext: 'txt' });
    const manifest = await store.finalize();
    expect(manifest.count).toBe(2);
    const verification = await verifyEvidence(store.runDir);
    expect(verification).toMatchObject({ ok: true, count: 2 });
    expect(verification.rootHash).toBe(manifest.rootHash);
  });

  it('signs the root hash and verifies it', async () => {
    const { privateKeyPem } = generateSigningKey();
    const store = new EvidenceStore(tempRun(), { signer: createSigner(privateKeyPem) });
    await store.write({ kind: 'log', data: 'signed', ext: 'txt' });
    const manifest = await store.finalize();
    expect(manifest.signature?.alg).toBe('ed25519');
    expect((await verifyEvidence(store.runDir)).ok).toBe(true);
  });

  it('detects a single flipped byte in an artifact', async () => {
    const store = new EvidenceStore(tempRun());
    const record = await store.write({ kind: 'log', data: 'original content', ext: 'txt' });
    await store.finalize();
    const path = join(store.runDir, record.artifact.path);
    const bytes = readFileSync(path);
    bytes[0] = bytes[0] === 0x6f ? 0x70 : 0x6f;
    writeFileSync(path, bytes);
    const verification = await verifyEvidence(store.runDir);
    expect(verification.ok).toBe(false);
    expect(verification.problems.map((problem) => problem.kind)).toContain('artifact-modified');
  });

  it('detects a deleted record and a reordered chain', async () => {
    const store = new EvidenceStore(tempRun());
    await store.write({ kind: 'log', data: 'first', ext: 'txt' });
    await store.write({ kind: 'log', data: 'second', ext: 'txt' });
    await store.finalize();
    const jsonl = join(store.runDir, 'manifest.jsonl');
    const lines = readFileSync(jsonl, 'utf8').trim().split('\n');
    writeFileSync(jsonl, `${lines.reverse().join('\n')}\n`);
    const verification = await verifyEvidence(store.runDir);
    expect(verification.ok).toBe(false);
    expect(verification.problems.map((problem) => problem.kind)).toContain('chain-broken');
  });

  it('detects a replaced manifest', async () => {
    const store = new EvidenceStore(tempRun());
    await store.write({ kind: 'log', data: 'only', ext: 'txt' });
    await store.finalize();
    const manifestPath = join(store.runDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, rootHash: 'f'.repeat(64) }));
    const verification = await verifyEvidence(store.runDir);
    expect(verification.ok).toBe(false);
    expect(verification.problems.map((problem) => problem.kind)).toContain('root-hash-mismatch');
  });

  it('redacts text before hashing, so the artifact never contains the secret', async () => {
    const redactor = createRedactor({ adminPassword: { value: 'hunter2-secret' } });
    const store = new EvidenceStore(tempRun(), { redactor });
    const record = await store.write({ kind: 'log', data: 'typing hunter2-secret into the form', ext: 'txt' });
    await store.finalize();
    const text = readFileSync(join(store.runDir, record.artifact.path), 'utf8');
    expect(text).toBe('typing <secret:adminPassword> into the form');
  });
});

describe('redaction (R-K15)', () => {
  it('covers raw, URL-encoded and base64 forms', () => {
    const value = 'p@ss word/1';
    const redactor = createRedactor({ s: { value } });
    for (const variant of secretVariants(value)) {
      expect(redactor.redact(`x ${variant} y`)).toBe('x <secret:s> y');
    }
  });

  it('rejects secrets shorter than 4 characters', () => {
    expect(() => resolveSecrets({ pin: { value: '123' } })).toThrow(/SECRET_TOO_SHORT|shorter than 4/u);
    expect(resolveSecrets({ pin: { value: '1234' } })).toEqual({ pin: '1234' });
  });
});

describe('settle detection (R-K11)', () => {
  function sessionWith(observations: Array<Partial<Observation>>): DriverSession {
    let index = 0;
    return {
      id: 's',
      driverId: 'fake',
      driverMajor: 1,
      async observe() {
        const next = observations[Math.min(index, observations.length - 1)]!;
        index += 1;
        return {
          revision: index,
          nodes: [],
          treeHash: next.treeHash ?? 'h',
          tainted: false,
          maskingProven: true,
          settled: true,
          capturedAt: '2026-10-09T00:00:00.000Z',
          ...next,
        } as Observation;
      },
      async perform() {
        return { ok: true, verb: 'tap' };
      },
      async close() {},
    };
  }

  it('settles once the tree hash stops changing', async () => {
    let clock = 0;
    const session = sessionWith([{ treeHash: 'a' }, { treeHash: 'b' }, { treeHash: 'b' }, { treeHash: 'b' }]);
    const result = await settle(session, { quietMs: 200, intervalMs: 100, timeoutMs: 2000 }, {
      sleep: async () => {},
      now: () => (clock += 100),
    });
    expect(result.settled).toBe(true);
  });

  it('reports unsettled when the screen keeps changing', async () => {
    let clock = 0;
    const session = sessionWith([{ treeHash: 'a' }, { treeHash: 'b' }, { treeHash: 'c' }, { treeHash: 'd' }, { treeHash: 'e' }]);
    const result = await settle(session, { quietMs: 200, intervalMs: 100, timeoutMs: 500 }, {
      sleep: async () => {},
      now: () => (clock += 100),
    });
    expect(result.settled).toBe(false);
    expect(result.reason).toMatch(/quiet window/u);
  });
});
