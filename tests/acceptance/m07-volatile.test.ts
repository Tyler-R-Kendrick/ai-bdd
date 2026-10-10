import { beforeAll, describe, expect, it } from 'vitest';
import { expectTodos, flowTodos, type TodosRuns } from './helpers/flows.ts';
import { fakeTarget } from './helpers/targets.ts';

describe('M7 todos: volatile content stays fuzzy (fake driver)', () => {
  let res: TodosRuns;
  beforeAll(async () => {
    res = await flowTodos(fakeTarget);
  });

  it('M7 R-CH3 R-AS2 R-CH2: the add-todo action is deterministic, the added-time and sync assertions are fuzzy (volatile-content) and later runs call the judge only for those steps', () => {
    expectTodos(res);
  });

  it('M7 R-PL2: frontmatter directives (tags) reach the scenarios of todos.md', () => {
    expect(res.tags).toContain('todos');
  });
});
