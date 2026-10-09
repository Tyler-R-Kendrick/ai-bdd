/**
 * @ai-bdd/models — model adapters and fakes.
 *
 * `aiSdkModels` adapts AI SDK models to the ai-bdd model SPI; the `./fake`
 * subpath exports the deterministic fakes used by every default test run.
 */
import type { ChatModel, Embedder, GenerateRequest, GenerateResult, GroundingScorer, JsonValue, ModelSet } from '@ai-bdd/contracts';
import { AiBddError } from '@ai-bdd/contracts';

export * from './fake.js';

export interface AiSdkModelsOptions {
  act: unknown;
  judge: unknown;
  extract?: unknown;
  checkgen?: unknown;
  embed: unknown;
  grounding?: unknown;
}

/**
 * Wraps AI SDK language and embedding models behind the ai-bdd SPI.
 *
 * The AI SDK (`ai@^7`) is loaded lazily so that a project which only uses the
 * fakes never needs it installed. When the package is missing the adapter
 * raises MODEL_UNAVAILABLE with an actionable message instead of failing during
 * module evaluation (VERIFY V14 records the verified API of the installed
 * major).
 */
export function aiSdkModels(options: AiSdkModelsOptions): ModelSet {
  const wrap = (purpose: string, model: unknown): ChatModel => ({
    id: modelIdOf(model, purpose),
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const sdk = await loadAiSdk();
      const result = await sdk.generateText({
        model: model as never,
        messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.seed !== undefined ? { seed: request.seed } : {}),
        ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      });
      const usage = {
        inputTokens: Number((result.usage as { inputTokens?: number } | undefined)?.inputTokens ?? 0),
        outputTokens: Number((result.usage as { outputTokens?: number } | undefined)?.outputTokens ?? 0),
        calls: 1,
      };
      const text = typeof result.text === 'string' ? result.text : undefined;
      const object = request.schema !== undefined && text !== undefined ? tryJson(text) : undefined;
      return {
        modelId: modelIdOf(model, purpose),
        usage,
        ...(text !== undefined ? { text } : {}),
        ...(object !== undefined ? { object } : {}),
        ...(Array.isArray((result as { toolCalls?: unknown[] }).toolCalls)
          ? { toolCalls: ((result as { toolCalls: Array<{ toolName?: string; toolCallId?: string; input?: JsonValue }> }).toolCalls).map((call) => ({ name: call.toolName ?? 'tool', args: call.input ?? null })) }
          : {}),
      };
    },
  });

  const makeEmbedder = async (texts: string[]): Promise<Float32Array[]> => {
    const sdk = await loadAiSdk();
    const result = await sdk.embedMany({ model: options.embed as never, values: texts });
    return (result.embeddings as number[][]).map((embedding) => {
      const vector = new Float32Array(embedding);
      let sum = 0;
      for (const value of vector) sum += value * value;
      const norm = Math.sqrt(sum);
      if (norm > 0) for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] ?? 0) / norm;
      return vector;
    });
  };

  const modelSet: ModelSet = {
    act: wrap('act', options.act),
    judge: wrap('judge', options.judge),
    extract: wrap('extract', options.extract ?? options.act),
    checkgen: wrap('checkgen', options.checkgen ?? options.act),
    embed: {
      id: modelIdOf(options.embed, 'embed'),
      dimensions: 1536,
      embed: makeEmbedder,
    } satisfies Embedder,
    ...(options.grounding !== undefined ? { grounding: options.grounding as GroundingScorer } : {}),
  };
  return modelSet;
}

function modelIdOf(model: unknown, purpose: string): string {
  if (typeof model === 'string') return model;
  if (model && typeof model === 'object') {
    const record = model as { modelId?: string; id?: string };
    if (typeof record.modelId === 'string') return record.modelId;
    if (typeof record.id === 'string') return record.id;
  }
  return `ai-sdk:${purpose}`;
}

function tryJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

async function loadAiSdk(): Promise<{
  generateText: (options: unknown) => Promise<{ text?: string; usage?: unknown; toolCalls?: unknown[] }>;
  embedMany: (options: unknown) => Promise<{ embeddings: number[][] }>;
}> {
  try {
    const mod = (await import('ai' as string)) as unknown as {
      generateText: (options: unknown) => Promise<{ text?: string; usage?: unknown; toolCalls?: unknown[] }>;
      embedMany: (options: unknown) => Promise<{ embeddings: number[][] }>;
    };
    return mod;
  } catch (error) {
    throw new AiBddError('MODEL_UNAVAILABLE', 'the `ai` package is required for aiSdkModels(); install ai@^7 or use the fakes', { details: { cause: String(error) } });
  }
}
