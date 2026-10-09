import { describe, expect, it } from 'vitest';
import type { ChatModel, CheckProgram, GenerateResult, JsonValue, JudgeConfig, JudgeRequest, JudgeVerdict, Observation } from '@ai-bdd/contracts';
import { createAsserter, evaluatePredicates, lintCheckProgram, matchesSelector } from '../../src/index.js';

function obs(nodes: Array<{ role: string; name: string; testId?: string }>, route = '/settings/billing'): Observation {
  return {
    revision: 1,
    nodes: nodes.map((node, index) => ({
      ref: `r${index}`,
      role: node.role,
      name: node.name,
      ...(node.testId ? { testId: node.testId } : {}),
      ...(node.role === 'text' || node.role === 'heading' || node.role === 'alert' ? { text: node.name } : {}),
    })),
    treeHash: `t-${nodes.map((node) => node.name).join('|')}`,
    route,
    tainted: false,
    maskingProven: true,
    settled: true,
    capturedAt: '2026-10-09T00:00:00.000Z',
  };
}

const before = obs([{ role: 'heading', name: 'Billing settings' }, { role: 'text', name: 'Plan: Free plan' }]);
const after = obs([{ role: 'heading', name: 'Billing settings' }, { role: 'text', name: 'Plan: Pro plan' }]);

const judgeConfig: JudgeConfig = { passThreshold: 0.8, failThreshold: 0.3, samples: 1, maxSpread: 0.5, vision: true, maxTreeChars: 20000 };

function checkgenModel(object: JsonValue): ChatModel {
  return {
    id: 'test:checkgen',
    async generate(): Promise<GenerateResult> {
      return { object, usage: { inputTokens: 1, outputTokens: 1 }, modelId: 'test:checkgen' };
    },
  };
}

function judgeStub(score: number, verdict: JudgeVerdict['verdict']): { judge(request: JudgeRequest): Promise<JudgeVerdict> } {
  return {
    async judge(): Promise<JudgeVerdict> {
      return { score, verdict, samples: [], spread: 0, modelId: 'test:judge', promptVersion: 'judge-1', cacheKey: 'k', reused: false };
    },
  };
}

function cacheHolding(program: CheckProgram | null, saved: CheckProgram[] = []) {
  return {
    saved,
    async getCheck() {
      return program ? { program, invalidation: [{ strategy: 'effect-verify', result: 'valid' }] } : null;
    },
    async putCheck(next: CheckProgram) {
      saved.push(next);
    },
  };
}

const checker = (program: JsonValue, score = 0.9, verdict: JudgeVerdict['verdict'] = 'pass', config: Partial<{ mode: 'auto' | 'check' | 'judge' | 'both'; requireDeterministic: boolean }> = {}) =>
  createAsserter({
    model: checkgenModel(program),
    judge: judgeStub(score, verdict),
    cache: cacheHolding(null) as never,
    config: { mode: config.mode ?? 'auto', requireDeterministic: config.requireDeterministic ?? false, checkGen: { maxAttempts: 3 } },
    driver: { id: 'fake', major: 1, nativePredicates: false },
  });

const window = { before, after, actionPreceded: true, beforeTree: 'Plan: Free plan', afterTree: 'Plan: Pro plan', key: 'k' };

