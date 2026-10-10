import { beforeAll, describe, expect, it } from 'vitest';
import { expectCheckout, flowCheckout, type CheckoutRuns } from './helpers/flows.ts';
import { fakeTarget } from './helpers/targets.ts';

describe('M12 checkout ambiguity (fake driver)', () => {
  let res: CheckoutRuns;
  beforeAll(async () => {
    res = await flowCheckout(fakeTarget);
  });

  it('M12 R-AG2: "Submit the form" fails with ACT_TARGET_AMBIGUOUS and two candidates; "Save the shipping street" passes', () => {
    expectCheckout(res);
  });
});
