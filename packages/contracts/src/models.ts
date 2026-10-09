import type { JsonValue } from './primitives.js';

/** Purposes a model call can have. Used for routing, logging and cost accounting. */
export type ModelPurpose =
  | 'act'
  | 'extract'
  | 'checkgen'
  | 'judge'
  | 'grounding'
  | 'lint'
  | 'heal';

export interface ImageInput {
  /** Artifact sha256, when the image is already in the evidence store. */
  ref?: string;
  base64?: string;
  mediaType: string;
  width?: number;
  height?: number;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: ImageInput[];
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  parameters: JsonValue;
}

export interface ToolCall {
  name: string;
  args: JsonValue;
}

export interface GenerateRequest {
  purpose: ModelPurpose;
  messages: ModelMessage[];
  tools?: ToolSpec[];
  /** When set, the model must answer with a JSON object matching this schema. */
  schema?: JsonValue;
  temperature?: number;
  seed?: number;
  maxOutputTokens?: number;
  /** Overrides the default model for the purpose (used by judge/act separation). */
  modelId?: string;
  /** Correlation id, echoed into usage logs. */
  traceId?: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  calls?: number;
}

export interface GenerateResult {
  text?: string;
  object?: JsonValue;
  toolCalls?: ToolCall[];
  usage: ModelUsage;
  modelId: string;
  finishReason?: string;
}

/** The only model interface ai-bdd depends on. */
export interface ChatModel {
  id: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

export interface Embedder {
  id: string;
  dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface GroundingCandidate {
  score: number;
  candidate: JsonValue;
}

export interface GroundingScorer {
  id: string;
  score(input: { instruction: string; observationText: string; candidates: JsonValue[] }): Promise<GroundingCandidate[]>;
}

export interface ModelSet {
  act: ChatModel;
  judge: ChatModel;
  extract: ChatModel;
  checkgen: ChatModel;
  embed: Embedder;
  grounding?: GroundingScorer;
}

export interface PriceTable {
  [modelId: string]: { inputPer1k: number; outputPer1k: number };
}

export interface CostSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  byPurpose: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
  estimatedUsd?: number;
}
