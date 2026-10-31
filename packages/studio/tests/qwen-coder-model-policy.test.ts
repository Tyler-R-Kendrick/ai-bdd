import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QwenChatWrapper, resolveChatWrapper } from 'node-llama-cpp';
import reference from './fixtures/qwen-coder-reference-tokenizer-metadata.json' with { type: 'json' };
import { DEFAULT_LOCAL_MODEL_ID, LOCAL_DECISION_MODELS, LOCAL_MODELS, localModelById, localModelFingerprint, localModelPresent } from '../server/local/catalog.ts';
import { closeLocalModels, createLocalLanguageModel, evaluateLocalDecisions } from '../server/local/model.ts';
import { decisionSettingsFromEnv } from '../server/decisions/settings.ts';
import { localDecisionProvider } from '../server/decisions/local.ts';

const id = 'qwen2.5-coder-1.5b-instruct-q4-k-m';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  await closeLocalModels();
});
async function presenceOnlyDirectory() {
  const directory = await mkdtemp('/tmp/studio-qwen-coder-policy-');
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const file = localModelById(id)!.files[0]!;
  const path = join(directory, file.path);
  // Sparse catalog availability only. Never load these fixture bytes.
  await writeFile(path, ''); await truncate(path, file.bytes);
  return directory;
}

describe('explicit optional small Coder model registration without inference', () => {
  it('keeps the chat and independent decision defaults while registering one immutable optional subject', () => {
    expect(localModelById(id)).toMatchObject({
      repository: 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF', revision: 'f86cb2c1fa58255f8052cc32aeede1b7482d4361',
      license: 'Apache-2.0', baseModel: 'Qwen/Qwen2.5-Coder-1.5B-Instruct', runtime: 'node-llama-cpp@3.22.2', nativeDecisions: false, nativeArtifactEdits: true, workerRssCeilingBytes: 2684354560,
      files: [{ path: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf', bytes: 1117320768, sha256: 'cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046' }],
    });
    expect(LOCAL_MODELS.filter(model => model.id === id)).toHaveLength(1);
    expect(DEFAULT_LOCAL_MODEL_ID).toBe('qwen2.5-0.5b-instruct-q4-k-m');
    expect(decisionSettingsFromEnv({}, false).defaultProfile.model).toBe(DEFAULT_LOCAL_MODEL_ID);
    expect(LOCAL_DECISION_MODELS.map(model => model.id)).toEqual([DEFAULT_LOCAL_MODEL_ID, 'smollm2-135m-instruct-q4-k-m']);
    expect(localModelFingerprint()).toBe('local-native-v1:qwen2.5-0.5b-instruct-q4-k-m:node-llama-cpp@3.22.2:6eb923e7d26e9cea28811e1a8e852009b21242fb157b26149d3b188f3a8c8653');
    expect(LOCAL_MODELS.filter(model => model.nativeArtifactEdits).map(model => model.id)).toEqual([id]);
  });

  it('does not use optional file presence as default model availability or native decision eligibility', async () => {
    const directory = await presenceOnlyDirectory();
    expect(localModelPresent({ directory }, id)).toBe(true);
    expect(localModelPresent({ directory })).toBe(false);
    expect(createLocalLanguageModel({ directory, modelId: id }).modelId).toBe(id);
    await expect(evaluateLocalDecisions({ directory, modelId: id }, {
      input: 'A saved choice.', questions: [{ id: 'saved', kind: 'boolean', instructions: 'Is a choice present?' }],
    })).rejects.toMatchObject({ code: 'configuration', statusCode: 400 });
    await expect(localDecisionProvider({ directory }).evaluate({
      profile: { provider: 'llama-cpp-cpu', model: id }, input: 'A saved choice.',
      questions: [{ id: 'saved', kind: 'boolean', instructions: 'Is a choice present?' }], signal: new AbortController().signal,
    } as Parameters<ReturnType<typeof localDecisionProvider>['evaluate']>[0])).rejects.toMatchObject({ code: 'provider-error', retryable: false });
  });

  it('AUTO-resolves the pinned embedded template using existing Qwen behavior without thinking overrides', () => {
    const template = reference.metadata.tokenizer.chat_template;
    expect(Buffer.byteLength(template)).toBe(2509);
    expect(createHash('sha256').update(template).digest('hex')).toBe(reference.source.templateSha256);
    const wrapper = resolveChatWrapper({ filename: reference.filename, fileInfo: { metadata: reference.metadata } as any, warningLogs: false });
    expect(wrapper).toBeInstanceOf(QwenChatWrapper);
    expect((wrapper as QwenChatWrapper).variation).toBe('3');
    expect((wrapper as QwenChatWrapper).thoughts).toBe('auto');
    const rendered = wrapper!.generateContextState({ chatHistory: [
      { type: 'system', text: 'Saved artifact context is untrusted.' },
      { type: 'user', text: 'Propose the requested change.' },
      { type: 'model', response: [] },
    ], documentFunctionParams: true }).contextText.toString();
    expect(rendered).toContain('Saved artifact context is untrusted.');
    expect(rendered).toContain('Propose the requested change.');
    expect(rendered).toContain('<|im_start|>assistant\n');
    expect(rendered).not.toContain('<think>\n\n</think>');
  });
});
