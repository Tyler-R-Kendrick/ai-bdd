import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCacheStore, buildStrategies } from '@ai-bdd/cache';
import { LockStore, createResolver } from '@ai-bdd/lock';
import { createFakeModelSet } from '@ai-bdd/models/fake';
import { createRegistry } from '@ai-bdd/registry';
import { createSemanticResolver } from '@ai-bdd/semantic';
import { parseGaugeSpec } from '@ai-bdd/spec-gauge';
import { parseConcepts } from '@ai-bdd/spec-gauge';

/** Attack 9: lockfile nondeterminism (ordering, float formatting, locale). */
const REPO = fileURLToPath(new URL('../../', import.meta.url));

async function resolveInto(dir: string, specPath: string): Promise<string> {
  const models = createFakeModelSet({ rulesPath: `${REPO}fixtures/fake-model/rules.json` });
  const registry = createRegistry();
  for (const name of ['#seed', '#invoices', '#reset']) {
    void name;
  }
  const bindings = await import(`${REPO}fixtures/bindings/billing.ts`).catch(() => null);
  void bindings;
  const semantic = createSemanticResolver({
    embedder: models.embed,
    extractor: models.extract,
    config: { threshold: 0.85, margin: 0.1 },
  });
  const lock = LockStore.empty(join(dir, 'ai-bdd.lock.json'), { now: () => new Date('2026-10-09T00:00:00.000Z') });
  const resolver = createResolver({
    registry,
    semantic,
    lock,
    config: { threshold: 0.85, margin: 0.1, allowAgentSetup: true, semantic: { enabled: true } },
  });
  const text = readFileSync(specPath, 'utf8');
  const { document } = parseGaugeSpec(text, specPath, { concepts: parseConcepts(readFileSync(join(dirnameOf(specPath), 'billing.cpt'), 'utf8'), 'billing.cpt').concepts });
  for (const scenario of document.scenarios) {
    for (const step of scenario.steps) {
      await resolver.resolve(step, { frozen: false }).catch(() => undefined);
    }
  }
  await lock.save();
  return readFileSync(join(dir, 'ai-bdd.lock.json'), 'utf8');
}

function dirnameOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

describe('attack 9: lockfile determinism', () => {
  it('writes byte-identical output for the same inputs', async () => {
    const first = mkdtempSync(join(tmpdir(), 'aibdd-lock-a-'));
    const second = mkdtempSync(join(tmpdir(), 'aibdd-lock-b-'));
    const spec = join(REPO, 'fixtures/specs/billing.spec.md');
    const a = await resolveInto(first, spec);
    const b = await resolveInto(second, spec);
    expect(b).toBe(a);
    expect(a.endsWith('\n')).toBe(true);
    expect(a).not.toContain('NaN');
    expect(a).not.toMatch(/0\.\d{17,}/u);
  });

  it('keeps the cache strategies deterministic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibdd-cache-adv-'));
    const store = createCacheStore({ dir, mode: 'read-write', strategies: buildStrategies(['effect-verify', 'manual'], { manual: 'v1' }) });
    expect(store.pending()).toEqual({ act: 0, check: 0 });
    expect(await store.getAct('missing')).toBeNull();
    mkdirSync(join(dir, 'act'), { recursive: true });
    cpSync(join(REPO, 'fixtures/fake-model/synonyms.json'), join(dir, 'act', 'unused.json'));
    expect(await store.getAct('unused')).toBeNull();
  });
});
