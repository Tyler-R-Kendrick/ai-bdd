import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRegistry, type BindingRegistry } from '@ai-bdd/registry';
import { createSemanticResolver } from '@ai-bdd/semantic';
import type { BindingDescriptor } from '@ai-bdd/contracts';
import { LockStore, createResolver, type Resolver, type ResolverConfig } from '../../src/index.js';
import { createExactEmbedder, createExtractorModel, makeStep, tempDir, unit } from '../helpers/index.js';

const NOW = (): Date => new Date('2024-01-01T00:00:00.000Z');

function descriptor(overrides: Partial<BindingDescriptor> & Pick<BindingDescriptor, 'id' | 'pattern'>): BindingDescriptor {
  return { provider: 'ts:local', patternKind: 'cucumber-expression', kind: 'action', ...overrides };
}

interface Harness {
  registry: BindingRegistry;
  resolver: Resolver;
  lock: LockStore;
  lockPath: string;
}

function harness(
  bindings: BindingDescriptor[],
  vectors: Record<string, number[]>,
  config: Partial<ResolverConfig> = {},
  lockPath = join(tempDir('lock-'), 'resolution.lock.json'),
): Harness {
  const registry = createRegistry();
  for (const binding of bindings) registry.add(binding);
  const semantic = createSemanticResolver({
    embedder: createExactEmbedder({ 'alpha beta gamma': [1, 0], ...vectors }),
    extractor: createExtractorModel({}),
    config: { threshold: 0.85, margin: 0.1, embedCacheDir: tempDir('emb-') },
  });
  // Reuse the lockfile on disk when the harness is pointed at an existing path (R-K12).
  const lock = existsSync(lockPath) ? LockStore.load(lockPath, { now: NOW }) : LockStore.empty(lockPath, { now: NOW });
  const resolver = createResolver({
    registry,
    semantic,
    lock,
    config: { threshold: 0.85, margin: 0.1, allowAgentSetup: true, semantic: { enabled: true }, ...config },
  });
  return { registry, resolver, lock, lockPath };
}

const STEP = makeStep({ text: 'alpha beta gamma', kind: 'action' });

