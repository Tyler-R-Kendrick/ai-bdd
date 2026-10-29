import { describe, it, expect } from 'vitest';
import { inlineTestStatus } from '../client/editors/test-status.ts';
describe('Inline criterion evidence', () => {
  const run = {
    artifactVersion: 4,
    result: {
      scenarios: [
        {
          scenarioId: 'verified',
          title: 'Verified criterion',
          status: 'passed',
        },
        { scenarioId: 'broken', title: 'Broken criterion', status: 'failed' },
      ],
    },
  };
  it('never verifies an unlinked criterion from a passing aggregate run', () => {
    expect(inlineTestStatus(run, 4, '')).toMatchObject({
      status: 'Not linked',
      passed: false,
    });
    expect(inlineTestStatus(run, 4, 'unrelated')).toMatchObject({
      status: 'Not run',
      passed: false,
    });
  });
  it('uses only the linked scenario outcome at the same document revision', () => {
    expect(inlineTestStatus(run, 4, 'verified')).toMatchObject({
      status: 'passed',
      passed: true,
    });
    expect(inlineTestStatus(run, 4, 'broken')).toMatchObject({
      status: 'failed',
      passed: false,
    });
    expect(inlineTestStatus(run, 5, 'verified')).toMatchObject({
      status: 'Evidence out of date',
      passed: false,
    });
  });
  it('keeps criteria unverified when the latest run has no execution evidence', () => {
    expect(inlineTestStatus(undefined, 4, 'verified')).toMatchObject({
      status: 'Not run',
      passed: false,
    });
    expect(
      inlineTestStatus({ artifactVersion: 4, result: null }, 4, 'verified'),
    ).toMatchObject({ status: 'Not run', passed: false });
  });
});
