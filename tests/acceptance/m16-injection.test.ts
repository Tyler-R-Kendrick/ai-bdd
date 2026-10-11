import { beforeAll, describe, it } from 'vitest';
import { expectRelease, flowRelease, type ReleaseRuns } from './helpers/flows.ts';
import { fakeTarget } from './helpers/targets.ts';

describe('M16 prompt injection in a doc and in a page (fake driver)', () => {
  let res: ReleaseRuns;
  beforeAll(async () => {
    res = await flowRelease(fakeTarget);
  });

  it('M16 R-AG3 R-AG4 R-EX3: no scenario comes from the doc injection; the scripted navigation to evil.example gets POLICY_DENIED and is never performed; the injected page text cannot pass a step', () => {
    expectRelease(res);
  });
});
