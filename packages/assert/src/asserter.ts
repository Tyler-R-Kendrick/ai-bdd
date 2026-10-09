import type {
  AssertOutcome,
  AssertionMode,
  ChatModel,
  CheckPredicate,
  CheckProgram,
  JsonValue,
  JudgeRequest,
  JudgeVerdict,
  Observation,
  PredicateResult,
  StepOptions,
} from '@ai-bdd/contracts';
import { AiBddError } from '@ai-bdd/contracts';
import { allSatisfied, anyUnknown, evaluatePredicates } from './evaluate.js';
import { lintCheckProgram } from './lint.js';

export interface CheckCacheReader {
  getCheck(key: string): Promise<{ program: CheckProgram; invalidation: Array<{ strategy: string; result: string }> } | null>;
  putCheck(program: CheckProgram, ctx: unknown): Promise<void>;
}

export interface AsserterDependencies {
  model: ChatModel;
  judge: { judge(request: JudgeRequest): Promise<JudgeVerdict> };
  cache: CheckCacheReader;
  config: { mode: AssertionMode; requireDeterministic: boolean; checkGen: { maxAttempts: number } };
  driver: { id: string; major: number; nativePredicates: boolean };
  params?: Record<string, JsonValue>;
  context?: string;
  cacheMode?: 'read-write' | 'read-only' | 'off';
  now?: () => Date;
}

export interface AssertWindow {
  before: Observation;
  after: Observation;
  actionPreceded: boolean;
  beforeTree: string;
  afterTree: string;
  key: string;
}

export interface Asserter {
  assert(step: { id: string; text: string; options: StepOptions }, window: AssertWindow): Promise<AssertOutcome>;
  pending(): Promise<void>;
}

/**
 * The assertion engine (section 8.3, R-K9, R-K10).
 *
 * A generated CheckProgram is accepted only when it is discriminative: satisfied
 * on the after observation, unsatisfied on the before observation, and the judge
 * passes in the same run. An `invariant` criterion (state that did not change) is
 * accepted when satisfied on after and flagged. When nothing discriminative can
 * be generated the step runs judge-only and is flagged (or fails under
 * `assertions.requireDeterministic`).
 */
export function createAsserter(deps: AsserterDependencies): Asserter {
  const now = deps.now ?? (() => new Date());
  const pendingPrograms: Array<{ program: CheckProgram; ctx: unknown }> = [];

  async function judgeWindow(step: { text: string; options: StepOptions }, window: AssertWindow): Promise<JudgeVerdict> {
    return deps.judge.judge({
      criterion: step.text,
      actionPreceded: window.actionPreceded,
      beforeImages: window.before.screenshot && !window.before.tainted ? [{ ref: window.before.screenshot.sha256, mediaType: 'image/png' }] : [],
      afterImages: window.after.screenshot && !window.after.tainted ? [{ ref: window.after.screenshot.sha256, mediaType: 'image/png' }] : [],
      beforeTrees: [truncate(window.beforeTree)],
      afterTrees: [truncate(window.afterTree)],
      ...(deps.context !== undefined ? { context: deps.context } : {}),
      ...(deps.params !== undefined ? { params: deps.params } : {}),
      driver: deps.driver.id,
    });
  }

  return {
    async assert(step, window): Promise<AssertOutcome> {
      const mode = step.options.mode ?? deps.config.mode;
      const config = deps.config;
      const params = deps.params ?? {};
      let judgeOnly = false;
      let attempts = 0;
      let generated = false;
      let checkResult: AssertOutcome['check'];
      let program: CheckProgram | null = null;

      if (mode === 'check' || mode === 'both' || mode === 'auto') {
        const cached = deps.cacheMode === 'off' ? null : await deps.cache.getCheck(window.key);
        if (cached) {
          program = cached.program;
        } else {
          for (let attempt = 0; attempt < Math.max(1, config.checkGen.maxAttempts); attempt += 1) {
            attempts += 1;
            const candidate = await generateCheckProgram({
              model: deps.model,
              criterion: step.text,
              before: window.before,
              after: window.after,
              key: window.key,
              driver: deps.driver.id,
              driverMajor: deps.driver.major,
              attempt,
            });
            const lints = lintCheckProgram(candidate.program, params);
            if (lints.length > 0) continue;
            const afterResults = evaluatePredicates(candidate.program.predicates, window.after, params);
            const beforeResults = evaluatePredicates(candidate.program.predicates, window.before, params);
            const discriminative = allSatisfied(afterResults) && !allSatisfied(beforeResults);
            const invariant = candidate.classification === 'invariant' && allSatisfied(afterResults);
            if (discriminative || invariant) {
              program = candidate.program;
              generated = true;
              checkResult = {
                programKey: program.key,
                results: afterResults,
                status: 'passed',
                ...(invariant ? { invariant: true } : {}),
                generated: true,
                attempts,
              };
              break;
            }
          }
        }
      }

      if (program) {
        const results: PredicateResult[] = evaluatePredicates(program.predicates, window.after, params);
        const satisfied = allSatisfied(results);
        checkResult = {
          programKey: program.key,
          results,
          status: satisfied ? 'passed' : 'failed',
          ...(program.invariant ? { invariant: true } : {}),
          ...(generated ? { generated: true, attempts } : {}),
        };
        if (!satisfied) {
          if (mode === 'check') {
            return { status: 'failed', check: checkResult, error: { code: 'CHECK_FAILED', message: firstFailure(results), retryable: false } };
          }
        }
      } else if (mode === 'check') {
        return {
          status: 'failed',
          error: {
            code: 'CHECK_GENERATION_FAILED',
            message: 'no discriminative check program could be generated',
            retryable: false,
          },
        };
      } else if (mode === 'auto' || mode === 'judge' || mode === 'both') {
        if (config.requireDeterministic && mode === 'auto') {
          return {
            status: 'failed',
            error: {
              code: 'CHECK_GENERATION_FAILED',
              message: 'assertions.requireDeterministic is set and no discriminative check could be generated',
              retryable: false,
            },
          };
        }
        judgeOnly = true;
      }

      const runJudge = mode === 'judge' || mode === 'both' || mode === 'auto';
      const verdict = runJudge ? await judgeWindow(step, window) : undefined;
      const judgePasses = verdict?.verdict === 'pass';
      const checkPasses = checkResult === undefined ? true : checkResult.status === 'passed';
      if (!runJudge && checkResult) {
        return {
          status: checkPasses ? 'passed' : 'failed',
          check: checkResult,
          ...(checkPasses ? {} : { error: { code: 'CHECK_FAILED', message: firstFailure(checkResult.results), retryable: false } }),
        };
      }
      const status = checkPasses && judgePasses ? 'passed' : 'failed';
      const effectiveCheck =
        checkResult !== undefined
          ? { ...checkResult, ...(judgeOnly ? { judgeOnly: true } : {}) }
          : judgeOnly
            ? { results: [], status: 'skipped' as const, judgeOnly: true }
            : undefined;
      const outcome: AssertOutcome = {
        status,
        ...(effectiveCheck !== undefined ? { check: effectiveCheck } : {}),
        ...(verdict !== undefined ? { judge: verdict } : {}),
        ...(status === 'failed' && !judgePasses
          ? {
              error: {
                code: verdict?.verdict === 'fail' ? 'JUDGE_FAILED' : 'JUDGE_INCONCLUSIVE',
                message: verdict?.reason ?? `the judge scored ${verdict?.score ?? 0}`,
                retryable: false,
              },
            }
          : status === 'failed'
            ? { error: { code: 'CHECK_FAILED', message: firstFailure(checkResult?.results ?? []), retryable: false } }
            : {}),
      };

      if (program && generated && status === 'passed' && deps.cacheMode !== 'read-only' && deps.cacheMode !== 'off') {
        pendingPrograms.push({ program: { ...program, verified: true }, ctx: { observation: window.after, driver: deps.driver.id, driverMajor: deps.driver.major, stepText: step.text, params } });
      }
      return outcome;
    },

    async pending(): Promise<void> {
      while (pendingPrograms.length > 0) {
        const item = pendingPrograms.shift()!;
        await deps.cache.putCheck(item.program, item.ctx);
      }
    },
  };

  function truncate(text: string): string {
    return text.length > 20000 ? `${text.slice(0, 20000)}…` : text;
  }
}

