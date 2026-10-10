import { readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AiBddError, type ChunkedDoc, type Engine, type RunEvent, type RunReport } from '../../src/contracts/index.ts';
import { createEngine, type EngineModules } from '../../src/engine/index.ts';
import { makeFixture, type Fixture } from './fakes.ts';

const open: { fx: Fixture; engine: Engine }[] = [];
async function setup(opts: Parameters<typeof makeFixture>[0] = {}, overrides: (fx: Fixture) => Partial<EngineModules> = () => ({})) {
  const fx = await makeFixture(opts);
  const engine = await createEngine(fx.config, { modules: { ...fx.modules, ...overrides(fx) } });
  open.push({ fx, engine });
  return { fx, engine, world: fx.world, config: fx.config };
}
afterEach(async () => {
  for (const { fx, engine } of open.splice(0)) {
    await engine.close();
    await rm(fx.world.tmp, { recursive: true, force: true });
  }
});

/** Chunker that marks the given doc as unreadable (the chunker reports it as an error diagnostic). */
const unreadable = (uri: string) => (fx: Fixture): Partial<EngineModules> => ({
  createChunker: () => {
    const inner = fx.modules.createChunker();
    return {
      chunk: (doc, o): ChunkedDoc => {
        const chunked = inner.chunk(doc, o);
        return doc.uri === uri
          ? { ...chunked, diagnostics: [...chunked.diagnostics, { code: 'DOC_READ_FAILED', severity: 'error', message: `cannot read ${uri}`, uri }] }
          : chunked;
      },
    };
  },
});

describe('run: unreadable documents', () => {
  it('R-PL2: a frozen run stops with DOC_READ_FAILED naming the unreadable docs, and nothing runs', async () => {
    const { engine, world } = await setup({}, unreadable('docs/todos.md'));
    const err = await engine.run({ frozen: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiBddError);
    expect((err as AiBddError).code).toBe('DOC_READ_FAILED');
    expect((err as AiBddError).message).toBe('Cannot read one or more documents');
    expect((err as AiBddError).details).toEqual({ docs: ['docs/todos.md'] });
    expect(world.runnerCalls).toEqual([]);
    expect(world.evidences).toEqual([]);
  });

  it('a non-frozen run that cannot read a document fails with DOC_READ_FAILED, runs nothing, and still finalizes its evidence', async () => {
    const { engine, world } = await setup({}, unreadable('docs/billing.md'));
    const err = await engine.run().catch((e: unknown) => e);
    expect((err as AiBddError).code).toBe('DOC_READ_FAILED');
    expect((err as AiBddError).message).toBe('Cannot read one or more documents');
    expect(world.runnerCalls).toEqual([]);
    expect(world.evidences).toHaveLength(1);
    expect(world.evidences[0]?.finalized).toBe(1);
  });
});

describe('run: reporters', () => {
  it('a reporter that throws is logged and skipped; the other reporters still write and the run succeeds', async () => {
    const { engine, config } = await setup({}, (fx) => ({
      createReporters: (names) => {
        const real = fx.modules.createReporters(names);
        return real.map((r) => (r.name === 'junit' ? { name: r.name, render: () => Promise.reject(new Error('disk full')) } : r));
      },
    }));
    const events: RunEvent[] = [];
    engine.on((e) => events.push(e));
    const report = await engine.run();
    expect(report.exitCode).toBe(0);
    const errors = events.filter((e): e is Extract<RunEvent, { type: 'log' }> => e.type === 'log' && e.level === 'error');
    expect(errors.map((e) => e.message)).toEqual(['reporter "junit" failed: disk full']);
    const latest = join(dirname(config.runsDir), 'report');
    expect((await readdir(latest)).sort()).toEqual(['report.json', 'summary.md']);
    const onDisk = JSON.parse(await readFile(join(latest, 'report.json'), 'utf8')) as RunReport;
    expect(onDisk.runId).toBe(report.runId);
  });

  it('a reporter that throws something other than an Error is logged by its string form', async () => {
    const { engine } = await setup({}, () => ({
      createReporters: () => [{ name: 'json', render: () => Promise.reject('plain failure') }],
    }));
    const events: RunEvent[] = [];
    engine.on((e) => events.push(e));
    await engine.run();
    expect(events.filter((e) => e.type === 'log' && e.level === 'error').map((e) => (e as { message: string }).message)).toEqual(['reporter "json" failed: plain failure']);
  });

  it('the latest-report directory is replaced, not merged, by each run', async () => {
    const { engine, config } = await setup();
    await engine.run();
    await engine.run({ compile: false, reporters: ['json'] });
    expect((await readdir(join(dirname(config.runsDir), 'report'))).sort()).toEqual(['report.json']);
  });
});

describe('run: options reach the pipeline', () => {
  it('the abort signal is handed to the runner when one is given, and omitted otherwise', async () => {
    const { engine, world } = await setup();
    const ac = new AbortController();
    await engine.run({ signal: ac.signal });
    expect(world.runnerCalls).not.toHaveLength(0);
    expect(world.runnerCalls.every((c) => c.opts.signal === ac.signal)).toBe(true);

    world.runnerCalls.length = 0;
    await engine.run({ compile: false });
    expect(world.runnerCalls.every((c) => !('signal' in c.opts))).toBe(true);
  });

  it('an already aborted signal stops the run before anything is created', async () => {
    const { engine, world } = await setup();
    const ac = new AbortController();
    ac.abort();
    await expect(engine.run({ signal: ac.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(world.evidences).toEqual([]);
    expect(world.runnerCalls).toEqual([]);
  });

  it('the driver option is passed through to the runner', async () => {
    const { engine, world } = await setup();
    await engine.run({ driver: 'fake', selectors: ['docs-todos--'] });
    expect(world.runnerCalls.map((c) => c.opts.driver)).toEqual(['fake']);
  });

  it('tags that no scenario carries select nothing, without tags everything is selected', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    const none = await engine.run({ compile: false, tags: ['no-such-tag'] });
    expect(none.scenarios).toEqual([]);
    expect(world.runnerCalls).toEqual([]);
    const all = await engine.run({ compile: false });
    expect(all.scenarios).toHaveLength(3);
  });
});

describe('run: frozen report with prices configured', () => {
  it('a frozen run that exits 4 still reports a cost of zero when prices are configured', async () => {
    const { engine } = await setup({ user: { prices: { 'fake-act': { inputPerMTok: 2, outputPerMTok: 10 } } } });
    const report = await engine.run({ frozen: true });
    expect(report.exitCode).toBe(4);
    expect(report.usage.estimatedCostUsd).toBe(0);
  });

  it('a frozen run that exits 4 has no cost field when no prices are configured', async () => {
    const { engine } = await setup();
    const report = await engine.run({ frozen: true });
    expect(report.exitCode).toBe(4);
    expect('estimatedCostUsd' in report.usage).toBe(false);
  });
});
