// @ts-nocheck
import { AiBddError, type JsonObject, type JsonValue, type ToolCall } from '@ai-bdd/sdk/contracts';
import { canonicalJson, normalizeText, sha256Hex } from '@ai-bdd/sdk';
import type { FakeRespond, FakeRule, FakeScriptStep, FakeTarget } from './types.ts';

/** What a rule produced for one request, before usage and finish reason are attached. */
export type Produced = { text?: string; object?: JsonValue; toolCalls: ToolCall[] };

type Ctx = { purpose: string; context: JsonObject; rule: FakeRule };

function noRule(msg: string, c: Ctx, extra: JsonObject = {}): AiBddError {
  return new AiBddError('MODEL_NO_RULE', msg, { details: { purpose: c.purpose, context: c.context, rule: c.rule.id, ...extra } });
}

const asInt = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : dflt);

interface CtxNode { ref: string; role: string; name: string; ancestors: string[] }

function contextNodes(context: JsonObject): CtxNode[] {
  const raw = context['nodes'];
  if (!Array.isArray(raw)) return [];
  const out: CtxNode[] = [];
  for (const n of raw) {
    if (n === null || typeof n !== 'object' || Array.isArray(n)) continue;
    const { ref, role, name, ancestors } = n as { [k: string]: JsonValue };
    if (typeof ref !== 'string' || typeof role !== 'string') continue;
    out.push({
      ref,
      role,
      name: typeof name === 'string' ? name : '',
      ancestors: Array.isArray(ancestors) ? ancestors.filter((a): a is string => typeof a === 'string') : [],
    });
  }
  return out;
}

/** First node (document order) with equal role and name; with `within`, one whose ancestors include that name. */
function resolveTarget(target: FakeTarget, c: Ctx): string {
  const wantName = target.name === undefined ? undefined : normalizeText(target.name);
  const within = target.within === undefined ? undefined : normalizeText(target.within);
  const hit = contextNodes(c.context).find(
    (n) =>
      n.role === target.role &&
      (wantName === undefined || normalizeText(n.name) === wantName) &&
      (within === undefined || n.ancestors.some((a) => normalizeText(a) === within)),
  );
  if (!hit) {
    throw noRule(
      `Fake rule "${c.rule.id}": target ${JSON.stringify(target)} matches no node in context.nodes (act purpose, turn ${asInt(c.context['turn'], 0)})`,
      c,
      { target: target as unknown as JsonObject },
    );
  }
  return hit.ref;
}

function scriptCall(step: FakeScriptStep, turn: number, c: Ctx): ToolCall {
  const { target, ...rest } = (step.args ?? {}) as JsonObject;
  const args: JsonObject = { ...rest };
  if (target !== undefined) args['ref'] = resolveTarget(target as unknown as FakeTarget, c);
  const id = `call_${sha256Hex(canonicalJson({ rule: c.rule.id, turn, tool: step.tool, args })).slice(0, 12)}`;
  return { id, name: step.tool, args };
}

export const DONE_SUMMARY = 'Scripted steps complete.';

export function produce(respond: FakeRespond, c: Ctx): Produced {
  if ('object' in respond) return { object: structuredClone(respond.object), toolCalls: [] };
  if ('text' in respond) return { text: respond.text, toolCalls: [] };
  if ('samples' in respond) {
    const n = respond.samples.length;
    const i = ((asInt(c.context['sample'], 0) % n) + n) % n;
    return { object: structuredClone(respond.samples[i] as JsonValue), toolCalls: [] };
  }
  if ('byAttempt' in respond) {
    const i = Math.max(0, Math.min(asInt(c.context['attempt'], 1) - 1, respond.byAttempt.length - 1));
    return produce(respond.byAttempt[i] as FakeRespond, c);
  }
  const turn = Math.max(0, asInt(c.context['turn'], 0));
  const step = respond.script[turn];
  const call: ToolCall = step
    ? scriptCall(step, turn, c)
    : scriptCall({ tool: 'complete_step', args: { status: 'done', summary: DONE_SUMMARY } }, turn, c);
  return { toolCalls: [call] };
}
