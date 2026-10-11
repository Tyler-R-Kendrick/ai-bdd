import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import {
  validateDriverPlan,
  validateModelPlan,
  type DriverFaultPlan,
  type DriverRule,
  type ModelFaultPlan,
  type ModelRule,
} from '@ai-bdd/testing';
import { createRecorder, cursorsFor, decide, hang } from '../../src/chaos/plan.ts';

const problemsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AiBddError);
    expect((err as AiBddError).code).toBe('CONFIG_INVALID');
    return ((err as AiBddError).details as { problems: string[] }).problems;
  }
  throw new Error('expected the plan to be rejected');
};

const driverPlan = (...rules: unknown[]): DriverFaultPlan => ({ seed: 1, rules: rules as unknown as DriverRule[] });
const modelPlan = (...rules: unknown[]): ModelFaultPlan => ({ seed: 1, rules: rules as unknown as ModelRule[] });

describe('validateDriverPlan', () => {
  it('accepts a sound plan and returns it unchanged', () => {
    const plan: DriverFaultPlan = {
      seed: 'ok',
      rules: [
        { at: 'observe', nth: [2, 5], fault: { kind: 'garble', mode: 'shuffle' } },
        { at: 'perform', verb: 'click', session: 2, probability: 0.5, times: 3, fault: { kind: 'fail', code: 'STALE_REF' } },
        { at: 'openSession', from: 1, times: 2, fault: { kind: 'throw', code: 'DRIVER_UNAVAILABLE' } },
        { at: 'close', fault: { kind: 'throw-raw' } },
        { at: 'dispose', fault: { kind: 'latency', ms: 10 } },
      ],
    };
    expect(validateDriverPlan(plan)).toBe(plan);
  });

  it('lists every problem at once, naming the rule', () => {
    const problems = problemsOf(() =>
      validateDriverPlan(
        driverPlan(
          { at: 'nowhere', fault: { kind: 'hang' } },
          { at: 'perform', fault: { kind: 'garble', mode: 'shuffle' } },
          { at: 'observe', fault: { kind: 'fail' } },
          { at: 'create', fault: { kind: 'drop-session' } },
          { at: 'observe', verb: 'click', fault: { kind: 'hang' } },
          { at: 'create', session: 1, fault: { kind: 'hang' } },
          { at: 'observe', fault: { kind: 'garble', mode: 'melt' } },
          { at: 'observe', fault: { kind: 'throw', code: 'POLICY_DENIED' } },
          { at: 'observe', fault: { kind: 'latency', ms: -1 } },
          { at: 'observe', fault: { kind: 'explode' } },
          { at: 'observe', fault: null },
          'nope',
        ),
      ),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('rules[0]: unknown hook "nowhere"'),
        expect.stringContaining('rules[1]: fault "garble" cannot strike "perform"'),
        expect.stringContaining('rules[2]: fault "fail" cannot strike "observe"'),
        expect.stringContaining('rules[3]: fault "drop-session" cannot strike "create"'),
        expect.stringContaining('rules[4]: verb only applies to "perform"'),
        expect.stringContaining('rules[5]: session only applies to'),
        expect.stringContaining('rules[6]: unknown garble mode "melt"'),
        expect.stringContaining('rules[7]: unsupported code "POLICY_DENIED"'),
        expect.stringContaining('rules[8]: latency ms must be >= 0'),
        expect.stringContaining('rules[9]: unknown fault kind "explode"'),
        expect.stringContaining('rules[10]: unknown fault kind "undefined"'),
        expect.stringContaining('rules[11]: must be an object'),
      ]),
    );
  });

  it('rejects malformed triggers and plan shapes', () => {
    const problems = problemsOf(() =>
      validateDriverPlan(
        driverPlan(
          { at: 'observe', nth: 0, fault: { kind: 'hang' } },
          { at: 'observe', nth: [], fault: { kind: 'hang' } },
          { at: 'observe', from: 1.5, fault: { kind: 'hang' } },
          { at: 'observe', times: 0, fault: { kind: 'hang' } },
          { at: 'observe', probability: 1.5, fault: { kind: 'hang' } },
          { at: 'observe', session: 0, fault: { kind: 'hang' } },
        ),
      ),
    );
    expect(problems).toHaveLength(6);
    expect(problemsOf(() => validateDriverPlan({ seed: Number.NaN, rules: 'x' } as unknown as DriverFaultPlan))).toEqual([
      'seed must be a string or a finite number',
      'rules must be an array',
    ]);
    expect(problemsOf(() => validateDriverPlan(null as unknown as DriverFaultPlan))).toEqual(['plan must be an object { seed, rules }']);
  });
});

describe('validateModelPlan', () => {
  it('accepts a sound plan', () => {
    const plan: ModelFaultPlan = {
      seed: 3,
      rules: [
        { at: '*', from: 1, times: 2, fault: { kind: 'rate-limit' } },
        { at: 'extract', context: { attempt: 1 }, fault: { kind: 'malformed-json' } },
        { at: 'act', fault: { kind: 'bad-tool-call', mode: 'unknown-tool' } },
        { at: 'judge', fault: { kind: 'oversized', chars: 10, where: 'object' } },
        { at: 'checkgen', fault: { kind: 'finish-reason', reason: 'length' } },
        { at: 'judge', fault: { kind: 'hang', ignoreSignal: true } },
      ],
    };
    expect(validateModelPlan(plan)).toBe(plan);
  });

  it('lists every problem at once', () => {
    const problems = problemsOf(() =>
      validateModelPlan(
        modelPlan(
          { at: 'vision', fault: { kind: 'hang' } },
          { at: 'act', fault: { kind: 'bad-tool-call', mode: 'rm-rf' } },
          { at: 'act', fault: { kind: 'finish-reason', reason: 'tired' } },
          { at: 'act', fault: { kind: 'oversized', chars: 0 } },
          { at: 'act', fault: { kind: 'throw', code: 'POLICY_DENIED' } },
          { at: 'act', fault: { kind: 'latency', ms: Number.NaN } },
          { at: 'act', fault: { kind: 'melt' } },
          { at: 'act', probability: -1, fault: { kind: 'hang' } },
          7,
        ),
      ),
    );
    expect(problems).toHaveLength(9);
    expect(problems[0]).toContain('rules[0]: unknown purpose "vision"');
    expect(problems.join('\n')).toContain('rules[6]: unknown fault kind "melt"');
  });
});

