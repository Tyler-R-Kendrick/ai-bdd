import { afterEach, describe, expect, it } from 'vitest';
import { generateText } from 'ai';
import { t3LanguageModel } from '../server/integrations/t3-model.ts';
import { nativeT3Fixture } from './t3-native-fixture.ts';
const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});
async function fixture() {
  const x = await nativeT3Fixture();
  closing.push(x.close);
  return x;
}
const profile = {
  harness: 't3-code',
  provider: 'codex-fixture',
  model: 'fixture-model',
} as const;
const invoke = (
  x: Awaited<ReturnType<typeof fixture>>,
  key = 'native-permission-request',
) =>
  generateText({
    model: t3LanguageModel(x.config, profile, key),
    prompt: 'Explain the source.',
    maxRetries: 0,
  });
describe('native T3 permission admission before work', () => {
  it('atomically launches Supervised despite Full Access project defaults and never starts the full-access CLI', async () => {
    const x = await fixture();
    expect((await invoke(x)).text).toBe('T3 native MCP model result.');
    expect(x.state.nativeWork).toEqual(['approval-required']);
    expect(
      x.calls.find((c) => c.name === 't3_thread_launch')?.arguments,
    ).toMatchObject({
      projectId: 'project-fixture',
      modelSelection: { instanceId: profile.provider, model: profile.model },
      runtimeMode: 'approval-required',
      clientRequestId: expect.any(String),
    });
    expect(await x.cliStarted()).toBe(false);
  });
  it.each(['full-access', 'auto', 'read-only', 'unknown'])(
    'rejects unproven caller ceiling %s before native work',
    async (mode) => {
      const x = await fixture();
      x.state.callerMode = mode;
      await expect(invoke(x)).rejects.toMatchObject({ statusCode: 503 });
      expect(x.state.nativeWork).toEqual([]);
      expect(await x.cliStarted()).toBe(false);
    },
  );
  it('rejects missing explicit-mode schema, unsupported native provider mode and wrong project roots before launch', async () => {
    for (const mutate of [
      (x: Awaited<ReturnType<typeof fixture>>) => {
        x.state.omitModeSchema = true;
      },
      (x: Awaited<ReturnType<typeof fixture>>) => {
        x.state.providerModes = ['full-access'];
      },
      (x: Awaited<ReturnType<typeof fixture>>) => {
        x.state.workspaceRoot += '-other';
      },
    ]) {
      const x = await fixture();
      mutate(x);
      await expect(invoke(x)).rejects.toMatchObject({ statusCode: 503 });
      expect(x.state.nativeWork).toEqual([]);
      expect(await x.cliStarted()).toBe(false);
    }
  });
  it.each([
    { runtimeMode: 'full-access' },
    { runtimeMode: undefined },
    { projectId: 'other' },
    { providerInstanceId: 'other' },
    { model: 'other' },
    { latestRunId: 'other' },
  ])('rejects changed native thread provenance %j', async (change) => {
    const x = await fixture();
    x.state.overrideThread = change;
    await expect(invoke(x)).rejects.toMatchObject({ statusCode: 409 });
    expect(await x.cliStarted()).toBe(false);
  });
  it('requires native MCP rather than treating a registered CLI/catalog as safe', async () => {
    const x = await fixture();
    const { mcp: _mcp, ...cliOnly } = x.config;
    await expect(
      generateText({
        model: t3LanguageModel(cliOnly, profile, 'cli-only'),
        prompt: 'Do not start.',
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(await x.cliStarted()).toBe(false);
    expect(x.state.nativeWork).toEqual([]);
  });
});
