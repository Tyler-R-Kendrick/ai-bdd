import type { Action, DriverFactory, DriverSession, Observation, Selector, Verb } from '@ai-bdd/contracts';
import { describe, expect, it } from 'vitest';

export interface DriverConformanceOptions {
  /** Base URL of the fixture app, when the driver can reach it. */
  appUrl?: string;
  /** Skip pixel assertions for tree-only drivers. */
  treeOnly?: boolean;
  /** A navigation action the driver accepts, e.g. `{ verb: 'navigate', value: '/settings/billing' }`. */
  navigate: Action;
  /** A selector that exists on the fixture app after `navigate`. */
  knownSelector: Selector;
  /** A secret name the driver can fill, when it supports `typeSecret`. */
  secretName?: string;
  /** The field a secret is typed into. Defaults to `knownSelector`. */
  secretSelector?: Selector;
  /** The screen that owns the secret field, when it is not the known screen. */
  secretNavigate?: Action;
}

/**
 * The driver conformance suite (WP-I1a). Runs against any `DriverFactory` and
 * checks the semantics every driver must share: observe/perform/settle/close,
 * ref invalidation, policy enforcement, taint after a secret fill, and honest
 * concurrency declarations.
 */
export function runDriverConformance(factory: DriverFactory, options: DriverConformanceOptions): void {
  describe(`driver conformance: ${factory.id}`, () => {
    async function open(): Promise<DriverSession> {
      const driver = await factory.create({ sessionId: 'conf', scenarioId: 'conformance', config: {} });
      return driver.openSession({
        sessionId: `conf-${Math.random().toString(36).slice(2)}`,
        scenarioId: 'conformance',
        config: {},
        ...(options.appUrl ? { target: { url: options.appUrl } } : {}),
      });
    }

    it('declares a usable capability set and a concurrency declaration', async () => {
      const driver = await factory.create({ sessionId: 'conf', scenarioId: 'conformance', config: {} });
      expect(driver.capabilities.verbs.length).toBeGreaterThan(0);
      expect(driver.concurrency.maxSessions).toBeGreaterThanOrEqual(1);
      if (driver.capabilities.verbs.includes('typeSecret')) {
        expect(typeof driver.capabilities.maskingProven).toBe('boolean');
      }
    });

    it('selfCheck reports problems instead of throwing', async () => {
      const driver = await factory.create({ sessionId: 'conf', scenarioId: 'conformance', config: {} });
      const result = await driver.selfCheck();
      expect(typeof result.ok).toBe('boolean');
      expect(Array.isArray(result.problems)).toBe(true);
      if (!result.ok) expect(result.problems.length).toBeGreaterThan(0);
    });

    it('observes a tree with refs, a revision and a hash', async () => {
      const session = await open();
      try {
        await session.perform(options.navigate);
        const observation = await session.observe();
        expect(observation.revision).toBeGreaterThanOrEqual(0);
        expect(observation.treeHash.length).toBeGreaterThan(0);
        expect(observation.nodes.length).toBeGreaterThan(0);
        expect(observation.capturedAt).toMatch(/\d{4}-\d{2}-\d{2}T/u);
      } finally {
        await session.close();
      }
    });

    it('invalidates refs after a new observation (F-E3)', async () => {
      const session = await open();
      try {
        await session.perform(options.navigate);
        const first = await session.observe();
        const second = await session.observe();
        expect(second.revision).toBeGreaterThan(first.revision);
        const firstRefs = new Set(flatten(first));
        const secondRefs = new Set(flatten(second));
        expect([...firstRefs].filter((ref) => secondRefs.has(ref))).toEqual([]);
      } finally {
        await session.close();
      }
    });

    it('performs a known action and reports a result', async () => {
      const session = await open();
      try {
        await session.perform(options.navigate);
        const result = await session.perform({ verb: 'tap', selector: options.knownSelector });
        expect(result.verb).toBe('tap');
        expect(typeof result.ok).toBe('boolean');
      } finally {
        await session.close();
      }
    });

    it('rejects a verb it does not declare', async () => {
      const driver = await factory.create({ sessionId: 'conf-probe', scenarioId: 'conformance', config: {} });
      const session = await open();
      const undeclared = (['navigate', 'tap', 'type', 'scroll', 'drag'] as Verb[]).find(
        (verb) => !driver.capabilities.verbs.includes(verb),
      );
      try {
        if (undeclared) {
          const result = await session.perform({ verb: undeclared });
          expect(result.ok).toBe(false);
        } else {
          expect(driver.capabilities.verbs.length).toBeGreaterThanOrEqual(5);
        }
      } finally {
        await session.close();
      }
    });

    it('taints observations after a secret fill and withholds pixels', async () => {
      const driver = await factory.create({ sessionId: 'conf', scenarioId: 'conformance', config: {} });
      if (!driver.capabilities.verbs.includes('typeSecret') || !options.secretName) return;
      const session = await open();
      try {
        await session.perform(options.secretNavigate ?? options.navigate);
        const fill = await session.perform({
          verb: 'typeSecret',
          secretName: options.secretName,
          selector: options.secretSelector ?? options.knownSelector,
        });
        expect(fill.ok).toBe(true);
        const observation = await session.observe({ pixels: true });
        expect(observation.tainted).toBe(true);
        if (!observation.maskingProven) expect(observation.screenshot).toBeUndefined();
      } finally {
        await session.close();
      }
    });

    it('closes cleanly and refuses work afterwards', async () => {
      const session = await open();
      await session.close();
      await expect(session.observe()).rejects.toBeTruthy();
    });
  });
}

export function flatten(observation: Observation): string[] {
  const out: string[] = [];
  const visit = (nodes: Observation['nodes']): void => {
    for (const node of nodes) {
      out.push(node.ref);
      if (node.children) visit(node.children);
    }
  };
  visit(observation.nodes);
  return out;
}
