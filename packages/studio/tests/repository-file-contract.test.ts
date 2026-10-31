import { describe, expect, it, vi } from 'vitest';
import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { RepositoryReader } from '../server/integrations/repository.ts';
import { repositoryFileTool } from '../server/integrations/repository-tools.ts';

const revision = 'b'.repeat(40);
function controlledModel(input: unknown) {
  return new MockLanguageModelV3({
    provider: 'owned-contract-recorder', modelId: 'controlled-no-inference',
    doGenerate: [
      { content: [{ type: 'tool-call', toolCallId: 'controlled-file-call', toolName: 'repository_file', input: JSON.stringify(input) }], finishReason: { unified: 'tool-calls', raw: 'controlled' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] },
      { content: [{ type: 'text', text: 'Controlled contract result received.' }], finishReason: { unified: 'stop', raw: 'controlled' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] },
    ],
  });
}
function ownedReader() {
  const authorize = vi.fn(async () => {});
  const network = vi.fn(async () => { throw new Error('No network is allowed in this controlled contract test'); });
  const identityRead = vi.fn(async (_input: unknown, _signal: AbortSignal) => ({ type: 'file', encoding: 'base64', size: 23, content: Buffer.from('Owned controlled source').toString('base64') }));
  const reader = new RepositoryReader('https://github.com/owned/contract-fixture', {} as any, authorize, new AbortController().signal, network as typeof fetch, identityRead);
  reader.pin(revision);
  const lookup = vi.spyOn(reader, 'revision');
  const file = vi.spyOn(reader, 'file');
  return { reader, authorize, network, identityRead, lookup, file };
}
async function invoke(input: unknown) {
  const fixture = ownedReader(), model = controlledModel(input);
  const result = await generateText({ model, prompt: 'Read the requested saved repository file.', tools: { repository_file: repositoryFileTool(path => fixture.reader.file(path)) }, toolChoice: 'auto', stopWhen: stepCountIs(2), maxRetries: 0 });
  return { ...fixture, model, result };
}

describe('shared production repository-file contract through the actual AI SDK (controlled provider, no inference)', () => {
  it('advertises strict inputs, supported string bounds and an explicit relative POSIX namespace in actual JSON schema', async () => {
    const { model, result } = await invoke({ path: 'lib/helpers.ts' });
    const actual = model.doGenerateCalls[0]!.tools!.find(tool => tool.type === 'function' && tool.name === 'repository_file');
    expect(actual?.type).toBe('function');
    if (!actual || actual.type !== 'function') throw new Error('The shared production tool was not advertised');
    expect(actual.description).toContain('repository-relative POSIX');
    expect(actual.description).toContain('native working directory is not the repository root');
    expect(actual.inputSchema).toMatchObject({ type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1, maxLength: 500 } } });
    const property = (actual.inputSchema.properties as Record<string, any>).path;
    expect(property.description).toContain('Repository-relative POSIX');
    expect(property.description).toContain('lib/helpers.ts');
    expect(property.description).toContain('native working directory');
    expect(property.description).toContain('backslashes');
    expect(property.description).toContain('control characters');
    // No unsupported native regex or target-specific constrained answer/call is introduced.
    expect(property).not.toHaveProperty('pattern');
    expect(property).not.toHaveProperty('const');
    expect(property).not.toHaveProperty('enum');
    expect(JSON.stringify(actual)).not.toContain('Cedar Lantern');
    expect(JSON.stringify(actual)).not.toContain('src/main.ts');
    expect(result.steps).toHaveLength(2);
  });

  it.each(['/tmp/src/main.ts', '/server-owned-state/workspace/lib/helpers.ts', '../private', 'lib/../private', './lib/helpers.ts', 'lib/./helpers.ts', 'lib\\helpers.ts', 'lib//helpers.ts', 'lib/', '', 'lib/secret\u0000.ts', 'lib/secret\n.ts', 'lib/secret\u007f.ts', 'x'.repeat(501)])('rejects malformed path %j before revision, authorization or any transport', async path => {
    const { result, file, lookup, authorize, identityRead, network, model } = await invoke({ path });
    expect(result.steps[0]!.content.filter(part => part.type === 'tool-error')).toHaveLength(1);
    expect(file).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(identityRead).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    // The original input stays visible in the typed SDK history; it is never rewritten.
    const continued = model.doGenerateCalls[1]!.prompt;
    expect(continued.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'tool-call' && JSON.stringify(part.input) === JSON.stringify({ path })))).toBe(true);
    expect(continued.some(message => message.role === 'tool' && message.content.some(part => part.type === 'tool-result' && part.output.type === 'error-text'))).toBe(true);
  });

  it.each(['actor', 'userId', 'repository', 'root', 'ref', 'revision'])('does not let a model-selected %s change authority', async extra => {
    const { result, file, lookup, authorize, identityRead, network } = await invoke({ path: 'lib/helpers.ts', [extra]: 'model-chosen-scope' });
    expect(result.steps[0]!.content.filter(part => part.type === 'tool-error')).toHaveLength(1);
    expect(file).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled(); expect(identityRead).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });

  it.each(['lib/helpers.ts', '.github/workflows/check.yml', 'docs/file name.md', 'source/δοκιμή.ts', 'assets/literal%2fname.txt'])('preserves valid repository-relative path %j and the captured repository/ref', async path => {
    const { result, file, authorize, identityRead, network } = await invoke({ path });
    expect(result.steps[0]!.content.filter(part => part.type === 'tool-error')).toHaveLength(0);
    expect(file).toHaveBeenCalledExactlyOnceWith(path);
    expect(identityRead).toHaveBeenCalledExactlyOnceWith({ kind: 'file', path, ref: revision }, expect.any(AbortSignal));
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(network).not.toHaveBeenCalled();
    expect(result.steps[0]!.toolResults[0]!.output).toMatchObject({ repository: 'owned/contract-fixture', revision, path, text: 'Owned controlled source' });
  });
});