function firstFailure(results: PredicateResult[]): string {
  const failed = results.find((result) => result.result !== 'satisfied');
  if (!failed) return 'a deterministic check predicate was not satisfied';
  return `predicate ${failed.predicate.kind} was ${failed.result}${failed.detail ? `: ${failed.detail}` : ''}`;
}

export interface GenerateCheckOptions {
  model: ChatModel;
  criterion: string;
  before: Observation;
  after: Observation;
  key: string;
  driver: string;
  driverMajor: number;
  attempt?: number;
}

/** Asks the model for a declarative predicate set (never arbitrary code). */
export async function generateCheckProgram(
  options: GenerateCheckOptions,
): Promise<{ program: CheckProgram; classification: 'change' | 'invariant' }> {
  const result = await options.model.generate({
    purpose: 'checkgen',
    temperature: 0,
    seed: options.attempt ?? 0,
    schema: { type: 'object' } as JsonValue,
    messages: [
      {
        role: 'system',
        content: [
          'Generate a check program that decides one acceptance criterion from a single observation.',
          'Answer with JSON: { "classification": "change"|"invariant", "predicates": Predicate[] }.',
          'Predicate kinds: exists, notExists, visible, textEquals, textContains, textMatches, count, routeMatches.',
          'A predicate is a selector plus, where needed, a value or regex.',
          'Use textContains with a role selector when the exact badge text varies.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Criterion: ${options.criterion}`,
          'AFTER OBSERVATION (untrusted):',
          describe(options.after),
          'BEFORE OBSERVATION (untrusted):',
          describe(options.before),
        ].join('\n'),
      },
    ],
  });

  const object = (result.object ?? {}) as { classification?: 'change' | 'invariant'; predicates?: CheckPredicate[] };
  if (!Array.isArray(object.predicates) || object.predicates.length === 0) {
    throw new AiBddError('MODEL_OUTPUT_INVALID', 'the check generator returned no predicates');
  }
  const program: CheckProgram = {
    version: 1,
    key: options.key,
    text: options.criterion,
    driver: options.driver,
    driverMajor: options.driverMajor,
    predicates: object.predicates,
    classification: object.classification ?? 'change',
    ...(object.classification === 'invariant' ? { invariant: true } : {}),
    generatedBy: options.model.id,
  };
  return { program, classification: object.classification ?? 'change' };
}

export function describe(observation: Observation): string {
  const lines: string[] = [];
  const walk = (nodes: Observation['nodes'], depth: number): void => {
    for (const node of nodes) {
      lines.push(`${'  '.repeat(depth)}${node.role} "${node.name}"${node.testId ? ` #${node.testId}` : ''}`);
      if (node.children) walk(node.children, depth + 1);
    }
  };
  walk(observation.nodes, 0);
  lines.push(`route: ${observation.route ?? ''}`);
  return lines.join('\n');
}

export { anyUnknown };