describe('createResolver (R-K5f, R-K6, R-K7)', () => {
  it('resolves an exact binding without writing a lock entry', async () => {
    const { resolver, lock } = harness(
      [descriptor({ id: 'ts:local#open', pattern: 'I open the settings page' })],
      {},
    );
    const step = makeStep({ text: 'I open the settings page', kind: 'action' });
    const result = await resolver.resolve(step, { frozen: false });
    expect(result.resolution.type).toBe('exact');
    expect(lock.entries()).toHaveLength(0);
  });

  it('R-K5f: records a semantic resolution with candidates and hashes', async () => {
    const { resolver, lock, registry } = harness(
      [descriptor({ id: 'ts:local#a', pattern: 'binding a text' })],
      { 'binding a text': unit(0.95) },
    );
    const result = await resolver.resolve(STEP, { frozen: false });
    expect(result.resolution.type).toBe('semantic');
    expect(result.lockStatus).toBe('new');
    const entry = lock.get(result.lockKey ?? '');
    expect(entry?.status).toBe('semantic');
    expect(entry?.bindingSetHash).toBe(registry.set().hash);
    expect(entry?.candidates[0]?.bindingHash).toBe(registry.find('ts:local#a')?.hash);
  });

  it('R-K5f: reports ambiguous when more than one binding matches exactly', async () => {
    const { resolver } = harness(
      [descriptor({ id: 'ts:local#a', pattern: 'I open the page' }), descriptor({ id: 'ts:local#b', pattern: 'I open the page' })],
      {},
    );
    const step = makeStep({ text: 'I open the page', kind: 'action' });
    const result = await resolver.resolve(step, { frozen: false });
    expect(result.resolution.type).toBe('ambiguous');
    if (result.resolution.type === 'ambiguous') expect(result.resolution.reason).toBe('multiple-exact');
  });

  it('R-K12: --frozen rejects a step that is not in the lockfile', async () => {
    const { resolver } = harness([descriptor({ id: 'ts:local#a', pattern: 'binding a text' })], { 'binding a text': unit(0.95) });
    await expect(resolver.resolve(STEP, { frozen: true })).rejects.toMatchObject({ code: 'RESOLUTION_NOT_LOCKED' });
  });

  it('R-K12: --frozen passes an unchanged locked entry', async () => {
    const first = harness([descriptor({ id: 'ts:local#a', pattern: 'binding a text' })], { 'binding a text': unit(0.95) });
    await first.resolver.resolve(STEP, { frozen: false });
    await first.lock.save();

    const second = harness([descriptor({ id: 'ts:local#a', pattern: 'binding a text' })], { 'binding a text': unit(0.95) }, {}, first.lockPath);
    const result = await second.resolver.resolve(STEP, { frozen: true });
    expect(result.lockStatus).toBe('unchanged');
    expect(result.resolution.type).toBe('semantic');
  });

  it('R-K12: --frozen fails when the locked entry changed', async () => {
    const first = harness([descriptor({ id: 'ts:local#a', pattern: 'binding a text' })], { 'binding a text': unit(0.95) });
    await first.resolver.resolve(STEP, { frozen: false });
    await first.lock.save();

    const second = harness(
      [descriptor({ id: 'ts:local#a', pattern: 'binding a text', description: 'now with a description' })],
      { 'binding a text': unit(0.95) },
      {},
      first.lockPath,
    );
    await expect(second.resolver.resolve(STEP, { frozen: true })).rejects.toMatchObject({ code: 'RESOLUTION_NOT_LOCKED' });
  });

  it('R-K6: reuses an unchanged lock entry without re-resolving', async () => {
    const { resolver, lock } = harness([descriptor({ id: 'ts:local#a', pattern: 'binding a text' })], { 'binding a text': unit(0.95) });
    const first = await resolver.resolve(STEP, { frozen: false });
    const second = await resolver.resolve(STEP, { frozen: false });
    expect(second.lockStatus).toBe('unchanged');
    expect(second.resolution).toEqual(first.resolution);
    expect(lock.get(second.lockKey ?? '')?.revalidated).toBeUndefined();
  });

  it('R-K6: revalidates the winner when an unrelated binding is added', async () => {
    const { resolver, lock, registry } = harness([descriptor({ id: 'ts:local#a', pattern: 'binding a text' })], { 'binding a text': unit(0.95) });
    await resolver.resolve(STEP, { frozen: false });
    registry.add(descriptor({ id: 'ts:local#c', pattern: 'binding c text' }));
    // The new binding embeds to zero, so the winner is unchanged.
    const result = await resolver.resolve(STEP, { frozen: false });
    expect(result.lockStatus).toBe('revalidated');
    expect(lock.get(result.lockKey ?? '')?.revalidated).toBe(true);
    expect(lock.get(result.lockKey ?? '')?.bindingSetHash).toBe(registry.set().hash);
  });

  it('R-K6: re-resolves when the winner changes', async () => {
    const { resolver, registry } = harness(
      [descriptor({ id: 'ts:local#a', pattern: 'binding a text' })],
      { 'binding a text': unit(0.5), 'binding c text': unit(0.95) },
    );
    const first = await resolver.resolve(STEP, { frozen: false });
    expect(first.resolution.type).toBe('agent');
    registry.add(descriptor({ id: 'ts:local#c', pattern: 'binding c text' }));
    const second = await resolver.resolve(STEP, { frozen: false });
    expect(second.resolution.type).toBe('semantic');
    if (second.resolution.type === 'semantic') expect(second.resolution.bindingId).toBe('ts:local#c');
    expect(second.lockStatus).toBe('changed');
  });

  it('returns unbound for a setup step when agent setup is not allowed', async () => {
    const { resolver } = harness([], {}, { allowAgentSetup: false });
    const step = makeStep({ text: 'a workspace exists', kind: 'setup' });
    const result = await resolver.resolve(step, { frozen: false });
    expect(result.resolution).toMatchObject({ type: 'unbound', reason: 'setup-unbound' });
  });

  it('records an agent fallback with the ranked candidates', async () => {
    const { resolver, lock } = harness([descriptor({ id: 'ts:local#a', pattern: 'binding a text' })], { 'binding a text': unit(0.5) });
    const result = await resolver.resolve(STEP, { frozen: false });
    expect(result.resolution).toMatchObject({ type: 'agent', reason: 'below-threshold' });
    const entry = lock.get(result.lockKey ?? '');
    expect(entry?.status).toBe('agent');
    expect(entry?.candidates).toHaveLength(1);
  });
});
