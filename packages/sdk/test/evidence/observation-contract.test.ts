import { describe, expect, it } from 'vitest';
import { AiBddError, type Observation, type ObservedNode } from '../../src/contracts/index.ts';
import { createSettler } from '../../src/evidence/index.ts';
import { fakeClock, obs, scriptedSession } from './helpers.ts';

const OPTS = { quietMs: 300, intervalMs: 100, timeoutMs: 5000 };

const node = (over: Record<string, unknown> = {}): ObservedNode =>
  ({ ref: 'e1', role: 'button', name: 'Go', states: {}, depth: 0, ...over }) as unknown as ObservedNode;
const withNodes = (nodes: unknown, over: Record<string, unknown> = {}): Observation => ({ ...obs('A'), nodes, ...over }) as unknown as Observation;

async function settleError(observation: Observation): Promise<AiBddError> {
  try {
    await createSettler({ clock: fakeClock() }).settle(scriptedSession(() => observation), OPTS);
  } catch (err) {
    expect(err).toBeInstanceOf(AiBddError);
    return err as AiBddError;
  }
  throw new Error('expected the observation to be rejected');
}

describe('observations that break the driver contract are DRIVER_ERRORs naming the defect', () => {
  const CASES: [string, Observation, RegExp][] = [
    ['nodes is not an array', withNodes(undefined), /nodes is not an array/],
    ['a node is not an object', withNodes([null]), /nodes\[0\] is not an object/],
    ['a node has no ref', withNodes([node({ ref: undefined })]), /nodes\[0\]\.ref is not a string/],
    ['a node has no role', withNodes([node(), node({ ref: 'e2', role: null })]), /nodes\[1\]\.role is not a string/],
    ['a node name is a number', withNodes([node({ name: 42 })]), /nodes\[0\]\.name is not a string/],
    ['a node depth is not a number', withNodes([node({ depth: 'deep' })]), /nodes\[0\]\.depth is not a number/],
    ['a node depth is NaN', withNodes([node({ depth: Number.NaN })]), /nodes\[0\]\.depth is not a number/],
    ['a node has no states', withNodes([node({ states: null })]), /nodes\[0\]\.states is not an object/],
    ['two nodes share a ref', withNodes([node(), node({ role: 'link' })]), /nodes\[1\]\.ref "e1" duplicates an earlier node/],
    ['route is missing', withNodes([], { route: undefined }), /route is not a string/],
    ['treeHash is missing', withNodes([], { treeHash: undefined }), /treeHash is not a string/],
    ['treeText is missing', withNodes([], { treeText: 7 }), /treeText is not a string/],
    ['busy is not a boolean', withNodes([], { busy: 'no' }), /busy is not a boolean/],
  ];
  for (const [name, observation, message] of CASES) {
    it(`${name}`, async () => {
      const err = await settleError(observation);
      expect(err.code).toBe('DRIVER_ERROR');
      expect(err.retryable, 'a malformed answer is not going to be fine next time').toBe(false);
      expect(err.message).toMatch(/^the driver returned a malformed observation: /);
      expect(err.message).toMatch(message);
      expect(err.message).not.toMatch(/Cannot read|is not a function/);
    });
  }

  it('the observation itself not being an object is reported too', async () => {
    const err = await settleError(null as unknown as Observation);
    expect(err.message).toContain('it is not an object');
  });

  it('a well-formed observation (empty tree included) is passed through untouched', async () => {
    const good = withNodes([node(), node({ ref: 'e2', role: 'link', name: 'Home', depth: 1, parentRef: 'e1', states: { disabled: true } })]);
    const r = await createSettler({ clock: fakeClock() }).settle(scriptedSession(() => good), OPTS);
    expect(r.settled).toBe(true);
    expect(r.observation).toBe(good);
    const empty = await createSettler({ clock: fakeClock() }).settle(scriptedSession(() => withNodes([])), OPTS);
    expect(empty.settled).toBe(true);
  });

  it('every entry into the engine is checked: the pixel observation and the one taken after a timeout as well', async () => {
    // settles on A, then the pixel observation comes back malformed
    const session = scriptedSession((_, pixels) => (pixels ? withNodes([node({ name: 1 })]) : withNodes([node()])));
    const err = await createSettler({ clock: fakeClock() }).settle(session, OPTS, { pixels: true }).then(() => undefined, (e: unknown) => e as AiBddError);
    expect(err?.code).toBe('DRIVER_ERROR');
    expect(err?.message).toContain('nodes[0].name is not a string');

    // never settles (always busy), then the final pixel observation is malformed
    const busy = scriptedSession((_, pixels) => (pixels ? withNodes([], { busy: 'x' }) : withNodes([], { busy: true })));
    const late = await createSettler({ clock: fakeClock() }).settle(busy, { quietMs: 300, intervalMs: 100, timeoutMs: 300 }, { pixels: true }).then(() => undefined, (e: unknown) => e as AiBddError);
    expect(late?.message).toContain('busy is not a boolean');
  });
});
