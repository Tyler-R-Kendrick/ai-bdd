// @ts-nocheck
import { runDriverConformance } from '../../sdk/test/kit/driver-conformance.ts';
import { cua } from '../src/index.ts';
import { PAGE, ScriptedClient, WINDOW, okResult, snapshot } from './scripted.ts';

/**
 * The shared driver conformance kit, identity / capability / navigation-policy part (the kit's app-dependent cases are written
 * for the Playwright-style `route` and URL semantics, which the accessibility tree does not have; the Cua Driver is exercised
 * end to end in real.test.ts and in tests/acceptance/cua.m05-m07.test.ts).
 */
runDriverConformance('cua', () => cua({
  kind: 'browser',
  window: { title: 'Probe' },
  startTimeoutMs: 500,
  settleMs: 0,
  connect: async () => new ScriptedClient((tool) => (tool === 'list_windows' ? okResult({ windows: [WINDOW] }) : tool === 'get_window_state' ? snapshot(PAGE) : tool === 'health_report' ? okResult({ overall: 'ok', checks: [] }) : undefined)),
}));
