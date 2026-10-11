import { generateText, jsonSchema, Output, tool, type LanguageModel, type ToolSet } from 'ai';
import {
  AiBddError,
  type ChatModel,
  type JsonObject,
  type JsonValue,
  type ModelPurpose,
  type ModelRequest,
  type ModelResponse,
  type ModelSet,
  type ToolCall,
} from '@ai-bdd/sdk/contracts';
import { mapModelError } from './errors.ts';
import { toAiMessages } from './messages.ts';

export interface AiSdkModelsOptions {
  /** Passed straight through to the AI SDK's `maxRetries` (its default applies when omitted). */
  maxRetries?: number;
}

const PURPOSES: readonly ModelPurpose[] = ['extract', 'act', 'checkgen', 'judge'];

type SchemaArg = Parameters<typeof jsonSchema>[0];
type FinishReason = ModelResponse['finishReason'];

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
    case 'length':
    case 'error':
    case 'tool-calls':
      return reason;
    default:
      return 'other';
  }
}

function modelIdOf(model: LanguageModel): string {
  return typeof model === 'string' ? model : model.modelId;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildTools(req: ModelRequest): ToolSet | undefined {
  if (req.tools === undefined || req.tools.length === 0) return undefined;
  const tools: ToolSet = {};
  for (const spec of req.tools) {
    // No `execute`: the AI SDK returns the calls instead of running them.
    tools[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema(spec.inputSchema as SchemaArg),
    });
  }
  return tools;
}

class AiSdkChatModel implements ChatModel {
  readonly id: string;
  private readonly purpose: ModelPurpose;
  private readonly model: LanguageModel;
  private readonly opts: AiSdkModelsOptions;

  constructor(purpose: ModelPurpose, model: LanguageModel, opts: AiSdkModelsOptions) {
    this.purpose = purpose;
    this.model = model;
    this.opts = opts;
    this.id = modelIdOf(model);
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    // NOTE: `req.context` is deliberately never read here. It is for fakes, logs and evidence only.
    const tools = buildTools(req);
    const output =
      req.output === undefined
        ? undefined
        : Output.object({ schema: jsonSchema(req.output.schema as SchemaArg), name: req.output.name });

    let result;
    try {
      result = await generateText({
        model: this.model,
        messages: toAiMessages(req.messages),
        ...(req.system.length > 0 ? { instructions: req.system } : {}),
        ...(tools === undefined ? {} : { tools }),
        ...(tools === undefined || req.toolChoice === undefined ? {} : { toolChoice: req.toolChoice }),
        ...(output === undefined ? {} : { output }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        ...(req.seed === undefined ? {} : { seed: req.seed }),
        ...(req.maxOutputTokens === undefined ? {} : { maxOutputTokens: req.maxOutputTokens }),
        ...(req.signal === undefined ? {} : { abortSignal: req.signal }),
        ...(this.opts.maxRetries === undefined ? {} : { maxRetries: this.opts.maxRetries }),
      });
    } catch (error) {
      throw mapModelError(error, { purpose: this.purpose, modelId: this.id, signal: req.signal });
    }

    const toolCalls: ToolCall[] = [];
    for (const call of result.toolCalls) {
      if (call.invalid === true || !isPlainObject(call.input)) {
        throw new AiBddError(
          'MODEL_OUTPUT_INVALID',
          `model emitted an invalid tool call "${call.toolName}" (${this.purpose}/${this.id})`,
          {
            details: { purpose: this.purpose, modelId: this.id, toolName: call.toolName },
            ...(call.error === undefined ? {} : { cause: call.error }),
          },
        );
      }
      toolCalls.push({ id: call.toolCallId, name: call.toolName, args: call.input });
    }

    const response: ModelResponse = {
      toolCalls,
      usage: {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      },
      finishReason: mapFinishReason(result.finishReason),
      modelId: this.id,
    };
    if (result.text.length > 0) response.text = result.text;
    if (output !== undefined && toolCalls.length === 0) {
      // `result.output` is already parsed; a parse failure was thrown (and mapped) above.
      response.object = result.output as JsonValue;
    }
    return response;
  }
}

function requireModel(value: unknown, purpose: string): LanguageModel {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'object' && value !== null && 'modelId' in value) return value as LanguageModel;
  throw new AiBddError('CONFIG_INVALID', `models.${purpose} must be a model id string or an AI SDK language model`, {
    details: { purpose },
  });
}

/**
 * Builds a {@link ModelSet} backed by the Vercel AI SDK. Values are either AI SDK language model
 * objects or model id strings, which the AI SDK resolves through its global provider.
 */
export function aiSdkModels(models: Record<ModelPurpose, LanguageModel | string>, opts: AiSdkModelsOptions = {}): ModelSet {
  const build = (purpose: ModelPurpose): ChatModel =>
    new AiSdkChatModel(purpose, requireModel((models as Record<string, unknown>)[purpose], purpose), opts);
  return { extract: build('extract'), act: build('act'), checkgen: build('checkgen'), judge: build('judge') };
}

/**
 * JSON-config form: `{ extract, act, checkgen, judge, maxRetries? }`, where the four purposes are
 * model id strings passed to the AI SDK as-is. Unknown keys are rejected with `CONFIG_INVALID`.
 */
export function createModelSet(options: Record<string, unknown>): ModelSet {
  const known = new Set<string>([...PURPOSES, 'maxRetries']);
  for (const key of Object.keys(options)) {
    if (!known.has(key)) {
      throw new AiBddError('CONFIG_INVALID', `unknown models option "${key}"`, { details: { key } });
    }
  }
  const models = {} as Record<ModelPurpose, string>;
  for (const purpose of PURPOSES) {
    const value = options[purpose];
    if (typeof value !== 'string' || value.length === 0) {
      throw new AiBddError('CONFIG_INVALID', `models option "${purpose}" must be a non-empty model id string`, {
        details: { key: purpose },
      });
    }
    models[purpose] = value;
  }
  const { maxRetries } = options;
  if (maxRetries !== undefined && (typeof maxRetries !== 'number' || !Number.isInteger(maxRetries) || maxRetries < 0)) {
    throw new AiBddError('CONFIG_INVALID', 'models option "maxRetries" must be a non-negative integer', {
      details: { key: 'maxRetries' },
    });
  }
  return aiSdkModels(models, maxRetries === undefined ? {} : { maxRetries });
}
