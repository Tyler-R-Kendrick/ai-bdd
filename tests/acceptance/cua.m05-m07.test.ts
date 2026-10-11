import { beforeAll, expect, it } from 'vitest';
import { statusSummary } from './helpers/engine.ts';
import { expectCharacterized, expectReplayed, expectTodos, flowTodos, flowUpgradeTwice, type TodosRuns, type UpgradeTwice } from './helpers/flows.ts';
import { describeCua } from './helpers/parity.ts';
import { cuaTarget, fakeTarget } from './helpers/targets.ts';

describeCua('M5/M6/M7 [C] the real Cua Driver operating Chromium on a desktop, identical statuses to the fake driver', () => {
  let fake: UpgradeTwice;
  let cua: UpgradeTwice;
  let fakeTodos: TodosRuns;
  let cuaTodos: TodosRuns;
  beforeAll(async () => {
    fake = await flowUpgradeTwice(fakeTarget);
    cua = await flowUpgradeTwice(cuaTarget);
    fakeTodos = await flowTodos(fakeTarget);
    cuaTodos = await flowTodos(cuaTarget);
  }, 600_000);

  it('M5 [C]: first run of Upgrade to Pro characterizes through Cua Driver, checks are discriminative, confirm run passes, recording created', () => {
    expectCharacterized(cua);
    expect(statusSummary(cua.first)).toEqual(statusSummary(fake.first));
    expect(cua.first.mode).toBe(fake.first.mode);
    expect(cua.recording?.driver.id).toBe('cua');
  });

  it('M6 [C]: second run replays through Cua Driver and makes zero model calls', () => {
    expectReplayed(cua);
    expect(statusSummary(cua.second)).toEqual(statusSummary(fake.second));
  });

  it('M7 [C]: volatile-content assertions stay fuzzy, the add-todo action is deterministic, identical statuses', () => {
    expectTodos(cuaTodos);
    for (const key of ['todo', 'sync'] as const) {
      expect(statusSummary(cuaTodos.first[key])).toEqual(statusSummary(fakeTodos.first[key]));
      expect(statusSummary(cuaTodos.second[key])).toEqual(statusSummary(fakeTodos.second[key]));
    }
  });
});
