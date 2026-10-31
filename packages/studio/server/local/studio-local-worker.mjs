/** Dedicated offline CPU inference. This worker never executes model-generated tools. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { availableParallelism } from 'node:os';
import { LOCAL_DEFAULT_RSS_BYTES, workerResourceConfiguration } from './model-resources.mjs';
// Runtime downloads are forbidden; model/binary preparation belongs to the controlled build.
globalThis.fetch = async () => {
  throw new Error('Local inference has no HTTP transport');
};
const port = { postMessage: (value) => process.send?.(value) };
const phase = (name, counts = {}) => port.postMessage({ type: 'phase', phase: name, rss: process.memoryUsage().rss,
  ...(workerData ? { rssCeilingBytes: workerData.rssCeilingBytes, useMmap: workerData.useMmap } : {}),
  ...(Number.isSafeInteger(counts.availableParallelism) ? { availableParallelism: counts.availableParallelism } : {}),
  ...(Number.isSafeInteger(counts.inputTokens) ? { inputTokens: counts.inputTokens } : {}),
  ...(Number.isSafeInteger(counts.outputTokens) ? { outputTokens: counts.outputTokens } : {}),
});
process.once('disconnect', () => process.exit(0));
let workerData, running = false;
let refusingMemory = false;
function checkMemory() {
  const ceiling = workerData?.rssCeilingBytes ?? LOCAL_DEFAULT_RSS_BYTES;
  const rss = process.memoryUsage().rss;
  if (refusingMemory || rss <= ceiling) return;
  refusingMemory = true;
  try {
    process.send?.({ type: 'error', code: 'memory', rss, rssCeilingBytes: ceiling, useMmap: workerData?.useMmap ?? false }, () => process.exit(1));
  } catch {
    process.exit(1);
  }
}
const memoryTimer = setInterval(checkMemory, 100);
memoryTimer.unref();

let model, llama, loadedPath;
async function load() {
  const root = await realpath(workerData.directory);
  const file = workerData.file;
  const path = join(root, file.path);
  if (model && loadedPath === path) { phase('model-loaded'); return; }
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== file.bytes ||
    (workerData.useMmap && (info.mode & 0o222) !== 0) ||
    dirname(await realpath(path)) !== root
  )
    throw new Error('assets');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  if (hash.digest('hex') !== file.sha256) throw new Error('assets');
  phase('weights-verified');
  const runtime = await import('node-llama-cpp');
  await model?.dispose();
  model = undefined;
  loadedPath = undefined;
  llama ??= await runtime.getLlama({
    gpu: false,
    build: 'never',
    skipDownload: true,
    // Never oversubscribe a single-affinity host: native prefill can otherwise exhaust its deadline.
    maxThreads: Math.min(2, availableParallelism()),
    progressLogs: false,
    logLevel: 'error',
    logger: () => {},
  });
  phase('binding-loaded');
  model = await llama.loadModel({ modelPath: path, gpuLayers: 0, useMmap: workerData.useMmap, useMlock: false });
  loadedPath = path;
  phase('model-loaded');
}
process.on('message', async (request) => {
  let selected;
  try {
    selected = workerResourceConfiguration(request?.modelId, request?.configuration);
    if (running || (workerData && (workerData.modelId !== selected.modelId ||
      workerData.directory !== selected.directory || workerData.rssCeilingBytes !== selected.rssCeilingBytes ||
      workerData.useMmap !== selected.useMmap))) throw new Error('configuration');
  } catch {
    process.send?.({ type: 'error', code: 'configuration' }, () => process.exit(1));
    return;
  }
  workerData ??= selected;
  running = true;
  checkMemory();
  if (refusingMemory) return;
  phase('worker-start', { availableParallelism: availableParallelism() });
  let context, response;
  try {
    await load();
    phase('inference-start');
    if (request.command === 'decide') {
      const { evaluateLocalDecisions } = await import(
        './studio-local-decisions.mjs'
      );
      response = {
        type: 'decision',
        result: await evaluateLocalDecisions({ model, input: request.input, onPhase: phase }),
      };
      return;
    }
    const { LlamaChat, LlamaChatSession } = await import('node-llama-cpp');
    const nativeFunctions = request.nativeFunctions && Object.keys(request.nativeFunctions).length ? request.nativeFunctions : undefined;
    if (nativeFunctions && request.schema) throw new Error('inference');
    phase('grammar-start');
    const grammar = request.schema ? await llama.createGrammarForJsonSchema(request.schema) : undefined;
    phase('grammar-ready');
    const approximateTokens = model.tokenize(request.system + '\n' + JSON.stringify(request.history) + '\n' + request.prompt).length;
    if (!request.nativeHistory && approximateTokens + request.maxTokens + 128 > 4096) throw new Error('context');
    phase('context-create');
    context = await model.createContext({ contextSize: 4096, threads: Math.min(2, availableParallelism()), batchSize: 128, flashAttention: false });
    phase('context-created');
    const contextShift = { strategy: () => { throw new Error('context'); } };
    let decoding = false, outputTokens = 0;
    const callbacks = {
      onTextChunk: (text) => port.postMessage({ type: 'delta', text }),
      onToken: (tokens) => {
        outputTokens += tokens.length;
        if (!decoding && outputTokens > 0) { decoding = true; phase('decode-start', { outputTokens }); }
      },
    };
    let text, stopReason, meter, functionCalls;
    if (request.nativeHistory) {
      // Low-level LlamaChat parses declarations/calls only. It has no function
      // handlers and cannot execute any model-selected tool in this process.
      const chat = new LlamaChat({ contextSequence: context.getSequence() });
      const history = request.nativeHistory;
      if (history.at(-1)?.type !== 'model') history.push({ type: 'model', response: [] });
      const rendered = chat.chatWrapper.generateContextState({ chatHistory: history, availableFunctions: nativeFunctions, documentFunctionParams: true });
      const tokens = rendered.contextText.tokenize(model.tokenizer).length;
      if (tokens + request.maxTokens + 128 > 4096) throw new Error('context');
      phase('prompt-validated', { inputTokens: tokens });
      phase('session-ready'); phase('prefill-start');
      const result = await chat.generateResponse(history, {
        maxTokens: request.maxTokens, temperature: 0, contextShift,
        ...(nativeFunctions ? { functions: nativeFunctions, documentFunctionParams: true, maxParallelFunctionCalls: 4 } : { grammar }),
        ...callbacks, customStopTriggers: request.stopSequences,
      });
      text = result.response; stopReason = result.metadata.stopReason;
      functionCalls = result.functionCalls?.map(call => ({ functionName: call.functionName, params: call.params }));
      meter = chat.sequence.tokenMeter.getState();
    } else {
      phase('prompt-validated', { inputTokens: approximateTokens });
      const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: request.system, contextShift });
      if (request.history.length) session.setChatHistory([
        { type: 'system', text: request.system },
        ...request.history.map(item => item.role === 'assistant' ? { type: 'model', response: [item.text] } : { type: 'user', text: item.text }),
      ]);
      phase('session-ready'); phase('prefill-start');
      const result = await session.promptWithMeta(request.prompt, { maxTokens: request.maxTokens, temperature: 0, grammar, ...callbacks, customStopTriggers: request.stopSequences });
      text = result.responseText; stopReason = result.stopReason; meter = session.sequence.tokenMeter.getState();
    }
    if (grammar) grammar.parse(text);
    phase('response-ready', { inputTokens: meter.usedInputTokens, outputTokens: meter.usedOutputTokens });
    response = { type: 'result', text, ...(functionCalls ? { functionCalls } : {}), inputTokens: meter.usedInputTokens, outputTokens: meter.usedOutputTokens, limited: stopReason === 'maxTokens', rss: process.memoryUsage().rss };
  } catch (error) {
    const code =
      error?.message === 'assets' || error?.message === 'context'
        ? error.message
        : 'inference';
    // No library error strings, prompts, paths, or generated text in error metadata.
    response = { type: 'error', code };
  } finally {
    if (context) {
      phase('context-dispose-start');
      await context.dispose();
      phase('context-disposed');
    }
    if (response?.type === 'result' || response?.type === 'decision') phase('complete');
    port.postMessage(response);
    running = false;
  }
});
