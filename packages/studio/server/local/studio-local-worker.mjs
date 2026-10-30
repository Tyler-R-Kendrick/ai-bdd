/** Dedicated offline CPU inference. This worker never executes model-generated tools. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
// Runtime downloads are forbidden; model/binary preparation belongs to the controlled build.
globalThis.fetch = async () => { throw new Error('Local inference has no HTTP transport'); };
const port = { postMessage: value => process.send?.(value) };
let workerData;
let model, llama;
async function load() {
  if (model) return;
  const root = await realpath(workerData.directory);
  const file = workerData.file;
  const path = join(root, file.path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes || dirname(await realpath(path)) !== root)
    throw new Error('assets');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  if (hash.digest('hex') !== file.sha256) throw new Error('assets');
  const runtime = await import('node-llama-cpp');
  llama = await runtime.getLlama({ gpu: false, build: 'never', skipDownload: true, maxThreads: 2, progressLogs: false, logLevel: 'error', logger: () => {} });
  model = await llama.loadModel({ modelPath: path, gpuLayers: 0 });
}
process.on('message', async request => {
  workerData = request.configuration;
  let context, response;
  try {
    await load();
    const { LlamaChatSession } = await import('node-llama-cpp');
    const grammar = request.schema ? await llama.createGrammarForJsonSchema(request.schema) : undefined;
    const tokens = model.tokenize(request.system + '\n' + JSON.stringify(request.history) + '\n' + request.prompt).length;
    // Reserve native chat framing and output; never silently shift or drop source context.
    if (tokens + request.maxTokens + 128 > 4096) throw new Error('context');
    context = await model.createContext({ contextSize: 4096, threads: 2, batchSize: 128, flashAttention: false });
    const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: request.system });
    if (request.history.length) session.setChatHistory([{ type: 'system', text: request.system }, ...request.history.map(item => item.role === 'assistant' ? { type: 'model', response: [item.text] } : { type: 'user', text: item.text })]);
    const result = await session.promptWithMeta(request.prompt, {
      maxTokens: request.maxTokens,
      temperature: 0,
      grammar,
      onTextChunk: text => port.postMessage({ type: 'delta', text }),
      customStopTriggers: request.stopSequences,
    });
    // Native parse verifies grammar completion; independent parent validation checks the original schema too.
    if (grammar) grammar.parse(result.responseText);
    const meter = session.sequence.tokenMeter.getState();
    response = { type: 'result', text: result.responseText, inputTokens: meter.usedInputTokens, outputTokens: meter.usedOutputTokens, limited: result.stopReason === 'maxTokens', rss: process.memoryUsage().rss };
  } catch (error) {
    const code = error?.message === 'assets' || error?.message === 'context' ? error.message : 'inference';
    // No library error strings, prompts, paths, or generated text in error metadata.
    response = { type: 'error', code };
  } finally {
    await context?.dispose();
    port.postMessage(response);
  }
});
