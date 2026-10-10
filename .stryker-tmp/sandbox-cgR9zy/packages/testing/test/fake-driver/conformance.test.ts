// @ts-nocheck
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fakeDriver } from '../../src/fake-driver/index.ts';

/**
 * SPEC 11.2: the shared driver conformance kit is owned by S-RUNNER and may not exist yet while this
 * swarm works. When it is present it runs against the fake driver; the local equivalents of every kit
 * check live in driver.test.ts (observe shape, stale refs, navigation policy, taint, busy, isolation, request).
 */
const kitPath = fileURLToPath(new URL('../../../sdk/test/kit/driver-conformance.ts', import.meta.url));
const kitExists = existsSync(kitPath);

if (kitExists) {
  const kit = (await import(/* @vite-ignore */ kitPath)) as { runDriverConformance: (name: string, make: () => ReturnType<typeof fakeDriver>, opts?: { appUrl?: string }) => void };
  kit.runDriverConformance('fake driver', () => fakeDriver(), { appUrl: 'http://localhost:4173' });
}

describe('driver conformance kit wiring', () => {
  it.skipIf(kitExists)('packages/sdk/test/kit/driver-conformance.ts is not present yet; local equivalents cover SPEC 11.2', () => {
    expect(kitExists).toBe(false);
  });
  it.skipIf(!kitExists)('runs the shared kit against the fake driver', () => {
    expect(kitExists).toBe(true);
  });
});
