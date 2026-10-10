import type {
  Asserter, CheckGenRequest, CheckGenResult, CheckProgram, ChatModel, CreateAsserter, EvidenceStore, FuzzyReason, JsonObject,
  JsonValue, ModelMessage, NodeKey, ObservedNode, Observation, Predicate, PredicateResult, Redactor, ResolvedConfig, Usage,
} from '../contracts/index.ts';
import { AiBddError } from '../contracts/index.ts';
import { stableJson } from '../util/index.ts';
import { allSatisfied, evaluatePredicates } from './evaluate.ts';
import { lintDetailed } from './lint.ts';
import {
  CHECKGEN_PROMPT_VERSION, checkgenSystemPrompt, checkgenUserMessage, promptTree, renderVolatileKeys,
} from './prompt.ts';
import { checkgenJsonSchema, parseCheckgenOutput } from './schema.ts';

/**
 * Nodes whose name, text or value differs between the settled observation and the delayed probe.
 * Multiset comparison on (role, name, text, value) so reordering alone is not volatility. Linear time.
 */
export function computeVolatileNodes(after: Observation, probe: Observation): { keys: NodeKey[]; testIds: string[] } {
  const id = (n: ObservedNode): string => `${n.role}\u0000${n.name}\u0000${n.text ?? ''}\u0000${n.value ?? ''}`;
  const counts = new Map<string, number>();
  for (const n of after.nodes) counts.set(id(n), (counts.get(id(n)) ?? 0) + 1);
  const probeLeft = new Map(counts);
  const volatile: ObservedNode[] = [];
  for (const n of probe.nodes) {
    const k = id(n);
    const c = probeLeft.get(k) ?? 0;
    if (c > 0) probeLeft.set(k, c - 1);
    else volatile.push(n); // present in the probe but not (any more) in `after`
  }
  for (const n of after.nodes) {
    const k = id(n);
    const c = probeLeft.get(k) ?? 0;
    if (c > 0) {
      probeLeft.set(k, c - 1);
      volatile.push(n); // present in `after` but gone from the probe
    }
  }
  const seen = new Set<string>();
  const keys: NodeKey[] = [];
  const testIds = new Set<string>();
  for (const n of volatile) {
    const k = `${n.role}\u0000${n.name}`;
    if (!seen.has(k)) { seen.add(k); keys.push({ role: n.role, name: n.name }); }
    if (n.testId !== undefined) testIds.add(n.testId);
  }
  keys.sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { keys, testIds: [...testIds].sort() };
}

function describeFailures(results: readonly PredicateResult[]): string {
  const bad = results
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.satisfied !== true)
    .slice(0, 4)
    .map(({ r, i }) => `predicates[${i}] (${r.predicate.op}) ${r.satisfied === 'unknown' ? 'unknown' : 'false'}, actual ${JSON.stringify(r.actual ?? null)}`);
  return bad.join('; ');
}

function addUsage(u: Usage, add: { inputTokens: number; outputTokens: number }): void {
  u.modelCalls += 1;
  u.inputTokens += add.inputTokens;
  u.outputTokens += add.outputTokens;
}

type AttemptKind = 'volatile' | 'discriminative' | 'other';

async function storeEvidence(evidence: EvidenceStore | undefined, redactor: Redactor, payload: JsonObject): Promise<void> {
  if (!evidence) return;
  await evidence.putArtifact('checkgen', stableJson(redactor.redactJson(payload)));
}

export const createAsserter: CreateAsserter = (deps): Asserter => {
  const { model, redactor, config, evidence } = deps;
  return {
    evaluate(program, obs, params) {
      const results = evaluatePredicates(program.predicates, obs, params).map((r): PredicateResult => {
        if (r.actual === undefined) return r;
        return { ...r, actual: redactor.redactJson(r.actual) };
      });
      return { passed: allSatisfied(results), results };
    },
    generate: (req) => generate(model, redactor, config, evidence, req),
  };
};

