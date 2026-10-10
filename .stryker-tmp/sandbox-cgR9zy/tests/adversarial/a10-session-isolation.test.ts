// @ts-nocheck
// Attack 10: cross-session leakage under 8 workers (R-RN2).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Driver, DriverFactory, DriverSession, ModelRequest, Policy } from '@ai-bdd/sdk/contracts';
import { fakeDriver, startAcmeApp } from '@ai-bdd/testing';
import { playwright } from '@ai-bdd/driver-playwright';
import { createProject, extraction, makeEngine, modelSet, playwrightUnavailableReason, quoteFrom, toolCall, type Project, type XFeature } from './helpers/kit.ts';
import { startHostileSite, type HostileSite } from './helpers/hostile-site.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

const N = 16;
const tok = (i: number): string => `ZTOK-${String(i).padStart(2, '0')}`;
const TOKEN_RE = /ZTOK-\d+/g;

function refOf(req: ModelRequest, role: string, name: string): string {
  const nodes = req.context['nodes'] as { ref: string; role: string; name: string }[];
  const hit = nodes.find((x) => x.role === role && x.name === name);
  if (hit === undefined) throw new Error(`no ${role} "${name}" in ${nodes.map((x) => `${x.role}:${x.name}`).join(', ')}`);
  return hit.ref;
}

/** Wrap a driver factory: count sessions open at once, optionally per shared resource, and log every open / close. */
function tracking(inner: DriverFactory, id: string, shared: { open: number; peak: number; log: string[] }): DriverFactory {
  return {
    id,
    async create(ctx) {
      const d = await inner.create(ctx);
      return {
        ...d,
        id,
        async openSession(o) {
          shared.open += 1;
          shared.peak = Math.max(shared.peak, shared.open);
          shared.log.push(`open ${id} ${o.scenarioId}`);
          const s = await d.openSession(o);
          const close = s.close.bind(s);
          s.close = async () => {
            shared.open -= 1;
            shared.log.push(`close ${id} ${o.scenarioId}`);
            return close();
          };
          return s;
        },
      };
    },
  };
}

function todoModels(violations: string[], opts: { delayMs?: (i: number) => number } = {}) {
  const featureFor = (q: { handle: string; quote: string }, i: number): XFeature => ({
    title: `Todo ${i}`,
    sources: [q],
    scenarios: [{ title: `Add ${tok(i)}`, sources: [q], steps: [{ kind: 'when', text: `the visitor adds the todo ${tok(i)}` }, { kind: 'then', text: `the todo ${tok(i)} is listed` }] }],
  });
  return modelSet({
    extract: (req) => {
      const q = quoteFrom(req, 'Visitors can add a todo item');
      return q === null ? { object: extraction([]) } : { object: extraction(Array.from({ length: N }, (_, i) => featureFor(q, i))) };
    },
    act: async (req) => {
      const text = String(req.context['stepText']);
      const own = /ZTOK-\d+/.exec(text)?.[0] ?? '';
      const i = Number(own.slice(5));
      if (opts.delayMs !== undefined) await new Promise((r) => setTimeout(r, opts.delayMs?.(i) ?? 0));
      const turn = Number(req.context['turn']);
      const seen = JSON.stringify(req.context['nodes']).match(TOKEN_RE) ?? [];
      for (const t of seen) if (t !== own) violations.push(`act ${own} saw ${t}`);
      if (turn === 0) return toolCall('fill', { ref: refOf(req, 'textbox', 'New todo'), text: own });
      if (turn === 1) return toolCall('click', { ref: refOf(req, 'button', 'Add') });
      return toolCall('complete_step', { status: 'done', summary: 'added' });
    },
    judge: (req) => {
      const own = /ZTOK-\d+/.exec(String(req.context['criterion']))?.[0] ?? '';
      const seen = `${String(req.context['afterTreeText'])}\n${String(req.context['beforeTreeText'])}`.match(TOKEN_RE) ?? [];
      for (const t of seen) if (t !== own) violations.push(`judge ${own} saw ${t}`);
      return { object: { probability: 0.95, verdict: 'holds', explanation: 'ok', observed: 'ok' } };
    },
    checkgen: () => ({ object: { classification: 'invariant', predicates: [{ op: 'exists', query: { role: 'heading', name: 'Todos', nameMatch: null, testId: null, within: null }, negate: null }] } }),
  });
}

const TODO_DOC = '# Todos\n\n<!-- ai-bdd: start=/todos -->\n\n## Adding\n\nVisitors can add a todo item to the list on the todos page.\n';

