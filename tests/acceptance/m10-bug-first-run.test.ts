import { beforeAll, describe, expect, it } from 'vitest';
import { expectBugFirstRun, flowBugFirstRun, type BugFirstRun } from './helpers/flows.ts';
import { fakeTarget } from './helpers/targets.ts';

describe('M10 flag bug-upgrade-noop on a first run (fake driver)', () => {
  let res: BugFirstRun;
  beforeAll(async () => {
    res = await flowBugFirstRun(fakeTarget);
  });

  it('M10 R-CH1 R-JU2: the judge fails the first run, the scenario fails, the recording is discarded and no file is written', () => {
    expectBugFirstRun(res);
  });
});
