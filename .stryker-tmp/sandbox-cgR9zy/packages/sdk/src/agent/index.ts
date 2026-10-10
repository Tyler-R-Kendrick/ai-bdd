// @ts-nocheck
import { AiBddError } from '../contracts/index.ts';
import type {
  ActRequest, ActResult, Actor, AiBddErrorPayload, ArtifactRef, ContentPart, CreateActor, DriverAction,
  DriverSession, JsonObject, JsonValue, ModelMessage, ModelRequest, ModelResponse, Observation, ObservedNode, PerformedAction,
  ToolCall, Usage,
} from '../contracts/index.ts';
import { checkNavigation, normalizeText, renderTree, stableJson } from '../util/index.ts';
import { ACT_SYSTEM_PROMPT, buildHeader, observationParts, stepTextMentions } from './prompt.ts';
import { buildTools, COMPLETE_STEP, isVerb, parseVerbCall } from './tools.ts';
import type { ParsedCall } from './tools.ts';

export const ACT_PROMPT_VERSION = 'act-v1';
export { ACT_SYSTEM_PROMPT } from './prompt.ts';

const NOT_EXECUTED = 'not executed: observation changed; re-plan';

type ActorDeps = Parameters<CreateActor>[0];

export const createActor: CreateActor = (deps) => {
  const actor: Actor = { act: (req, session) => runAct(deps, req, session) };
  return actor;
};

// ───────────────────────── helpers

function errResult(code: string, message: string, extra?: JsonObject): JsonValue {
  return { ok: false, error: { code, message, ...(extra ?? {}) } };
}

function ancestorChain(node: ObservedNode, byRef: ReadonlyMap<string, ObservedNode>): ObservedNode[] {
  const out: ObservedNode[] = [];
  const seen = new Set<string>([node.ref]);
  let cur = node.parentRef === undefined ? undefined : byRef.get(node.parentRef);
  while (cur !== undefined && !seen.has(cur.ref)) {
    out.push(cur);
    seen.add(cur.ref);
    cur = cur.parentRef === undefined ? undefined : byRef.get(cur.parentRef);
  }
  return out;
}

function namedAncestorNames(node: ObservedNode, byRef: ReadonlyMap<string, ObservedNode>): string[] {
  return ancestorChain(node, byRef).filter((a) => a.name.trim() !== '').map((a) => a.name);
}

function addUsage(u: Usage, r: ModelResponse): void {
  u.modelCalls += 1;
  u.inputTokens += r.usage.inputTokens;
  u.outputTokens += r.usage.outputTokens;
}

function toolsNeedingTarget(verb: ParsedCall['verb']): boolean {
  return verb === 'click' || verb === 'fill' || verb === 'select' || verb === 'check' || verb === 'hover';
}

interface Ambiguity { candidates: { role: string; name: string; ancestors: string[] }[] }

/** R-AG2: deterministic target-ambiguity rule. Returns the candidates when the step must fail. */
function checkAmbiguity(
  target: ObservedNode,
  obs: Observation,
  byRef: ReadonlyMap<string, ObservedNode>,
  stepText: string,
): Ambiguity | undefined {
  const key = normalizeText(target.name);
  const group = obs.nodes.filter((n) => n.role === target.role && normalizeText(n.name) === key);
  if (group.length <= 1) return undefined;
  const others = group.filter((n) => n.ref !== target.ref);
  const otherAncestorRefs = others.map((o) => new Set(ancestorChain(o, byRef).map((a) => a.ref)));
  const named = ancestorChain(target, byRef).filter((a) => a.name.trim() !== '');
  const differentiating = named.filter((a) => !otherAncestorRefs.every((s) => s.has(a.ref)));
  if (differentiating.some((a) => stepTextMentions(stepText, a.name))) return undefined;
  return {
    candidates: group.map((n) => ({ role: n.role, name: n.name, ancestors: namedAncestorNames(n, byRef) })),
  };
}

function toDriverAction(call: ParsedCall, url?: string): DriverAction {
  switch (call.verb) {
    case 'navigate': return { verb: 'navigate', url: url ?? call.url };
    case 'click': return { verb: 'click', target: { ref: call.ref } };
    case 'hover': return { verb: 'hover', target: { ref: call.ref } };
    case 'fill': return { verb: 'fill', target: { ref: call.ref }, value: call.value };
    case 'press': return call.ref === undefined ? { verb: 'press', key: call.key } : { verb: 'press', key: call.key, target: { ref: call.ref } };
    case 'select': return { verb: 'select', target: { ref: call.ref }, option: { literal: call.option } };
    case 'check': return { verb: 'check', target: { ref: call.ref }, checked: call.checked };
    case 'scroll': return call.ref === undefined ? { verb: 'scroll', direction: call.direction } : { verb: 'scroll', direction: call.direction, target: { ref: call.ref } };
    case 'back': return { verb: 'back' };
    case 'wait': return { verb: 'wait', ms: call.ms };
  }
}