describe('A10 R-RN2 fake driver, 8 workers', () => {
  it('A10 R-RN2: 16 scenarios on 8 workers never see each other\'s todos in the agent context, the judge evidence or the fixtures; results keep selection order despite reversed latencies', async () => {
    project = createProject({ docs: [] });
    project.writeDoc('todos', TODO_DOC);
    const violations: string[] = [];
    const models = todoModels(violations, { delayMs: (i) => (N - i) * 4 });
    const shared = { open: 0, peak: 0, log: [] as string[] };
    const h = await makeEngine(project, { models, driver: tracking(fakeDriver({ maxSessions: 8 }), 'fake', shared) });
    await h.engine.compile();
    const planOrder = (await h.engine.listScenarios()).map((t) => t.scenario.title);
    const report = await h.engine.run({ workers: 8, compile: false });
    await h.close();
    expect(violations).toEqual([]);
    expect(planOrder).toHaveLength(N);
    expect(report.scenarios).toHaveLength(N);
    expect(report.scenarios.map((s) => s.status)).toEqual(Array(N).fill('passed'));
    // selection order is plan order (feature order), not completion order
    expect(report.scenarios.map((s) => s.title)).toEqual(planOrder);
    expect(shared.peak).toBeGreaterThan(1);
    expect(shared.peak).toBeLessThanOrEqual(8);
    expect(shared.open).toBe(0);
  });

  it('A10 R-RN2: maxSessions is a hard cap on concurrently open sessions of a driver (confirm runs included), with no SESSION_LIMIT errors', async () => {
    project = createProject({ docs: [] });
    project.writeDoc('todos', TODO_DOC);
    const violations: string[] = [];
    const shared = { open: 0, peak: 0, log: [] as string[] };
    const h = await makeEngine(project, { models: todoModels(violations), driver: tracking(fakeDriver({ maxSessions: 2 }), 'fake', shared) });
    await h.engine.compile();
    const report = await h.engine.run({ workers: 8, compile: false });
    await h.close();
    expect(report.scenarios.every((s) => s.status === 'passed'), JSON.stringify(report.scenarios.filter((s) => s.status !== 'passed').map((s) => s.error))).toBe(true);
    expect(shared.peak).toBeLessThanOrEqual(2);
    expect(violations).toEqual([]);
  });

  it('A10 R-RN2: two drivers that declare the same exclusiveResource string never have sessions open at the same time', async () => {
    project = createProject({ docs: [] });
    project.writeDoc('todos', TODO_DOC.replace('## Adding\n', '## Adding\n\n<!-- ai-bdd: driver=fake2 -->\n'));
    project.writeDoc('todos-b', TODO_DOC.replace('Visitors can add', 'Visitors may also add'));
    const violations: string[] = [];
    const shared = { open: 0, peak: 0, log: [] as string[] };
    const a = tracking(fakeDriver({ exclusiveResource: 'the-db' }), 'fake', shared);
    const b = tracking(fakeDriver({ exclusiveResource: 'the-db' }), 'fake2', shared);
    const models = modelSet({
      ...todoModelFns(violations),
      extract: (req) => {
        const q = quoteFrom(req, 'add a todo item');
        if (q === null) return { object: extraction([]) };
        const doc = String(req.context['docUri']);
        const base = doc.includes('-b') ? 100 : 0;
        return { object: extraction(Array.from({ length: 4 }, (_, i) => ({ title: `T${base + i}`, sources: [q], scenarios: [{ title: `Add ${tok(base + i)}`, sources: [q], steps: [{ kind: 'when', text: `the visitor adds the todo ${tok(base + i)}` }, { kind: 'then', text: `the todo ${tok(base + i)} is listed` }] }] }))) };
      },
    });
    const h2 = await makeEngine(project, { models, driver: a, extraDrivers: [b] });
    await h2.engine.compile();
    const report = await h2.engine.run({ workers: 8, compile: false });
    await h2.close();
    expect(report.scenarios.length).toBe(8);
    expect(report.scenarios.every((s) => s.status === 'passed'), JSON.stringify(report.scenarios.map((s) => [s.driver, s.status, s.error?.code]))).toBe(true);
    expect(new Set(shared.log.filter((l) => l.startsWith('open ')).map((l) => l.split(' ')[1]))).toEqual(new Set(['fake', 'fake2']));
    expect(shared.peak, 'sessions of drivers sharing an exclusive resource overlapped').toBe(1);
  });

  it('A10 R-RN2 R-SE2: taint is per session: a secret fill in one session leaves every other session untainted', async () => {
    const factory = fakeDriver({});
    const dir = mkdtempSync(join(tmpdir(), 'a10-'));
    const policy: Policy = { allowHosts: ['localhost'], denyVerbs: [] };
    const d = await factory.create({ projectRoot: dir, baseURL: 'http://localhost:4173', policy, artifactsDir: dir });
    const sessions: DriverSession[] = [];
    for (let i = 0; i < 8; i++) sessions.push(await d.openSession({ scenarioId: `s${i}`, baseURL: 'http://localhost:4173', policy, resolveValue: (v) => ('secret' in v ? 'hunter2-hunter2' : 'literal' in v ? v.literal : '') }));
    await Promise.all(sessions.map((s) => s.perform({ verb: 'navigate', url: '/login' })));
    const obs = await sessions[3]!.observe();
    const pw = obs.nodes.find((n) => n.name === 'Password')!;
    await sessions[3]!.perform({ verb: 'fill', target: { ref: pw.ref }, value: { secret: 'adminPassword' } });
    const tainted = await Promise.all(sessions.map(async (s) => (await s.observe()).tainted));
    expect(tainted).toEqual([false, false, false, true, false, false, false, false]);
    await Promise.all(sessions.map((s) => s.close()));
    await d.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
});

/** The plain model functions of todoModels (so a test can swap the extractor). */
function todoModelFns(violations: string[]) {
  const m = todoModels(violations);
  return {
    act: (req: ModelRequest) => m.act.generate(req),
    judge: (req: ModelRequest) => m.judge.generate(req),
    checkgen: (req: ModelRequest) => m.checkgen.generate(req),
  };
}

const skip = playwrightUnavailableReason();

describe.skipIf(skip !== null)(`A10 R-RN2 Playwright driver, 8 concurrent sessions${skip === null ? '' : ` (skipped: ${skip})`}`, () => {
  let site: HostileSite;
  let driver: Driver;
  let tmp: string;
  const policy: Policy = { allowHosts: ['localhost', '127.0.0.1', '[::1]'], denyVerbs: [] };

  beforeAll(async () => {
    site = await startHostileSite();
    tmp = mkdtempSync(join(tmpdir(), 'a10pw-'));
    driver = await playwright({ browser: 'chromium', headless: true }).create({ projectRoot: tmp, baseURL: site.origin, policy, artifactsDir: tmp });
  }, 60_000);
  afterAll(async () => {
    await driver?.dispose();
    await site?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('A10 R-RN2: cookies, localStorage and sessionStorage written in one session are invisible to the 7 others', async () => {
    const sessions: DriverSession[] = await Promise.all(Array.from({ length: 8 }, (_, i) => driver.openSession({ scenarioId: `pw${i}`, baseURL: site.origin, policy, resolveValue: () => '' })));
    expect((await sessions[0]!.perform({ verb: 'navigate', url: `${site.origin}/set-state?v=ONLY-IN-ZERO` })).ok).toBe(true);
    const texts = await Promise.all(
      sessions.map(async (s, i) => {
        if (i !== 0) expect((await s.perform({ verb: 'navigate', url: `${site.origin}/get-state` })).ok).toBe(true);
        else expect((await s.perform({ verb: 'navigate', url: `${site.origin}/get-state` })).ok).toBe(true);
        const obs = await s.observe();
        return obs.nodes.find((n) => n.role === 'heading' && n.name.startsWith('cookie='))?.name ?? obs.treeText;
      }),
    );
    expect(texts[0]).toContain('ONLY-IN-ZERO');
    for (const t of texts.slice(1)) expect(t).toBe('cookie=[] local=[] session=[]');
    await Promise.all(sessions.map((s) => s.close()));
  }, 60_000);

  it('A10 R-RN2: 8 browser sessions against one Acme server keep their todo lists apart (server state is per cookie)', async () => {
    const app = await startAcmeApp({});
    try {
      const pol: Policy = { allowHosts: ['localhost', '127.0.0.1', '[::1]'], denyVerbs: [] };
      const d = await playwright({ browser: 'chromium', headless: true }).create({ projectRoot: tmp, baseURL: app.url, policy: pol, artifactsDir: tmp });
      const sessions = await Promise.all(Array.from({ length: 8 }, (_, i) => d.openSession({ scenarioId: `acme${i}`, baseURL: app.url, policy: pol, resolveValue: (v) => ('literal' in v ? v.literal : '') })));
      await Promise.all(sessions.map((s) => s.perform({ verb: 'navigate', url: '/todos' })));
      // The Acme /todos page re-renders on a timer, which can swallow a fill; retry the add (this test is about isolation, not about that race).
      await Promise.all(
        sessions.map(async (s, i) => {
          for (let attempt = 0; attempt < 6; attempt++) {
            const obs = await s.observe();
            if (obs.treeText.includes(tok(i))) return;
            const box = obs.nodes.find((n) => n.role === 'textbox' && n.name === 'New todo');
            const add = obs.nodes.find((n) => n.role === 'button' && n.name === 'Add');
            if (box === undefined || add === undefined) {
              await s.perform({ verb: 'navigate', url: '/todos' });
              continue;
            }
            await s.perform({ verb: 'fill', target: { ref: box.ref }, value: { literal: tok(i) } });
            const again = await s.observe();
            const add2 = again.nodes.find((n) => n.role === 'button' && n.name === 'Add');
            if (add2 !== undefined) await s.perform({ verb: 'click', target: { ref: add2.ref } });
            await new Promise((r) => setTimeout(r, 250));
          }
        }),
      );
      const trees = await Promise.all(
        sessions.map(async (s, i) => {
          for (let k = 0; k < 40; k++) {
            const t = (await s.observe()).treeText;
            if (t.includes(tok(i))) return t;
            await new Promise((r) => setTimeout(r, 100));
          }
          return (await s.observe()).treeText;
        }),
      );
      trees.forEach((t, i) => {
        expect(t, `session ${i}: ${t}`).toContain(tok(i));
        for (let j = 0; j < 8; j++) if (j !== i) expect(t, `session ${i} sees ${tok(j)}`).not.toContain(tok(j));
      });
      await Promise.all(sessions.map((s) => s.close()));
      await d.dispose();
    } finally {
      await app.close();
    }
  }, 90_000);
});
