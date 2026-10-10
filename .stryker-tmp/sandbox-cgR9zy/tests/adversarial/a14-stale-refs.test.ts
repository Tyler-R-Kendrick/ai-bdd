// @ts-nocheck
// Attack 14: stale refs used after re-observation (R-AG1 / R-AG2 / R-CH7 context): a ref belongs to ONE observation only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createActor, createRecorder, createRedactor, resolveConfig } from '@ai-bdd/sdk';
import type { ActRequest, Driver, DriverSession, ModelRequest, ModelResponse, ObservedNode, PerformedAction, Policy, Step } from '@ai-bdd/sdk/contracts';
import { fakeDriver } from '@ai-bdd/testing';
import { playwright } from '@ai-bdd/driver-playwright';
import { instantSettler, observation, playwrightUnavailableReason, StubSession } from './helpers/kit.ts';
import { startHostileSite, type HostileSite } from './helpers/hostile-site.ts';

const policy: Policy = { allowHosts: ['localhost', '127.0.0.1', '[::1]'], denyVerbs: [] };
const config = resolveConfig({}, { projectRoot: '/tmp/x', env: {} });
type N = Omit<ObservedNode, 'ref'>;
const n = (role: string, name: string, depth = 0, extra: Partial<N> = {}): N => ({ role, name, depth, states: {}, ...extra });
const STEP = { key: 'when:x', kind: 'when', text: 'the user clicks Upgrade', grounding: 'inferred', sources: [], params: {} } as Step;

const malformedRefs = ['', 'e5', 'r1:', 'r1:e', 'r1:e0', 'r-1:e1', 'r1:e1;DROP', 'r01:e1', 'R1:E1', 'r1:e1 ', ' r1:e1', 'r1.5:e1', 'r99999999999999999999:e1', '__proto__', 'constructor', 'r1:__proto__', 'r1:e999999', 'null', 'undefined', 'javascript:alert(1)', 'r1:e1\nr2:e2'];