describe('predicate evaluator', () => {
  const cases: Array<[string, Parameters<typeof evaluatePredicates>[0][number], string]> = [
    ['exists satisfied', { kind: 'exists', selector: { role: 'heading' } }, 'satisfied'],
    ['exists unsatisfied', { kind: 'exists', selector: { role: 'button', name: 'Nope' } }, 'unsatisfied'],
    ['notExists satisfied', { kind: 'notExists', selector: { role: 'button' } }, 'satisfied'],
    ['textEquals', { kind: 'textEquals', selector: { role: 'text' }, value: 'Plan: Pro plan' }, 'satisfied'],
    ['textEquals wrong', { kind: 'textEquals', selector: { role: 'text' }, value: 'Plan: Free plan' }, 'unsatisfied'],
    ['textContains', { kind: 'textContains', selector: { role: 'text' }, value: 'Pro plan' }, 'satisfied'],
    ['textMatches', { kind: 'textMatches', selector: { role: 'text' }, regex: 'Plan: (Free|Pro) plan' }, 'satisfied'],
    ['routeMatches', { kind: 'routeMatches', regex: '/settings/billing' }, 'satisfied'],
    ['routeMatches miss', { kind: 'routeMatches', regex: '/elsewhere' }, 'unsatisfied'],
    ['count', { kind: 'count', selector: { role: 'text' }, value: 1 }, 'satisfied'],
    ['count wrong', { kind: 'count', selector: { role: 'text' }, value: 2 }, 'unsatisfied'],
    ['driverNative is unknown', { kind: 'driverNative', tool: 'verify_state', args: {} }, 'unknown'],
  ];

  for (const [name, predicate, expected] of cases) {
    it(`${name} => ${expected}`, () => {
      expect(evaluatePredicates([predicate], after)[0]?.result).toBe(expected);
    });
  }

  it('passes a textEquals param value through', () => {
    const result = evaluatePredicates([{ kind: 'textEquals', selector: { role: 'text' }, value: 'plan', fromParam: 'plan' }], after, { plan: 'Plan: Pro plan' });
    expect(result[0]?.result).toBe('satisfied');
  });

  it('matches a selector without a name on any node of that role', () => {
    expect(matchesSelector({ ref: 'r', role: 'text', name: 'anything' }, { role: 'text' })).toBe(true);
    expect(matchesSelector({ ref: 'r', role: 'text', name: 'anything' }, { role: 'button' })).toBe(false);
  });
});

describe('check program linter (R-K10)', () => {
  const base = { version: 1 as const, key: 'k', text: 'criterion', driver: 'fake', driverMajor: 1, classification: 'change' as const };

  it('rejects volatile literals', () => {
    const problems = lintCheckProgram({ ...base, predicates: [{ kind: 'textEquals', selector: { role: 'text' }, value: 'Server time: 2026-10-09T00:00:00.000Z' }] });
    expect(problems.join(' ')).toMatch(/volatile/u);
  });

  it('rejects a long number and a duration', () => {
    expect(lintCheckProgram({ ...base, predicates: [{ kind: 'textContains', selector: { role: 'text' }, value: 'order 12345' }] }).length).toBeGreaterThan(0);
    expect(lintCheckProgram({ ...base, predicates: [{ kind: 'textContains', selector: { role: 'text' }, value: 'waited 300ms' }] }).length).toBeGreaterThan(0);
  });

  it('allows a literal that comes from a step parameter', () => {
    const problems = lintCheckProgram({ ...base, predicates: [{ kind: 'textEquals', selector: { role: 'text' }, value: '2026-10-09' }] }, { when: '2026-10-09' });
    expect(problems).toEqual([]);
  });

  it('allows fromParam predicates', () => {
    expect(lintCheckProgram({ ...base, predicates: [{ kind: 'textEquals', selector: { role: 'text' }, value: '12345', fromParam: 'plan' }] })).toEqual([]);
  });

  it('rejects an empty predicate list', () => {
    expect(lintCheckProgram({ ...base, predicates: [] })).toContain('the check program has no predicates');
  });
});

