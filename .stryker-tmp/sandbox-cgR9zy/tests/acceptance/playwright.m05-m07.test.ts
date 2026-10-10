// @ts-nocheck
import { beforeAll, expect, it } from 'vitest';
import { statusSummary } from './helpers/engine.ts';
import { expectCharacterized, expectReplayed, expectTodos, flowTodos, flowUpgradeTwice, type TodosRuns, type UpgradeTwice } from './helpers/flows.ts';
import { describePlaywright } from './helpers/parity.ts';
import { fakeTarget, playwrightTarget } from './helpers/targets.ts';

describePlaywright('M5/M6/M7 [P] real Chromium against the Acme server, identical statuses to the fake driver', () => {
  let fake: UpgradeTwice;
  let pw: UpgradeTwice;
  let fakeTodos: TodosRuns;
  let pwTodos: TodosRuns;
  beforeAll(async () => {
    fake = await flowUpgradeTwice(fakeTarget);
    pw = await flowUpgradeTwice(playwrightTarget);
    fakeTodos = await flowTodos(fakeTarget);
    pwTodos = await flowTodos(playwrightTarget);
  }, 280_000);

  it('M5 [P] R-CH1 R-CH2 R-CH3 R-AS1: first run of Upgrade to Pro characterizes with Chromium, checks are discriminative, confirm run passes, recording created', () => {
    expectCharacterized(pw);
    expect(statusSummary(pw.first)).toEqual(statusSummary(fake.first));
    expect(pw.first.mode).toBe(fake.first.mode);
    expect(pw.recording?.driver.id).toBe('playwright');
  });

  it('M6 [P] R-CH2 R-RN: second run replays with Chromium and makes zero model calls', () => {
    expectReplayed(pw);
    expect(statusSummary(pw.second)).toEqual(statusSummary(fake.second));
  });

  it('M7 [P] R-CH3 R-AS2: volatile-content assertions stay fuzzy under Chromium, the add-todo action is deterministic, identical statuses', () => {
    expectTodos(pwTodos);
    for (const key of ['todo', 'sync'] as const) {
      expect(statusSummary(pwTodos.first[key])).toEqual(statusSummary(fakeTodos.first[key]));
      expect(statusSummary(pwTodos.second[key])).toEqual(statusSummary(fakeTodos.second[key]));
    }
  });
});