describe('A14 R-CH7 the fake driver rejects every ref that is not from the latest observation', () => {
  async function open(): Promise<{ s: DriverSession; d: Driver; dir: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'a14-'));
    const d = await fakeDriver({}).create({ projectRoot: dir, baseURL: 'http://localhost:4173', policy, artifactsDir: dir });
    const s = await d.openSession({ scenarioId: 'a14', baseURL: 'http://localhost:4173', policy, resolveValue: (v) => ('literal' in v ? v.literal : '') });
    await s.perform({ verb: 'navigate', url: '/settings/billing' });
    return { s, d, dir };
  }

  it('A14: a ref from observation k is STALE_REF after observation k+1, even when the element is unchanged', async () => {
    const { s, d, dir } = await open();
    const first = await s.observe();
    const upgrade = first.nodes.find((x) => x.role === 'button' && x.name === 'Upgrade to Pro');
    expect(upgrade).toBeDefined();
    const second = await s.observe();
    expect(second.treeHash).toBe(first.treeHash);
    const out = await s.perform({ verb: 'click', target: { ref: (upgrade as ObservedNode).ref } });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('STALE_REF');
    // and nothing happened to the page
    expect((await s.observe()).nodes.some((x) => x.role === 'dialog')).toBe(false);
    await s.close();
    await d.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('A14: refs minted for a different session, a future revision or in a malformed shape never click anything', async () => {
    const a = await open();
    const b = await open();
    const obsA = await a.s.observe();
    const obsB = await b.s.observe();
    const refA = obsA.nodes.find((x) => x.name === 'Upgrade to Pro') as ObservedNode;
    // same revision number in another session: it resolves against ITS OWN snapshot only (never A's)
    const before = JSON.stringify((await b.s.observe()).nodes.map((x) => x.name));
    const futureRev = `r${obsB.revision + 5}:e1`;
    for (const ref of [futureRev, ...malformedRefs]) {
      const out = await b.s.perform({ verb: 'click', target: { ref } });
      expect(out.ok, ref).toBe(false);
      expect(['STALE_REF', 'TARGET_NOT_FOUND'], `${ref}: ${JSON.stringify(out.error)}`).toContain(out.error?.code);
    }
    // a ref copied from session A's latest observation into session B (B has observed more times) is stale for B
    const crossed = await b.s.perform({ verb: 'click', target: { ref: refA.ref } });
    expect(crossed.ok).toBe(false);
    expect(JSON.stringify((await b.s.observe()).nodes.map((x) => x.name))).toBe(before);
    for (const x of [a, b]) {
      await x.s.close();
      await x.d.dispose();
      rmSync(x.dir, { recursive: true, force: true });
    }
  });

  it('A14: hover, scroll, press and fill with a stale target ref fail the same way', async () => {
    const { s, d, dir } = await open();
    const first = await s.observe();
    const btn = first.nodes.find((x) => x.name === 'Upgrade to Pro') as ObservedNode;
    await s.observe();
    for (const action of [
      { verb: 'hover', target: { ref: btn.ref } },
      { verb: 'scroll', direction: 'down', target: { ref: btn.ref } },
      { verb: 'press', key: 'Enter', target: { ref: btn.ref } },
      { verb: 'fill', target: { ref: btn.ref }, value: { literal: 'x' } },
      { verb: 'select', target: { ref: btn.ref }, option: { literal: 'x' } },
      { verb: 'check', target: { ref: btn.ref }, checked: true },
    ] as const) {
      const out = await s.perform(action);
      expect(out.ok, action.verb).toBe(false);
      expect(out.error?.code, action.verb).toBe('STALE_REF');
    }
    await s.close();
    await d.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('A14 R-AG1 the actor only acts on refs of the observation it just made', () => {
  const nodes: N[] = [n('heading', 'Billing', 0, { level: 1 }), n('button', 'Upgrade'), n('button', 'Cancel')];

  function actorWith(script: (turn: number, req: ModelRequest) => ModelResponse['toolCalls']): { run: () => Promise<{ session: StubSession; status: string; results: unknown[] }> } {
    const results: unknown[] = [];
    const model = {
      id: 'scripted-act',
      async generate(req: ModelRequest): Promise<ModelResponse> {
        // record what the tool results of the previous turn said
        for (const m of req.messages) if (m.role === 'tool') results.push(m.result);
        const turn = Number(req.context['turn']);
        const calls = script(turn, req);
        return { toolCalls: calls, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'tool-calls', modelId: 'scripted-act' };
      },
    };
    const actor = createActor({ model, redactor: createRedactor({}), settler: instantSettler, config });
    return {
      async run() {
        const session = new StubSession(() => ({ nodes }));
        const req: ActRequest = { scenario: { id: 's', title: 't' }, step: STEP, priorSteps: [], params: {}, appContext: '', secretNames: [] };
        const res = await actor.act(req, session);
        return { session, status: res.status, results };
      },
    };
  }

  const refOfTurn = (req: ModelRequest, name: string): string => (req.context['nodes'] as { ref: string; name: string }[]).find((x) => x.name === name)?.ref ?? 'missing';

  it('A14: a ref reused from an earlier turn is rejected with STALE_REF and nothing is performed for it', async () => {
    let first = '';
    const { run } = actorWith((turn, req) => {
      if (turn === 0) {
        first = refOfTurn(req, 'Cancel');
        return [{ id: 't0', name: 'hover', args: { ref: refOfTurn(req, 'Upgrade') } }];
      }
      if (turn === 1) return [{ id: 't1', name: 'click', args: { ref: first } }];
      return [{ id: 't2', name: 'complete_step', args: { status: 'done', summary: 'ok' } }];
    });
    const { session, results } = await run();
    // only the hover of turn 0 was performed
    expect(session.performed.map((a) => a.verb)).toEqual(['hover']);
    expect(JSON.stringify(results)).toContain('STALE_REF');
  });

  it('A14: hallucinated, empty, non-string and object refs are rejected before the driver is touched', async () => {
    const bad: unknown[] = ['r999:e1', 'e1', '', null, 5, { ref: 'r1:e1' }, ['r1:e1']];
    let i = 0;
    const { run } = actorWith((turn) => {
      if (turn < bad.length) return [{ id: `t${turn}`, name: 'click', args: { ref: bad[turn] as never } }];
      return [{ id: 'done', name: 'complete_step', args: { status: 'done', summary: 'ok' } }];
    });
    const { session } = await run();
    expect(session.performed).toEqual([]);
    void i;
  });

  it('A14: two action calls in one turn execute only the first; the second sees "not executed: observation changed; re-plan"', async () => {
    const { run } = actorWith((turn, req) =>
      turn === 0
        ? [
            { id: 'a', name: 'click', args: { ref: refOfTurn(req, 'Upgrade') } },
            { id: 'b', name: 'click', args: { ref: refOfTurn(req, 'Cancel') } },
            { id: 'c', name: 'complete_step', args: { status: 'done', summary: 'x' } },
          ]
        : [{ id: 'd', name: 'complete_step', args: { status: 'done', summary: 'ok' } }],
    );
    const { session, results } = await run();
    expect(session.performed).toHaveLength(1);
    expect(JSON.stringify(results)).toContain('not executed: observation changed; re-plan');
  });

  it('A14: an action after complete_step in the same turn is not executed', async () => {
    const { run } = actorWith((turn, req) => (turn === 0 ? [{ id: 'a', name: 'complete_step', args: { status: 'done', summary: 'x' } }, { id: 'b', name: 'click', args: { ref: refOfTurn(req, 'Upgrade') } }] : []));
    const { session, status } = await run();
    expect(status).toBe('done');
    expect(session.performed).toEqual([]);
  });

  it('A14 R-CH7: replay re-observes before every action and only ever uses a ref from the observation made just before it', async () => {
    const recorder = createRecorder({ settler: instantSettler, config: {} });
    const pageA: N[] = [n('heading', 'Billing', 0, { level: 1 }), n('region', 'Plan'), n('button', 'First', 1)];
    const pageB: N[] = [n('heading', 'Billing', 0, { level: 1 }), n('region', 'Plan'), n('textbox', 'Note', 1), n('button', 'First', 1), n('button', 'Second', 1)];
    const done: N[] = [n('heading', 'Billing', 0, { level: 1 }), n('region', 'Plan'), n('status', 'Saved', 1), n('button', 'First', 1), n('button', 'Second', 1)];
    const before = observation(pageA, { revision: 1 });
    const mid = observation(pageB, { revision: 2 });
    const after = observation(done, { revision: 3 });
    const first = before.nodes.find((x) => x.name === 'First') as ObservedNode;
    const second = mid.nodes.find((x) => x.name === 'Second') as ObservedNode;
    const performed: PerformedAction[] = [
      { action: { verb: 'click', target: { ref: first.ref } }, target: first, chosenFrom: before, outcome: { ok: true } },
      { action: { verb: 'click', target: { ref: second.ref } }, target: second, chosenFrom: mid, outcome: { ok: true } },
    ];
    const rec = recorder.toRecording(performed, before, after, after, STEP);
    let state: 'A' | 'B' | 'done' = 'A';
    const session = new StubSession(
      () => ({ nodes: state === 'A' ? pageA : state === 'B' ? pageB : done }),
      (a) => {
        if (a.verb === 'click' && state === 'A') state = 'B';
        else if (a.verb === 'click' && state === 'B') state = 'done';
        return { ok: true };
      },
    );
    const res = await recorder.replay(rec.act, session, { policy });
    expect(res.outcome).toBe('replayed');
    expect(session.performLog).toHaveLength(2);
    for (const entry of session.performLog) {
      const a = entry.action;
      if (a.verb !== 'click') continue;
      expect(a.target.ref.startsWith(`r${entry.observes}:`), `ref ${a.target.ref} used after ${entry.observes} observations`).toBe(true);
    }
  });
});

const skip = playwrightUnavailableReason();

describe.skipIf(skip !== null)(`A14 R-CH7 the Playwright driver rejects stale refs${skip === null ? '' : ` (skipped: ${skip})`}`, () => {
  let site: HostileSite;
  let driver: Driver;
  let tmp: string;
  beforeAll(async () => {
    site = await startHostileSite();
    tmp = mkdtempSync(join(tmpdir(), 'a14pw-'));
    driver = await playwright({ browser: 'chromium', headless: true }).create({ projectRoot: tmp, baseURL: site.origin, policy, artifactsDir: tmp });
  }, 60_000);
  afterAll(async () => {
    await driver?.dispose();
    await site?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('A14: a ref of observation k is STALE_REF once observation k+1 exists', async () => {
    const s = await driver.openSession({ scenarioId: 'a14', baseURL: site.origin, policy, resolveValue: () => '' });
    await s.perform({ verb: 'navigate', url: `${site.origin}/swap` });
    const first = await s.observe();
    const alpha = first.nodes.find((x) => x.name === 'Alpha') as ObservedNode;
    await s.observe();
    const out = await s.perform({ verb: 'click', target: { ref: alpha.ref } });
    expect(out.error?.code).toBe('STALE_REF');
    expect(site.hits.filter((h) => h.path.startsWith('/click'))).toEqual([]);
    for (const ref of malformedRefs) {
      const bad = await s.perform({ verb: 'click', target: { ref } });
      expect(bad.ok, ref).toBe(false);
    }
    expect(site.hits.filter((h) => h.path.startsWith('/click'))).toEqual([]);
    await s.close();
  }, 30_000);

  it('A14: after the click navigated to a re-ordered page, the old ref of the OTHER button does not click whatever sits at its old position', async () => {
    site.reset();
    const s = await driver.openSession({ scenarioId: 'a14', baseURL: site.origin, policy, resolveValue: () => '' });
    await s.perform({ verb: 'navigate', url: `${site.origin}/swap` });
    const first = await s.observe();
    const alpha = first.nodes.find((x) => x.name === 'Alpha') as ObservedNode;
    const beta = first.nodes.find((x) => x.name === 'Beta') as ObservedNode;
    expect((await s.perform({ verb: 'click', target: { ref: alpha.ref } })).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    // the page now shows Beta first, Alpha second. No new observation was made: the old Beta ref is the stale one.
    const stale = await s.perform({ verb: 'click', target: { ref: beta.ref } });
    await new Promise((r) => setTimeout(r, 500));
    const clicks = site.hits.filter((h) => h.path.startsWith('/click')).map((h) => h.path);
    expect(clicks, `second click outcome ${JSON.stringify(stale)}`).toEqual(['/click?b=A']);
    await s.close();
  }, 30_000);
});