describe('rule triggers', () => {
  const run = (rule: Partial<DriverRule>, calls: number, seed: number | string = 1): number[] => {
    const cursor = cursorsFor({ seed, rules: [rule] })[0];
    if (cursor === undefined) throw new Error('no cursor');
    const hits: number[] = [];
    for (let i = 1; i <= calls; i += 1) if (decide(rule as DriverRule, cursor)) hits.push(i);
    return hits;
  };

  it('with no condition a rule fires on every call', () => {
    expect(run({}, 4)).toEqual([1, 2, 3, 4]);
  });

  it('nth fires on the listed calls only', () => {
    expect(run({ nth: 3 }, 6)).toEqual([3]);
    expect(run({ nth: [2, 4, 9] }, 6)).toEqual([2, 4]);
  });

  it('from fires on that call and every later one, and times caps the injections: N consecutive failures then success', () => {
    expect(run({ from: 3 }, 6)).toEqual([3, 4, 5, 6]);
    expect(run({ from: 1, times: 2 }, 6)).toEqual([1, 2]);
    expect(run({ from: 2, times: 3 }, 8)).toEqual([2, 3, 4]);
    expect(run({ times: 1 }, 3)).toEqual([1]);
  });

  it('probability is decided by the seeded generator: reproducible, seed-dependent, roughly proportional', () => {
    const a = run({ probability: 0.3 }, 400, 'p');
    expect(run({ probability: 0.3 }, 400, 'p')).toEqual(a);
    expect(run({ probability: 0.3 }, 400, 'q')).not.toEqual(a);
    expect(a.length).toBeGreaterThan(80);
    expect(a.length).toBeLessThan(160);
    expect(run({ probability: 0 }, 50)).toEqual([]);
    expect(run({ probability: 1 }, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('the draw is consumed on every matching call, so one rule\'s decisions do not depend on another rule or on the times cap', () => {
    const uncapped = run({ probability: 0.5 }, 60, 'x');
    const capped = run({ probability: 0.5, times: 2 }, 60, 'x');
    expect(capped).toEqual(uncapped.slice(0, 2));
  });

  it('rules get independent generators: reordering rules does not change what a rule decides', () => {
    const plan = driverPlan({ at: 'observe', probability: 0.5, fault: { kind: 'hang' } }, { at: 'observe', probability: 0.5, fault: { kind: 'hang' } });
    const [c0, c1] = cursorsFor(plan);
    const seq = (c: NonNullable<typeof c0>): boolean[] => Array.from({ length: 30 }, () => decide({ probability: 0.5 }, c));
    const s0 = seq(c0 as NonNullable<typeof c0>);
    const s1 = seq(c1 as NonNullable<typeof c1>);
    expect(s0).not.toEqual(s1);
  });
});

describe('createRecorder and hang', () => {
  it('the default sleep does not wait but accounts for the delay; a custom sleep is used as given', async () => {
    const seen: string[] = [];
    const rec = createRecorder({ onEvent: (e) => seen.push(`${e.seq}:${e.at}`) });
    const t0 = Date.now();
    await rec.sleep(60_000);
    await rec.sleep(5);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(rec.virtualDelayMs()).toBe(60_005);
    rec.record({ at: 'observe', rule: 0, fault: 'latency' });
    rec.record({ at: 'perform', rule: 1, fault: 'hang' });
    expect(seen).toEqual(['1:observe', '2:perform']);
    expect(rec.events.map((e) => e.seq)).toEqual([1, 2]);

    const waits: number[] = [];
    const custom = createRecorder({ sleep: async (ms) => void waits.push(ms) });
    await custom.sleep(7);
    expect(waits).toEqual([7]);
    expect(custom.virtualDelayMs()).toBe(0);
  });

  it('hang() never settles', async () => {
    const outcome = await Promise.race([hang().then(() => 'settled'), new Promise<string>((r) => setTimeout(() => r('pending'), 30))]);
    expect(outcome).toBe('pending');
  });
});

describe('hang(keepAlive)', () => {
  const planUrl = new URL('../../src/chaos/plan.ts', import.meta.url).href;
  const run = (keepAlive: boolean): Promise<{ code: number | null; killed: boolean; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['--conditions=source', '--input-type=module', '-e', `import { hang } from ${JSON.stringify(planUrl)}; await hang(${keepAlive});`], {
        cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, 1500);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, killed, stderr });
      });
    });

  it('a plain hang holds no handle: the process ends by itself (Node\'s "unsettled top-level await" exit 13)', async () => {
    const r = await run(false);
    expect(r.killed).toBe(false);
    expect(r.code).toBe(13);
  });

  it('with keepAlive the process stays alive, like a stuck connection would keep it', async () => {
    const r = await run(true);
    expect(r.killed, r.stderr).toBe(true);
  });
});
