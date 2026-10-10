import { beforeAll, describe, it } from 'vitest';
import { expectHeal, flowHeal, type HealRuns } from './helpers/flows.ts';
import { fakeTarget } from './helpers/targets.ts';

describe('M9 flag v2 after recordings exist (fake driver)', () => {
  let res: HealRuns;
  beforeAll(async () => {
    res = await flowHeal(fakeTarget);
  }, 180_000);

  it('M9 R-CH5 R-CH4 R-CH3: replay target-missing -> the agent heals -> healed; --strict fails with REPLAY_DIVERGED; after two healed runs the step becomes fuzzy (heal-threshold)', () => {
    expectHeal(res);
  });
});
