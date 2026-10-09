/**
 * @ai-bdd/driver-fake — an in-memory driver over the fixture app model.
 *
 * The model (fixtures/app/model.json) is generated from the same screen
 * definitions the fixture web app renders from, so the fake driver and the real
 * app describe identical UIs. Screenshots are deterministic PNGs.
 */
export { fakeDriver, fakeDriver as fake, FakeSession, matchesSelector } from './session.js';
export type { FakeDriverOptions, FakeFaultOptions } from './session.js';
export { loadFakeModel, renderPng } from './model.js';
export type { FakeModel, FakeNode, FakeScreen, FakeState, FakeTransition } from './model.js';
