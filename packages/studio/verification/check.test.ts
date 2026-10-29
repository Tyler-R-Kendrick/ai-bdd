import { describe, expect, it } from 'vitest';
import {
  add,
  affineBounds,
  compare,
  format,
  multiply,
  rational,
} from './exact.ts';
import { check, verifyLayoutAllocation, verifyRolePolicy } from './check.ts';
import { studioLayout } from './layout.ts';

describe('exact shell allocation certificate', () => {
  it('normalizes rationals and bounds increasing and decreasing affine functions exactly', () => {
    expect(format(rational(-2, -6))).toBe('1/3');
    expect(format(add(rational(1, 3), rational(1, 6)))).toBe('1/2');
    expect(format(multiply(rational(-3, 7), rational(14, 9)))).toBe('-2/3');
    expect(compare(rational(1, 3), rational(333333, 1000000))).toBe(1);
    const decreasing = affineBounds(
      rational(-2),
      rational(5),
      rational(1, 3),
      rational(7, 3),
    );
    expect(format(decreasing.lower)).toBe('1/3');
    expect(format(decreasing.upper)).toBe('13/3');
    expect(() => rational(1, 0)).toThrow();
    expect(() =>
      affineBounds(rational(1), rational(0), rational(5), rational(2)),
    ).toThrow();
  });

  it('covers every exact layout region with and without the details panel', () => {
    const certificate = verifyLayoutAllocation();
    expect(certificate).toHaveLength(6);
    expect(
      certificate.every((row) => Number(row.canvasLowerBound) >= 320),
    ).toBe(true);
    expect(studioLayout(899.5)).toMatchObject({
      sidebarWidth: 0,
      detailWidth: 0,
      canvasWidth: 899.5,
    });
    expect(studioLayout(900)).toMatchObject({
      sidebarWidth: 232,
      detailWidth: 0,
      canvasWidth: 668,
    });
    expect(studioLayout(1280)).toMatchObject({
      sidebarWidth: 232,
      detailWidth: 340,
      canvasWidth: 708,
    });
    expect(studioLayout(1280, false)).toMatchObject({
      sidebarWidth: 232,
      detailWidth: 0,
      canvasWidth: 1048,
    });
    expect(() => studioLayout(Number.NaN)).toThrow();
  });

  it('evaluates the complete production permission predicate domain', () => {
    expect(verifyRolePolicy().exhaustiveCases).toBe(9);
  });

  it('does not label missing external proofs as verified and fails when one is required', async () => {
    expect((await check({})).externalProof).toMatchObject({
      verified: false,
      status: 'not-requested',
    });
    await expect(check({ STUDIO_REQUIRE_PROOF: '1' })).rejects.toThrow(
      'STUDIO_PROOF_VERIFIER',
    );
  });
});