describe('assertion engine (R-K9)', () => {
  const discriminative = {
    classification: 'change',
    predicates: [{ kind: 'textContains', selector: { role: 'text' }, value: 'Pro plan' }],
  };

  it('accepts a discriminative program and passes', async () => {
    const outcome = await checker(discriminative).assert({ id: 's', text: 'The plan badge reads "Pro"', options: {} }, window);
    expect(outcome.status).toBe('passed');
    expect(outcome.check?.generated).toBe(true);
    expect(outcome.judge?.verdict).toBe('pass');
  });

  it('rejects a non-discriminative program and falls back to judge-only', async () => {
    const nonDiscriminative = { classification: 'change', predicates: [{ kind: 'exists', selector: { role: 'heading' } }] };
    const outcome = await checker(nonDiscriminative).assert({ id: 's', text: 'A heading is visible', options: {} }, window);
    expect(outcome.status).toBe('passed');
    expect(outcome.check?.judgeOnly).toBe(true);
  });

  it('fails with CHECK_GENERATION_FAILED when requireDeterministic is set', async () => {
    const nonDiscriminative = { classification: 'change', predicates: [{ kind: 'exists', selector: { role: 'heading' } }] };
    const outcome = await checker(nonDiscriminative, 0.9, 'pass', { requireDeterministic: true }).assert({ id: 's', text: 'A heading is visible', options: {} }, window);
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('CHECK_GENERATION_FAILED');
  });

  it('accepts an invariant program when it holds on after', async () => {
    const invariant = { classification: 'invariant', predicates: [{ kind: 'notExists', selector: { role: 'alert', name: 'Something went wrong' } }] };
    const outcome = await checker(invariant).assert({ id: 's', text: 'No error toast is visible', options: {} }, window);
    expect(outcome.status).toBe('passed');
    expect(outcome.check?.invariant).toBe(true);
  });

  it('fails with CHECK_GENERATION_FAILED when no discriminative check can be generated in mode=check', async () => {
    const failing = { classification: 'change', predicates: [{ kind: 'textContains', selector: { role: 'text' }, value: 'Enterprise plan' }] };
    const outcome = await checker(failing, 0.9, 'pass', { mode: 'check' }).assert({ id: 's', text: 'The plan badge reads "Enterprise"', options: {} }, window);
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('CHECK_GENERATION_FAILED');
  });

  it('fails with JUDGE_INCONCLUSIVE when the judge is in the band', async () => {
    const outcome = await checker(discriminative, 0.5, 'inconclusive').assert({ id: 's', text: 'The plan badge reads "Pro"', options: {} }, window);
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('JUDGE_INCONCLUSIVE');
  });

  it('runs judge only in mode=judge', async () => {
    const outcome = await checker(discriminative, 0.95, 'pass', { mode: 'judge' }).assert({ id: 's', text: 'Criterion', options: { mode: 'judge' } }, window);
    expect(outcome.status).toBe('passed');
    expect(outcome.check?.judgeOnly).toBe(true);
    expect(outcome.judge?.verdict).toBe('pass');
  });

  it('does not judge when the mode is check only', async () => {
    const outcome = await checker(discriminative, 0.95, 'pass', { mode: 'check' }).assert({ id: 's', text: 'Criterion', options: { mode: 'check' } }, window);
    expect(outcome.judge).toBeUndefined();
    expect(outcome.status).toBe('passed');
  });

  it('falls back to judge-only in mode=both when no discriminative check can be generated', async () => {
    const failing = { classification: 'change', predicates: [{ kind: 'textContains', selector: { role: 'text' }, value: 'Enterprise' }] };
    const outcome = await checker(failing, 0.95, 'pass', { mode: 'both' }).assert({ id: 's', text: 'c', options: {} }, window);
    expect(outcome.status).toBe('passed');
    expect(outcome.check?.judgeOnly).toBe(true);
  });

  it('does not write a program that was already cached', async () => {
    const program: CheckProgram = { version: 1, key: 'k', text: 'c', driver: 'fake', driverMajor: 1, predicates: [{ kind: 'textContains', selector: { role: 'text' }, value: 'Pro plan' }], classification: 'change' };
    const cache = cacheHolding(program);
    const asserter = createAsserter({
      model: checkgenModel(discriminative),
      judge: judgeStub(0.9, 'pass'),
      cache: cache as never,
      config: { mode: 'auto', requireDeterministic: false, checkGen: { maxAttempts: 3 } },
      driver: { id: 'fake', major: 1, nativePredicates: false },
    });
    await asserter.assert({ id: 's', text: 'c', options: {} }, window);
    await asserter.pending();
    expect(cache.saved).toHaveLength(0);
  });

  it('defers a generated program until pending() is called', async () => {
    const cache = cacheHolding(null);
    const asserter = createAsserter({
      model: checkgenModel(discriminative),
      judge: judgeStub(0.9, 'pass'),
      cache: cache as never,
      config: { mode: 'auto', requireDeterministic: false, checkGen: { maxAttempts: 3 } },
      driver: { id: 'fake', major: 1, nativePredicates: false },
    });
    await asserter.assert({ id: 's', text: 'c', options: {} }, window);
    expect(cache.saved).toHaveLength(0);
    await asserter.pending();
    expect(cache.saved).toHaveLength(1);
    expect(cache.saved[0]?.verified).toBe(true);
  });
});
