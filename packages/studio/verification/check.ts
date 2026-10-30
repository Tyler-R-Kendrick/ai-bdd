import { proveHandwiredLayout } from './handwired.ts';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { capability, type Role } from '../shared/domain.ts';
import { affineBounds, compare, format, rational } from './exact.ts';
import { layoutRegions, STUDIO_LAYOUT, studioLayout } from './layout.ts';
import { requireExternalProof } from './proof.ts';

export function verifyLayoutAllocation() {
  const certificates: {
    detailOpen: boolean;
    lower: number;
    upper: number;
    canvasLowerBound: string;
    includeUpper: boolean;
  }[] = [];
  for (const detailOpen of [false, true]) {
    const regions = layoutRegions(detailOpen);
    assert.equal(regions[0].lower, STUDIO_LAYOUT.minViewport);
    assert.equal(
      regions[regions.length - 1]!.upper,
      STUDIO_LAYOUT.maxViewport,
    );
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i]!;
      if (i > 0) {
        assert.equal(
          regions[i - 1]!.upper,
          region.lower,
          'Domains must cover the entire interval without a gap',
        );
        assert.equal(
          regions[i - 1]!.includeUpper,
          false,
          'Adjacent domains may not overlap',
        );
      }
      assert(region.lower < region.upper);
      assert(region.sidebar >= 0 && region.details >= 0);
      const canvas = affineBounds(
        rational(1),
        rational(-region.sidebar - region.details),
        rational(region.lower),
        rational(region.upper),
      );
      assert(
        compare(canvas.lower, rational(STUDIO_LAYOUT.minCanvasWidth)) >= 0,
        'Canvas width must stay above the supported minimum',
      );
      // Left=[0,S], canvas=[S,w-D], details=[w-D,w]. Equality of endpoints
      // plus nonnegative widths proves pairwise non-overlap for every real w.
      const total = affineBounds(
        rational(1),
        rational(0),
        rational(region.lower),
        rational(region.upper),
      );
      assert(
        compare(total.lower, rational(region.sidebar + region.details)) >= 0,
      );
      const boundary = studioLayout(region.lower, detailOpen);
      assert.equal(boundary.sidebarWidth, region.sidebar);
      assert.equal(boundary.detailWidth, region.details);
      certificates.push({
        detailOpen,
        lower: region.lower,
        upper: region.upper,
        includeUpper: region.includeUpper,
        canvasLowerBound: format(canvas.lower),
      });
    }
  }
  return certificates;
}

export function verifyRolePolicy() {
  const roles: Role[] = ['owner', 'editor', 'viewer'];
  const actions = ['read', 'write', 'admin'] as const;
  const expected = {
    owner: [true, true, true],
    editor: [true, true, false],
    viewer: [true, false, false],
  };
  let cases = 0;
  for (const role of roles)
    for (const [index, action] of actions.entries()) {
      assert.equal(
        capability(role, action),
        expected[role][index],
        `${role}/${action}`,
      );
      cases++;
    }
  return { exhaustiveCases: cases, roles, actions };
}

export async function check(env: NodeJS.ProcessEnv = process.env) {
  const report = {
    schemaVersion: 1,
    scope:
      'Exact rational proof of shell column allocation on real viewport widths 320–4096, and exhaustive evaluation of the production role predicate. No browser text metrics or whole-system proof.',
    layout: verifyLayoutAllocation(),
    permissions: verifyRolePolicy(),
    compiledLayout: await proveHandwiredLayout(),
    externalProof:
      env.STUDIO_REQUIRE_PROOF === '1'
        ? await requireExternalProof(env)
        : {
            verified: false,
            status: 'not-requested',
            reason:
              'The optional Magnetar research gate requires an explicitly configured real verifier.',
          },
  };
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  check()
    .then((report) =>
      process.stdout.write(JSON.stringify(report, null, 2) + '\n'),
    )
    .catch((error) => {
      process.stderr.write(
        `Verification failed: ${(error as Error).message}\n`,
      );
      process.exitCode = 1;
    });
}
