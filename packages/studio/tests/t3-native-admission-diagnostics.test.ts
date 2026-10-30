import { afterEach, describe, expect, it } from 'vitest';
import { NativeT3, type NativeT3GuardEvent } from '../server/integrations/t3-native.ts';
import { NativeT3Diagnostics, type NativeT3Event } from '../server/local/native-t3-diagnostics.ts';
import { nativeT3Fixture } from './t3-native-fixture.ts';
const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); });
const profile = { harness: 't3-code', provider: 'codex-fixture', model: 'fixture-model' } as const;
describe('finite native admission guard diagnostics', () => {
  it.each([
    ['caller ceiling', 'capabilities', 'caller-ceiling'],
    ['launch schema', 'launch-schema', 'launch-contract'],
    ['provider mode', 'provider-selection', 'provider-mode'],
    ['provider missing', 'provider-selection', 'provider-missing'],
    ['model missing', 'provider-selection', 'model-missing'],
    ['project missing', 'project-selection', 'project-missing'],
  ] as const)('keeps %s admission closed and reports only its finite guard category', async (testCase, stage, reason) => {
    const fixture = await nativeT3Fixture(); close.push(fixture.close);
    const events: NativeT3GuardEvent[] = [];
    let config = fixture.config, selected: { harness: 't3-code'; provider: string; model: string } = profile;
    if (testCase === 'caller ceiling') fixture.state.callerMode = 'full-access';
    if (testCase === 'launch schema') fixture.state.omitModeSchema = true;
    if (testCase === 'provider mode') fixture.state.providerModes = ['full-access'];
    if (testCase === 'provider missing') { selected = { ...profile, provider: 'other-provider' }; config = { ...config, providers: [{ ...config.providers[0]!, id: selected.provider }] }; }
    if (testCase === 'model missing') { selected = { ...profile, model: 'other-model' }; config = { ...config, providers: [{ ...config.providers[0]!, models: [selected.model] }] }; }
    if (testCase === 'project missing') fixture.state.workspaceRoot += '-other';
    await expect(NativeT3.connect(config, selected, AbortSignal.timeout(5000), event => { events.push(event); })).rejects.toMatchObject({ statusCode: 503 });
    expect(events).toContainEqual({ stage, state: 'failure', reason });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(config.mcp.accessToken);
    expect(serialized).not.toContain(config.project);
    expect(serialized).not.toContain(profile.model);
    expect(fixture.state.nativeWork).toEqual([]);
    expect(await fixture.cliStarted()).toBe(false);
  });
  it('preserves successful Supervised admission when synchronous or asynchronous guard observers fail', async () => {
    const fixture = await nativeT3Fixture(); close.push(fixture.close);
    for (const observer of [() => { throw new Error('synthetic log error'); }, async () => { throw new Error('synthetic rejected log'); }]) {
      const native = await NativeT3.connect(fixture.config, profile, AbortSignal.timeout(5000), observer);
      await native.close();
    }
    expect(fixture.state.nativeWork).toEqual([]);
    expect(await fixture.cliStarted()).toBe(false);
  });
  it('deduplicates repeated guard retries and projects no raw MCP response into the phase logger', () => {
    const events: NativeT3Event[] = [];
    const diagnostics = new NativeT3Diagnostics(event => { events.push(event); });
    const value = { stage: 'provider-selection', state: 'failure', reason: 'model-missing', rawResponse: 'synthetic-sensitive-token' } as const;
    diagnostics.guard(value); diagnostics.guard(value);
    expect(events).toEqual([{ phase: 't3-native-guard', state: 'failure', guardStage: 'provider-selection', guardReason: 'model-missing' }]);
    expect(JSON.stringify(events)).not.toContain(value.rawResponse);
  });
});
