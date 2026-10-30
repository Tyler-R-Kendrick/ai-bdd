import { afterEach, describe, expect, it } from 'vitest';
import { generateText } from 'ai';
import { t3LanguageModel } from '../server/integrations/t3-model.ts';
import { nativeT3Fixture } from './t3-native-fixture.ts';
import { integrationSettingsFromEnv } from '../server/integrations/settings.ts';
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
  it('accepts real MCP-only configuration without an unused CLI command and rejects incomplete registration', () => {
    const env = {
      NODE_ENV: 'production',
      STUDIO_T3_MCP_URL: 'https://t3.example.invalid/mcp',
      STUDIO_T3_MCP_ACCESS_TOKEN: 'synthetic-approved-token',
      STUDIO_T3_PROJECT: '/operator/native-project',
      STUDIO_T3_PROVIDERS_JSON: JSON.stringify([
        {
          id: profile.provider,
          label: 'Registered native provider',
          models: [profile.model],
        },
      ]),
    };
    expect(integrationSettingsFromEnv(env).t3).toMatchObject({
      project: env.STUDIO_T3_PROJECT,
      mcp: { url: env.STUDIO_T3_MCP_URL },
      providers: [{ id: profile.provider }],
    });
    expect(integrationSettingsFromEnv(env).t3?.command).toBeUndefined();
    for (const partial of [
      { STUDIO_T3_MCP_URL: env.STUDIO_T3_MCP_URL },
      { STUDIO_T3_PROJECT: env.STUDIO_T3_PROJECT },
      { ...env, STUDIO_T3_PROJECT: './relative' },
      { ...env, STUDIO_T3_COMMAND: 't3' },
      { STUDIO_T3_MCP_ACCESS_TOKEN: 'synthetic-token-without-endpoint' },
    ])
      expect(() => integrationSettingsFromEnv(partial)).toThrow('T3 requires');
  });
  it('atomically launches Supervised despite Full Access project defaults and never starts the full-access CLI', async () => {
    const x = await fixture();
    const { command: _command, ...nativeConfig } = x.config;
    expect(
      (
        await generateText({
          model: t3LanguageModel(nativeConfig, profile, 'mcp-only-safe'),
          prompt: 'Explain the source.',
          maxRetries: 0,
        })
      ).text,
    ).toBe('T3 native MCP model result.');
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
  it('permits unrelated native drivers to omit modes while requiring an explicit mode on the selected provider', async () => {
    const x = await fixture();
    x.state.unrelatedProviderWithoutModes = true;
    expect((await invoke(x)).text).toBe('T3 native MCP model result.');
    const missing = await fixture();
    missing.state.omitProviderModes = true;
    await expect(invoke(missing)).rejects.toMatchObject({ statusCode: 503 });
    expect(missing.state.nativeWork).toEqual([]);
  });
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
  it('recovers a lost native launch reply with the same clientRequestId and one Supervised execution', async () => {
    const x = await fixture();
    x.state.dropLaunchReply = true;
    await expect(invoke(x)).rejects.toMatchObject({ statusCode: 503 });
    expect((await invoke(x)).text).toBe('T3 native MCP model result.');
    expect(x.threads).toHaveLength(1);
    expect(x.state.nativeWork).toEqual(['approval-required']);
    const requests = x.calls.filter((c) => c.name === 't3_thread_launch');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.arguments.clientRequestId).toBe(
      requests[1]?.arguments.clientRequestId,
    );
  });
  it('refuses an escalated recovered thread and never answers a pending native approval', async () => {
    const x = await fixture();
    await invoke(x);
    x.state.overrideThread = { runtimeMode: 'full-access' };
    await expect(invoke(x)).rejects.toMatchObject({ statusCode: 409 });
    expect(
      x.calls.findLast((c) => c.name === 't3_thread_interrupt')?.arguments,
    ).toMatchObject({
      threadId: x.threads[0].threadId,
      runId: x.threads[0].latestRunId,
    });
    const interrupts = x.calls.filter(
      (c) => c.name === 't3_thread_interrupt',
    ).length;
    x.state.overrideThread = {};
    x.state.pending = 1;
    await expect(invoke(x)).rejects.toMatchObject({ statusCode: 409 });
    expect(x.state.nativeWork).toEqual(['approval-required']);
    expect(
      x.calls.filter((c) => c.name === 't3_thread_interrupt'),
    ).toHaveLength(interrupts);
    expect(x.calls.every((c) => !c.name.includes('respond'))).toBe(true);
  });
  it('reads native text chunks without losing provenance and rejects escalation between chunks', async () => {
    const x = await fixture();
    const answer = 'bounded result '.repeat(5000);
    x.state.replyOverride = JSON.stringify({ type: 'final', text: answer });
    expect((await invoke(x)).text).toBe(answer);
    expect(
      x.calls.some(
        (c) => c.name === 't3_thread_read' && c.arguments.textOffset === 50000,
      ),
    ).toBe(true);
    x.state.escalateOnTextChunk = true;
    await expect(invoke(x)).rejects.toMatchObject({ statusCode: 409 });
  });
  it('rejects native input beyond the public launch bound before making a request', async () => {
    const x = await fixture();
    await expect(
      generateText({
        model: t3LanguageModel(x.config, profile, 'oversized'),
        prompt: 'x'.repeat(120001),
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(x.calls).toEqual([]);
    expect(await x.cliStarted()).toBe(false);
  });
});