function refOf(call: ParsedCall): string | undefined {
  return 'ref' in call ? call.ref : undefined;
}

type ActionStep =
  | { kind: 'rejected'; result: JsonValue }
  | { kind: 'performed'; result: JsonValue }
  | { kind: 'fatal'; result: JsonValue; error: AiBddErrorPayload; summary: string };

interface Terminal { status: ActResult['status']; summary: string; error?: AiBddErrorPayload }

// ───────────────────────── main loop

async function runAct(deps: ActorDeps, req: ActRequest, session: DriverSession): Promise<ActResult> {
  const { model, redactor, settler, config, evidence } = deps;
  const caps = session.capabilities;
  const denied = new Set(config.policy.denyVerbs);
  const offered = new Set(caps.verbs.filter((v) => !denied.has(v)));
  const tools = buildTools(caps.verbs.filter((v) => offered.has(v)), config.agent.maxWaitMs);
  const header = buildHeader(
    {
      scenarioTitle: req.scenario.title, stepKind: req.step.kind, stepText: req.step.text, priorSteps: req.priorSteps,
      params: req.params, secretNames: req.secretNames, hints: req.hints, appContext: req.appContext,
    },
    redactor,
  );
  const headerParts: ContentPart[] = [{ type: 'text', text: header }];
  const settleOpts = { quietMs: config.settle.quietMs, intervalMs: config.settle.intervalMs, timeoutMs: config.settle.timeoutMs };
  const settleExtra = { pixels: caps.pixels, ...(req.signal === undefined ? {} : { signal: req.signal }) };

  const history: ModelMessage[] = [];
  const transcript: JsonObject[] = [];
  const performed: PerformedAction[] = [];
  const usage: Usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0 };
  let lastObs: Observation | undefined;
  let dirty = false;
  let emptyStreak = 0;
  let terminal: Terminal | undefined;
  let transcriptRef: ArtifactRef | undefined;

  const writeLog = async (entry: JsonObject): Promise<void> => {
    if (evidence === undefined) return;
    await evidence.putArtifact('action-log', stableJson(redactor.redactJson(entry)));
  };

  const throwIfAborted = (): void => {
    if (req.signal?.aborted === true) throw new AiBddError('ABORTED', 'act aborted');
  };

  try {
    for (let turn = 0; turn < config.agent.maxModelCalls && terminal === undefined; turn++) {
      throwIfAborted();
      const settled = await settler.settle(session, settleOpts, settleExtra);
      const obs = settled.observation;
      lastObs = obs;
      dirty = false;
      const byRef = new Map<string, ObservedNode>(obs.nodes.map((n) => [n.ref, n]));

      const treeText = /\[ref=/.test(obs.treeText) || obs.nodes.length === 0 ? obs.treeText : renderTree(obs.nodes, { refs: true });
      const { parts, screenshotIncluded } = observationParts(obs, {
        redactor, settled: settled.settled, maskingProven: caps.maskingProven, treeText,
      });
      const messages: ModelMessage[] = history.length === 0
        ? [{ role: 'user', content: [...headerParts, ...parts] }]
        : [{ role: 'user', content: headerParts }, ...history, { role: 'user', content: parts }];

      const context: JsonObject = {
        scenarioId: req.scenario.id,
        stepKey: req.step.key,
        stepText: redactor.redact(req.step.text),
        turn,
        route: redactor.redact(obs.route),
        nodes: obs.nodes.map((n) => ({
          ref: n.ref,
          role: n.role,
          name: redactor.redact(n.name),
          ancestors: namedAncestorNames(n, byRef).map((a) => redactor.redact(a)),
        })),
      };
      const request: ModelRequest = {
        purpose: 'act', system: ACT_SYSTEM_PROMPT, messages, tools, toolChoice: 'required', temperature: 0, context,
        ...(req.signal === undefined ? {} : { signal: req.signal }),
      };
      const entry: JsonObject = {
        turn, route: obs.route, treeHash: obs.treeHash, tainted: obs.tainted, settled: settled.settled,
        screenshot: screenshotIncluded ? (obs.screenshot?.sha256 ?? null) : null, nodes: obs.nodes.length,
      };
      transcript.push(entry);

      let response: ModelResponse;
      try {
        response = await model.generate(request);
      } catch (err) {
        entry['modelError'] = err instanceof Error ? err.message : String(err);
        throw err;
      }
      addUsage(usage, response);
      throwIfAborted();
      entry['text'] = response.text ?? null;
      entry['toolCalls'] = response.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args }));

      // ── execute tool calls
      const results: { call: ToolCall; result: JsonValue }[] = [];
      let executed = false;
      for (const call of response.toolCalls) {
        if (terminal !== undefined) {
          results.push({ call, result: errResult('NOT_EXECUTED', 'not executed: step already ended') });
          continue;
        }
        if (call.name === COMPLETE_STEP) {
          if (executed) {
            results.push({ call, result: NOT_EXECUTED });
            continue;
          }
          const status = call.args['status'];
          const summary = typeof call.args['summary'] === 'string' ? call.args['summary'] : '';
          if (status !== 'done' && status !== 'blocked') {
            results.push({ call, result: errResult('MODEL_OUTPUT_INVALID', 'complete_step requires status "done" or "blocked"') });
            continue;
          }
          const clean = redactor.redact(summary);
          terminal = status === 'done'
            ? { status: 'done', summary: clean }
            : {
              status: 'blocked', summary: clean,
              error: new AiBddError('ACT_BLOCKED', `step blocked: ${clean}`, { details: { summary: clean } }).toPayload(),
            };
          results.push({ call, result: { ok: true } });
          continue;
        }
        if (executed) {
          results.push({ call, result: NOT_EXECUTED });
          continue;
        }
        const step = await handleAction(call, turn);
        results.push({ call, result: step.result });
        if (step.kind === 'performed') {
          executed = true;
          dirty = true;
        } else if (step.kind === 'fatal') {
          terminal = { status: 'failed', summary: step.summary, error: step.error };
        }
      }
      entry['toolResults'] = results.map((r) => ({ id: r.call.id, result: r.result }));

      history.push({
        role: 'assistant',
        content: [{ type: 'text', text: redactor.redact(response.text ?? '') }],
        ...(response.toolCalls.length === 0
          ? {}
          : { toolCalls: response.toolCalls.map((c) => ({ id: c.id, name: c.name, args: redactor.redactJson(c.args) })) }),
      });
      for (const r of results) {
        history.push({ role: 'tool', toolCallId: r.call.id, toolName: r.call.name, result: redactor.redactJson(r.result) });
      }

      if (terminal !== undefined) break;
      if (response.toolCalls.length === 0) {
        emptyStreak += 1;
        if (emptyStreak >= 2) {
          terminal = {
            status: 'failed',
            summary: 'model produced no tool call in 2 consecutive turns',
            error: new AiBddError('MODEL_OUTPUT_INVALID', 'model produced no tool call in 2 consecutive turns', {
              details: { turns: turn + 1 },
            }).toPayload(),
          };
        }
      } else {
        emptyStreak = 0;
      }
    }

    if (terminal === undefined) {
      const m = `model-call budget exhausted (${config.agent.maxModelCalls} calls, ${performed.length} actions)`;
      terminal = {
        status: 'failed', summary: m,
        error: new AiBddError('ACT_BUDGET_EXHAUSTED', m, {
          details: { maxModelCalls: config.agent.maxModelCalls, maxActions: config.agent.maxActions, actions: performed.length, modelCalls: usage.modelCalls },
        }).toPayload(),
      };
    }
  } catch (err) {
    transcript.push({ error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    if (evidence !== undefined) {
      const body: JsonObject = { promptVersion: ACT_PROMPT_VERSION, scenarioId: req.scenario.id, stepKey: req.step.key, turns: transcript };
      transcriptRef = await evidence.putArtifact('act-transcript', stableJson(redactor.redactJson(body)));
    }
  }

  let finalObservation = lastObs;
  if (finalObservation === undefined) {
    // maxModelCalls <= 0: still hand back a current observation.
    finalObservation = (await settler.settle(session, settleOpts, settleExtra)).observation;
  } else if (dirty) {
    finalObservation = (await settler.settle(session, settleOpts, settleExtra)).observation;
  }
  const result: ActResult = {
    status: terminal.status, actions: performed, finalObservation, summary: terminal.summary, usage,
    ...(terminal.error === undefined ? {} : { error: terminal.error }),
    ...(transcriptRef === undefined ? {} : { transcript: transcriptRef }),
  };
  return result;

  // ───────────────────────── one action tool call
  async function handleAction(call: ToolCall, turn: number): Promise<ActionStep> {
    const obs = lastObs as Observation;
    const reject = (code: string, message: string, extra?: JsonObject): ActionStep => ({ kind: 'rejected', result: errResult(code, message, extra) });
    const name = call.name;

    if (!isVerb(name)) return reject('VERB_UNSUPPORTED', `unknown tool ${name}`);
    if (denied.has(name)) return reject('POLICY_DENIED', `verb ${name} is denied by policy`);
    if (!offered.has(name)) return reject('VERB_UNSUPPORTED', `verb ${name} is not supported by this driver`);

    const parsed = parseVerbCall(name, call.args, config.agent.maxWaitMs);
    if (!parsed.ok) return reject('MODEL_OUTPUT_INVALID', parsed.message);
    const pc = parsed.call;

    if (pc.verb === 'fill') {
      if ('param' in pc.value && !Object.hasOwn(req.params, pc.value.param)) {
        return reject('MODEL_OUTPUT_INVALID', `unknown param ${JSON.stringify(pc.value.param)}`, { params: Object.keys(req.params) });
      }
      if ('secret' in pc.value && !req.secretNames.includes(pc.value.secret)) {
        return reject('MODEL_OUTPUT_INVALID', `unknown secret ${JSON.stringify(pc.value.secret)}`, { secrets: req.secretNames });
      }
    }

    let url: string | undefined;
    if (pc.verb === 'navigate') {
      const nav = checkNavigation(pc.url, config.baseURL, config.policy);
      if (!nav.ok) return reject('POLICY_DENIED', `navigation denied: ${nav.reason}`);
      url = nav.url;
    }

    const byRef = new Map<string, ObservedNode>(obs.nodes.map((n) => [n.ref, n]));
    const ref = refOf(pc);
    let target: ObservedNode | undefined;
    if (ref !== undefined) {
      target = byRef.get(ref);
      if (target === undefined) return reject('STALE_REF', `ref ${JSON.stringify(ref)} is not in the latest observation; use a ref from it`);
    }

    if (target !== undefined && toolsNeedingTarget(pc.verb)) {
      const amb = checkAmbiguity(target, obs, byRef, req.step.text);
      if (amb !== undefined) {
        const candidates: JsonValue = amb.candidates.map((c) => ({ role: c.role, name: c.name, ancestors: c.ancestors }));
        const message = `target ${target.role} ${JSON.stringify(target.name)} is ambiguous (${amb.candidates.length} candidates) and the step text does not say which`;
        const safeCandidates = redactor.redactJson(candidates);
        return {
          kind: 'fatal',
          result: errResult('ACT_TARGET_AMBIGUOUS', message, { candidates: safeCandidates }),
          summary: redactor.redact(message),
          error: new AiBddError('ACT_TARGET_AMBIGUOUS', redactor.redact(message), {
            details: { verb: pc.verb, target: { role: target.role, name: redactor.redact(target.name) }, candidates: safeCandidates },
          }).toPayload(),
        };
      }
    }

    if (performed.length >= config.agent.maxActions) {
      const m = `action budget exhausted (${config.agent.maxActions} actions)`;
      return {
        kind: 'fatal', result: errResult('ACT_BUDGET_EXHAUSTED', m), summary: m,
        error: new AiBddError('ACT_BUDGET_EXHAUSTED', m, {
          details: { maxModelCalls: config.agent.maxModelCalls, maxActions: config.agent.maxActions, actions: performed.length, modelCalls: usage.modelCalls },
        }).toPayload(),
      };
    }

    const action = toDriverAction(pc, url);
    const seq = performed.length;
    // Write-ahead: the intent is durable before the driver is touched.
    await writeLog({
      phase: 'intent', scenarioId: req.scenario.id, stepKey: req.step.key, turn, seq, toolCallId: call.id, action: action as unknown as JsonObject,
      ...(target === undefined ? {} : { target: { role: target.role, name: target.name } }),
    });
    const outcome = await session.perform(action);
    performed.push({ action, ...(target === undefined ? {} : { target }), chosenFrom: obs, outcome });
    await writeLog({
      phase: 'outcome', scenarioId: req.scenario.id, stepKey: req.step.key, turn, seq, toolCallId: call.id, ok: outcome.ok,
      ...(outcome.error === undefined ? {} : { error: outcome.error as unknown as JsonObject }),
      ...(outcome.navigatedTo === undefined ? {} : { navigatedTo: outcome.navigatedTo }),
    });
    if (!outcome.ok) {
      const e = outcome.error;
      return {
        kind: 'performed',
        result: errResult(e?.code ?? 'DRIVER_ERROR', redactor.redact(e?.message ?? 'action failed'), { performed: true }),
      };
    }
    return {
      kind: 'performed',
      result: { ok: true, performed: name, note: 'A fresh observation follows next turn.', ...(outcome.navigatedTo === undefined ? {} : { navigatedTo: redactor.redact(outcome.navigatedTo) }) },
    };
  }
}
