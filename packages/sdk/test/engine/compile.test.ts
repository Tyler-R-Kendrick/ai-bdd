import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine/index.ts';
import { AiBddError, type Engine, type RunEvent } from '../../src/contracts/index.ts';
import { stableJson } from '../../src/util/index.ts';
import { makeFixture, modelUsage, totalModelCalls, type Fixture } from './fakes.ts';

const open: { fx: Fixture; engine: Engine }[] = [];
async function setup(opts: Parameters<typeof makeFixture>[0] = {}) {
  const fx = await makeFixture(opts);
  const engine = await createEngine(fx.config, { modules: fx.modules });
  open.push({ fx, engine });
  return { fx, engine, world: fx.world };
}
afterEach(async () => {
  for (const { fx, engine } of open.splice(0)) {
    await engine.close();
    await rm(fx.world.tmp, { recursive: true, force: true });
  }
});

const planBytes = (w: { plans: Map<string, unknown> }): string => stableJson(Object.fromEntries([...w.plans.entries()]) as never);

describe('compile (R-EX1, R-PL2)', () => {
  it('R-EX1: compiling twice makes zero model calls the second time and leaves plan bytes identical', async () => {
    const { engine, world } = await setup();
    const first = await engine.compile();
    expect(first.exitCode).toBe(0);
    const extractCalls = totalModelCalls(world);
    expect(extractCalls).toBe(3); // billing: Billing + Downgrading, todos: Todos
    expect(first.usage).toEqual({ modelCalls: 3, inputTokens: 30, outputTokens: 15 });
    expect(world.planSaves.sort()).toEqual(['docs/billing.md', 'docs/todos.md']);
    const bytes = planBytes(world);

    world.modelCalls.length = 0;
    world.planSaves.length = 0;
    const second = await engine.compile();
    expect(totalModelCalls(world)).toBe(0);
    expect(second.usage).toEqual({ modelCalls: 0, inputTokens: 0, outputTokens: 0 });
    expect(second.docs.every((d) => d.state === 'fresh' && d.extractedSections.length === 0)).toBe(true);
    expect(world.planSaves).toEqual([]); // identical plans are not rewritten
    expect(planBytes(world)).toBe(bytes);
  });

  it('R-PL2: editing one paragraph re-extracts only that section', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    world.modelCalls.length = 0;
    world.extractLog.length = 0;
    world.planSaves.length = 0;
    world.docs.set('docs/billing.md', (world.docs.get('docs/billing.md') ?? '').replace('at any time', 'whenever they like'));
    const res = await engine.compile();
    expect(world.extractLog).toEqual(['docs/billing.md#downgrading']);
    expect(modelUsage(world).extract).toBe(1);
    const billing = res.docs.find((d) => d.docUri === 'docs/billing.md');
    expect(billing?.state).toBe('stale');
    expect(billing?.extractedSections).toEqual(['docs/billing.md#downgrading']);
    expect(world.planSaves).toEqual(['docs/billing.md']);
  });

  it('a new doc is "new", and compile covers all docs ordered by docUri', async () => {
    const { engine, world } = await setup();
    const res = await engine.compile();
    expect(res.docs.map((d) => [d.docUri, d.state])).toEqual([
      ['docs/billing.md', 'new'],
      ['docs/todos.md', 'new'],
    ]);
    expect(res.docs[0]?.added.length).toBeGreaterThan(0);
    expect(world.plans.size).toBe(2);
  });

  it('compile --full re-extracts every section even when nothing changed', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    world.modelCalls.length = 0;
    await engine.compile({ full: true });
    expect(modelUsage(world).extract).toBe(3);
  });

  it('removes plans of deleted docs and reports them as orphaned', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    world.docs.delete('docs/todos.md');
    const res = await engine.compile();
    expect(world.planRemoves).toEqual(['docs/todos.md']);
    expect(world.plans.has('docs/todos.md')).toBe(false);
    const orphan = res.docs.find((d) => d.docUri === 'docs/todos.md');
    expect(orphan?.state).toBe('orphaned');
    expect(orphan?.removed.length).toBe(1);
  });

  it('compile --check writes nothing, calls no model and exits 4 when anything is stale or new', async () => {
    const { engine, world } = await setup();
    const res = await engine.compile({ check: true });
    expect(res.exitCode).toBe(4);
    expect(world.planSaves).toEqual([]);
    expect(world.plans.size).toBe(0);
    expect(totalModelCalls(world)).toBe(0);
    expect(res.docs.map((d) => d.state)).toEqual(['new', 'new']);

    await engine.compile();
    world.modelCalls.length = 0;
    world.planSaves.length = 0;
    expect((await engine.compile({ check: true })).exitCode).toBe(0);
    world.docs.set('docs/todos.md', '# Todos\nsomething else entirely');
    expect((await engine.compile({ check: true })).exitCode).toBe(4);
    world.docs.delete('docs/billing.md');
    const orphaned = await engine.compile({ check: true });
    expect(orphaned.exitCode).toBe(4);
    expect(orphaned.docs.some((d) => d.state === 'orphaned')).toBe(true);
    expect(world.planSaves).toEqual([]);
    expect(world.planRemoves).toEqual([]);
    expect(totalModelCalls(world)).toBe(0);
  });

  it('compile --dry-run extracts but writes nothing (no saves, no removals)', async () => {
    const { engine, world } = await setup();
    const res = await engine.compile({ dryRun: true });
    expect(res.exitCode).toBe(0);
    expect(modelUsage(world).extract).toBe(3);
    expect(world.planSaves).toEqual([]);
    expect(world.plans.size).toBe(0);
    expect(res.docs[0]?.added.length).toBeGreaterThan(0);
  });

  it('restricts compile to the requested docs (exact uri or glob)', async () => {
    const { engine, world } = await setup();
    const res = await engine.compile({ docs: ['docs/todos.md'] });
    expect(res.docs.map((d) => d.docUri)).toEqual(['docs/todos.md']);
    expect(world.plans.has('docs/billing.md')).toBe(false);
    const res2 = await engine.compile({ docs: ['docs/b*.md'] });
    expect(res2.docs.map((d) => d.docUri)).toEqual(['docs/billing.md']);
  });

  it('extracts dirty sections concurrently, capped by extract.concurrency', async () => {
    const docs = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`docs/d${i}.md`, `# Doc ${i}\nbehaviour number ${i} is described here`]));
    const { engine, world } = await setup({ docs, user: { extract: { concurrency: 3 } } });
    world.modelDelayMs = 15;
    await engine.compile();
    expect(world.extractLog.length).toBe(8);
    expect(world.extractMaxInFlight).toBe(3);
  });

  it('a failed section keeps its previous features, stays dirty and gives exit code 1', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    const before = JSON.stringify(world.plans.get('docs/billing.md')?.features.filter((f) => f.sectionId === 'docs/billing.md#downgrading'));
    world.docs.set('docs/billing.md', (world.docs.get('docs/billing.md') ?? '').replace('at any time', 'on request'));
    world.failSections.add('downgrading');
    const res = await engine.compile();
    expect(res.exitCode).toBe(1);
    const billing = res.docs.find((d) => d.docUri === 'docs/billing.md');
    expect(billing?.failedSections).toEqual(['docs/billing.md#downgrading']);
    expect(JSON.stringify(world.plans.get('docs/billing.md')?.features.filter((f) => f.sectionId === 'docs/billing.md#downgrading'))).toBe(before);
    // still stale: the next compile retries only that section
    world.failSections.clear();
    world.extractLog.length = 0;
    expect((await engine.compile()).exitCode).toBe(0);
    expect(world.extractLog).toEqual(['docs/billing.md#downgrading']);
  });

  it('an extractor that throws is turned into a failed section (EXTRACT_SECTION_FAILED), not a crash', async () => {
    const { engine, world } = await setup();
    world.throwSections.add('todos');
    const res = await engine.compile();
    const todos = res.docs.find((d) => d.docUri === 'docs/todos.md');
    expect(todos?.failedSections).toEqual(['docs/todos.md#todos']);
    expect(todos?.diagnostics.some((d) => d.code === 'EXTRACT_SECTION_FAILED')).toBe(true);
    expect(res.exitCode).toBe(1);
  });

  it('R-RN3: a MODEL_UNAVAILABLE during compile is an infrastructure failure (exit 3, takes precedence over 1)', async () => {
    const { engine, world } = await setup();
    world.failModel = { purpose: 'extract', error: new AiBddError('MODEL_UNAVAILABLE', 'provider down') };
    const res = await engine.compile();
    expect(res.docs.every((d) => d.failedSections.length > 0)).toBe(true);
    expect(res.exitCode).toBe(3);
    expect(world.plans.size).toBe(2); // plans are still written (empty), nothing crashes
  });

  it('emits compile-section events (extracted / reused)', async () => {
    const { engine } = await setup();
    const events: RunEvent[] = [];
    const off = engine.on((e) => events.push(e));
    await engine.compile();
    await engine.compile();
    off();
    const statuses = events.flatMap((e) => (e.type === 'compile-section' ? [e.status] : []));
    expect(statuses.filter((s) => s === 'extracted').length).toBe(3);
    expect(statuses.filter((s) => s === 'reused').length).toBe(3);
    await engine.compile({ full: true });
    expect(events.length).toBe(6); // unsubscribed listener no longer receives events
  });

  it('wires the extractor with the decorated extract model and the configured fixtures catalog', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    const ctx = world.modelCalls[0]?.context;
    expect(ctx).toMatchObject({ docUri: 'docs/billing.md' });
  });
});
