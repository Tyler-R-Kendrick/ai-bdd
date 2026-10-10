// @ts-nocheck
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AiBddError,
  type ChatModel,
  type JsonObject,
  type JsonValue,
  type ModelMessage,
  type ModelPurpose,
  type ModelRequest,
  type ModelResponse,
  type ModelSet,
} from '@ai-bdd/sdk/contracts';
import { canonicalJson, sha256Hex } from '@ai-bdd/sdk';
import { loadRuleFiles } from './load.ts';
import { ruleMatches } from './match.ts';
import { produce } from './respond.ts';
import { validateFakeRuleFile } from './schema.ts';
import type { FakeCall, FakeModelOptions, FakeRule } from './types.ts';

export type { FakeCall, FakeMatcher, FakeModelOptions, FakeRespond, FakeRule, FakeRuleFile, FakeRuleFileInput, FakeScriptStep, FakeTarget } from './types.ts';
export { FAKE_RULE_FILE_JSON_SCHEMA, validateFakeRuleFile } from './schema.ts';
export { loadRuleFiles } from './load.ts';

const PURPOSES: readonly ModelPurpose[] = ['extract', 'act', 'checkgen', 'judge'];

const tokens = (chars: number): number => Math.ceil(chars / 4);

/** Characters of everything the model would read from the request: system prompt and messages (never `context`, never image bytes). */
function inputChars(req: ModelRequest): number {
  let n = req.system.length;
  for (const m of req.messages) {
    if (m.role === 'tool') {
      n += canonicalJson(m.result).length;
      continue;
    }
    for (const part of m.content) if (part.type === 'text') n += part.text.length;
    if (m.role === 'assistant' && m.toolCalls) n += canonicalJson(m.toolCalls as unknown as JsonValue).length;
  }
  return n;
}

function loggedMessage(m: ModelMessage): JsonObject {
  if (m.role === 'tool') return { role: 'tool', toolCallId: m.toolCallId, toolName: m.toolName, result: m.result };
  const content = m.content.map((p): JsonObject =>
    p.type === 'text' ? { type: 'text', text: p.text } : { image: p.sha256 || sha256Hex(p.png) },
  );
  const out: JsonObject = { role: m.role, content };
  if (m.role === 'assistant' && m.toolCalls) out['toolCalls'] = m.toolCalls as unknown as JsonValue;
  return out;
}

function loggedRequest(req: ModelRequest): JsonObject {
  return { purpose: req.purpose, system: req.system, messages: req.messages.map(loggedMessage), context: req.context };
}

/**
 * Deterministic rule-driven models for tests (spec section 13.3). All four purposes share one rule table
 * and one call log; model ids are `fake:<purpose>`.
 *
 * Rule order: `opts.rules` files in the given order, then `opts.rulesDir` files in file-name order.
 */
export function createFakeModels(opts: FakeModelOptions = {}): ModelSet & { calls: FakeCall[] } {
  const rules: FakeRule[] = [];
  (opts.rules ?? []).forEach((f, i) => rules.push(...validateFakeRuleFile(f, `rules[${i}]`).rules));
  if (opts.rulesDir !== undefined) for (const f of loadRuleFiles(opts.rulesDir)) rules.push(...f.rules);
  const logPath = opts.logPath;
  if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  const calls: FakeCall[] = [];

  const make = (purpose: ModelPurpose): ChatModel => ({
    id: `fake:${purpose}`,
    async generate(req: ModelRequest): Promise<ModelResponse> {
      if (req.signal?.aborted) throw new AiBddError('ABORTED', 'Fake model call aborted');
      const rule = rules.find((r) => ruleMatches(r, purpose, req.context));
      if (!rule) {
        throw new AiBddError('MODEL_NO_RULE', `No fake model rule matches a "${purpose}" request (${rules.length} rules loaded)`, {
          details: { purpose, context: req.context },
        });
      }
      const out = produce(rule.respond, { purpose, context: req.context, rule });
      const body: JsonObject = { toolCalls: out.toolCalls as unknown as JsonValue };
      if (out.text !== undefined) body['text'] = out.text;
      if (out.object !== undefined) body['object'] = out.object;
      const response: ModelResponse = {
        toolCalls: out.toolCalls,
        usage: { inputTokens: tokens(inputChars(req)), outputTokens: tokens(canonicalJson(body).length) },
        finishReason: out.toolCalls.length > 0 ? 'tool-calls' : 'stop',
        modelId: `fake:${purpose}`,
      };
      if (out.text !== undefined) response.text = out.text;
      if (out.object !== undefined) response.object = out.object;
      const call: FakeCall = {
        purpose,
        request: loggedRequest(req),
        response: JSON.parse(JSON.stringify(response)) as JsonObject,
        ruleId: rule.id,
      };
      calls.push(call);
      if (logPath) appendFileSync(logPath, `${canonicalJson(call as unknown as JsonObject)}\n`);
      return response;
    },
  });

  const models = Object.fromEntries(PURPOSES.map((p) => [p, make(p)])) as unknown as ModelSet;
  return Object.assign(models, { calls });
}