async function generate(
  model: ChatModel, redactor: Redactor, config: ResolvedConfig, evidence: EvidenceStore | undefined, req: CheckGenRequest,
): Promise<CheckGenResult> {
  const maxAttempts = Math.max(1, config.checks.maxAttempts);
  const maxPredicates = config.checks.maxPredicates;
  const usage: Usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0 };
  const errors: string[] = [];
  const kinds: AttemptKind[] = [];
  const volatile = computeVolatileNodes(req.after, req.afterProbe);
  const criterion = redactor.redact(req.criterion);
  const params = redactor.redactJson(req.params as JsonObject) as Record<string, string>;
  const system = checkgenSystemPrompt(maxPredicates);
  const schema = checkgenJsonSchema();
  const messages: ModelMessage[] = [{
    role: 'user',
    content: [{
      type: 'text',
      text: checkgenUserMessage({
        criterion, params, actionPreceded: req.actionPreceded,
        volatileText: renderVolatileKeys(volatile.keys, redactor),
        beforeTree: promptTree(req.before, redactor), afterTree: promptTree(req.after, redactor),
      }),
    }],
  }];
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (req.signal?.aborted) throw new AiBddError('ABORTED', 'check generation aborted');
    attempts = attempt;
    const request = {
      purpose: 'checkgen' as const, system, messages: [...messages], output: { name: 'check_program', schema }, temperature: 0,
      context: { criterion, attempt, scenarioId: req.scenarioId, stepKey: req.stepKey },
      ...(req.signal ? { signal: req.signal } : {}),
    };
    let responseJson: JsonValue = null;
    let responseText = '';
    let modelId = model.id;
    const fail = (kind: AttemptKind, list: string[]): void => {
      kinds.push(kind);
      for (const e of list) errors.push(`attempt ${attempt}: ${e}`);
    };
    let attemptErrors: string[] = [];
    let attemptKind: AttemptKind = 'other';
    let program: CheckProgram | undefined;

    try {
      const res = await model.generate(request);
      addUsage(usage, res.usage);
      modelId = res.modelId || model.id;
      let raw: unknown = res.object;
      if (raw === undefined && typeof res.text === 'string') {
        try { raw = JSON.parse(res.text); } catch { raw = undefined; }
      }
      responseJson = (raw ?? null) as JsonValue;
      responseText = redactor.redact(typeof res.text === 'string' ? res.text : JSON.stringify(responseJson));
      if (raw === undefined || raw === null) {
        attemptErrors = [`the model returned no structured output (finish reason: ${res.finishReason})`];
      } else {
        const parsed = parseCheckgenOutput(raw);
        if (!parsed.ok) {
          attemptErrors = parsed.errors;
        } else {
          const candidate: CheckProgram = {
            classification: parsed.classification, predicates: parsed.predicates,
            generatedBy: { modelId, promptVersion: CHECKGEN_PROMPT_VERSION },
            verified: { afterTrue: true, probeTrue: true, beforeFalse: parsed.classification === 'change' ? true : null, judgePassed: false },
          };
          const outcome = verify(candidate, req, volatile, maxPredicates);
          if (outcome.errors.length === 0) program = candidate;
          else { attemptErrors = outcome.errors; attemptKind = outcome.kind; }
        }
      }
    } catch (err) {
      if (req.signal?.aborted || (err instanceof AiBddError && err.code === 'ABORTED')) throw err;
      attemptErrors = [`model call failed: ${err instanceof Error ? err.message : String(err)}`];
    }

    await storeEvidence(evidence, redactor, {
      attempt, scenarioId: req.scenarioId, stepKey: req.stepKey, promptVersion: CHECKGEN_PROMPT_VERSION, modelId,
      request: { purpose: 'checkgen', system, messages: messages as unknown as JsonValue, context: request.context, temperature: 0 },
      response: responseJson,
      outcome: program ? 'accepted' : 'rejected',
      errors: attemptErrors,
    });

    if (program) return { program, fuzzyReasons: [], attempts, usage, errors };
    fail(attemptKind, attemptErrors);
    messages.push({ role: 'assistant', content: [{ type: 'text', text: responseText }] });
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: `Your previous program was rejected:\n${attemptErrors.map((e) => `- ${e}`).join('\n')}\nReturn a corrected program.` }],
    });
  }

  const reasons: FuzzyReason[] = [];
  if (kinds.includes('volatile')) reasons.push('volatile-content');
  if (kinds.includes('discriminative')) reasons.push('check-not-discriminative');
  if (reasons.length === 0) reasons.push('check-generation-failed');
  return { fuzzyReasons: reasons, attempts, usage, errors };
}

/** Lint plus discriminative evaluation of a candidate (SPEC §10.4 steps 2-3). */
function verify(
  program: CheckProgram, req: CheckGenRequest, volatile: { keys: NodeKey[]; testIds: string[] }, maxPredicates: number,
): { errors: string[]; kind: AttemptKind } {
  const issues = lintDetailed(program, {
    stepText: req.criterion, params: req.params, volatileNodeKeys: volatile.keys, actionPreceded: req.actionPreceded, maxPredicates,
  });
  for (const [i, p] of program.predicates.entries()) {
    const tid = testIdOf(p);
    if (tid !== undefined && volatile.testIds.includes(tid)) {
      issues.push({ message: `predicates[${i}]: testId "${tid}" belongs to a node whose content changed between observations`, volatile: true });
    }
  }
  if (issues.length > 0) {
    return { errors: issues.map((i) => i.message), kind: issues.every((i) => i.volatile) ? 'volatile' : 'other' };
  }
  const onAfter = evaluatePredicates(program.predicates, req.after, req.params);
  if (!allSatisfied(onAfter)) {
    return { errors: [`the program is not satisfied on the AFTER observation: ${describeFailures(onAfter)}`], kind: 'other' };
  }
  const onProbe = evaluatePredicates(program.predicates, req.afterProbe, req.params);
  if (!allSatisfied(onProbe)) {
    return {
      errors: [`the program holds on AFTER but not on the later probe of the same page (content is unstable): ${describeFailures(onProbe)}`],
      kind: 'volatile',
    };
  }
  if (program.classification === 'change') {
    const onBefore = evaluatePredicates(program.predicates, req.before, req.params);
    if (allSatisfied(onBefore)) {
      return {
        errors: ['CHECK_NOT_DISCRIMINATIVE: a "change" program is already true on the BEFORE observation; it must be false before the action'],
        kind: 'discriminative',
      };
    }
  }
  return { errors: [], kind: 'other' };
}

function testIdOf(p: Predicate): string | undefined {
  if (p.op === 'route') return undefined;
  const t = p.query?.testId;
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}
