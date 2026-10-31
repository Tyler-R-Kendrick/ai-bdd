import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** Replaces the native binding with an owned protocol recorder. No GGUF model or inference is involved. */
const controlledRuntime = String.raw`
const send = value => process.send?.(value);
const meter = { usedInputTokens: 32, usedOutputTokens: 5 };
export async function getLlama(options) {
  send({type:'fixture-binding',gpu:options.gpu,build:options.build,skipDownload:options.skipDownload});
  return {
    async loadModel() { return {
      tokenize() {return Array(8).fill(0)}, tokenizer() {return []},
      async createContext(options) {
        send({type:'fixture-context',options});
        return {getSequence(){return {tokenMeter:{getState(){return meter}}}}, async dispose(){send({type:'fixture-disposed'})}};
      }, async dispose() {},
    }},
    async createGrammarForJsonSchema(schema) {
      send({type:'fixture-grammar',schema});
      return {parse(text){JSON.parse(text);send({type:'fixture-grammar-validated'})}};
    },
  };
}
export class LlamaChat {
  constructor(options) {
    send({type:'fixture-low-level-chat'}); this.sequence = options.contextSequence;
    this.chatWrapper = {generateContextState(input) {
      send({type:'fixture-wrapper',history:input.chatHistory,functions:input.availableFunctions});
      const count = JSON.stringify(input.chatHistory).includes('force_large_wrapped_context') ? 4100 : 32;
      return {contextText:{tokenize(){return Array(count).fill(0)}}};
    }};
  }
  async generateResponse(history, options) {
    const definitions = Object.values(options.functions ?? {});
    const hasHandlers = definitions.some(fn => 'handler' in fn || Object.values(fn).some(value => typeof value === 'function'));
    send({type:'fixture-generation',functionNames:Object.keys(options.functions ?? {}),hasHandlers,
      onFunctionCallPresent:options.onFunctionCall !== undefined, grammarPresent:options.grammar !== undefined,
      maxParallelFunctionCalls:options.maxParallelFunctionCalls,maxTokens:options.maxTokens});
    if(hasHandlers || options.onFunctionCall) throw new Error('Unexpected executing function handler');
    options.onToken?.([1,2]);
    return options.functions
      ? {response:'',functionCalls:[{functionName:'repository_file',params:{path:'src/main.ts'},raw:'private-parser-internals'}],metadata:{stopReason:'functionCalls'}}
      : {response:'{"answer":4}',functionCalls:[],metadata:{stopReason:'eogToken'}};
  }
}
export class LlamaChatSession {
  constructor(){send({type:'fixture-executing-session'});throw new Error('Function requests must use the non-executing low-level API')}
}
export function resolveChatWrapper(){throw new Error('Decision inference is outside this controlled generation fixture')}
`;

async function runWorker(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp('/tmp/studio-controlled-function-worker-');
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const file = 'owned-protocol-fixture.bin', bytes = Buffer.from('owned fake binding input; no model weights');
  await writeFile(join(root, file), bytes);
  const bundle = join(root, 'worker-fixture.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../server/local/studio-local-worker.mjs', import.meta.url))],
    outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'owned-native-binding-fixture', setup(builder) {
      builder.onResolve({ filter: /^node-llama-cpp$/ }, () => ({ path: 'owned-native-binding', namespace: 'owned-fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'owned-fixture' }, () => ({ contents: controlledRuntime, loader: 'js' }));
    } }],
  });
  const child = fork(bundle, [], { execArgv: [], env: { PATH: '/usr/local/bin:/usr/bin:/bin', DO_NOT_TRACK: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const events: any[] = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const terminal = new Promise<any>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Controlled native worker fixture timed out')), 10000);
      child.on('message', (event: any) => { events.push(event); if (event.type === 'result' || event.type === 'error') resolve(event); });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Controlled native worker exited before a result')));
    });
    child.send({
      configuration: { directory: root, file: { path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } },
      system: 'Owned server policy', prompt: 'Read the saved file.', history: [], maxTokens: 32,
      nativeFunctions: { repository_file: { description: 'Read a saved file.', params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } },
      nativeHistory: [{ type: 'system', text: 'Owned server policy' }, { type: 'user', text: 'Read the saved file.' }],
      ...overrides,
    });
    return { events, result: await terminal };
  } finally {
    clearTimeout(timeout);
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
}

describe('shipping worker with an owned native-binding recorder (no inference)', () => {
  it('uses low-level parsed function intents without handlers, generic grammar or executing chat sessions', async () => {
    const { events, result } = await runWorker();
    expect(result).toMatchObject({ type: 'result', text: '', functionCalls: [{ functionName: 'repository_file', params: { path: 'src/main.ts' } }], inputTokens: 32, outputTokens: 5 });
    expect(Object.keys(result.functionCalls[0]).sort()).toEqual(['functionName', 'params']);
    expect(JSON.stringify(result)).not.toContain('private-parser-internals');
    expect(events.find(event => event.type === 'fixture-generation')).toEqual({ type: 'fixture-generation', functionNames: ['repository_file'], hasHandlers: false, onFunctionCallPresent: false, grammarPresent: false, maxParallelFunctionCalls: 4, maxTokens: 32 });
    expect(events.some(event => event.type === 'fixture-executing-session' || event.type === 'fixture-grammar')).toBe(false);
    expect(events.find(event => event.type === 'fixture-binding')).toEqual({ type: 'fixture-binding', gpu: false, build: 'never', skipDownload: true });
    expect(events.find(event => event.type === 'fixture-context').options).toMatchObject({ contextSize: 4096, batchSize: 128, flashAttention: false });
    expect(events.some(event => event.type === 'fixture-disposed')).toBe(true);
  });

  it('refuses simultaneous general grammar and functions before generation', async () => {
    const { events, result } = await runWorker({ schema: { type: 'object' } });
    expect(result).toEqual({ type: 'error', code: 'inference' });
    expect(events.some(event => ['fixture-generation', 'fixture-grammar', 'fixture-executing-session'].includes(event.type))).toBe(false);
  });

  it('counts the actual rendered function/history context before permitting generation', async () => {
    const { events, result } = await runWorker({ nativeHistory: [{ type: 'user', text: 'force_large_wrapped_context' }] });
    expect(result).toEqual({ type: 'error', code: 'context' });
    expect(events.some(event => event.type === 'fixture-wrapper')).toBe(true);
    expect(events.some(event => event.type === 'fixture-generation')).toBe(false);
    expect(events.some(event => event.type === 'fixture-disposed')).toBe(true);
  });

  it('allows grammar with typed history only when no new functions are available', async () => {
    const { events, result } = await runWorker({ nativeFunctions: {}, schema: { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false } });
    expect(result).toMatchObject({ type: 'result', text: '{"answer":4}', functionCalls: [] });
    expect(events.find(event => event.type === 'fixture-generation')).toMatchObject({ functionNames: [], hasHandlers: false, grammarPresent: true });
    expect(events.some(event => event.type === 'fixture-grammar-validated')).toBe(true);
    expect(events.some(event => event.type === 'fixture-executing-session')).toBe(false);
  });
});
