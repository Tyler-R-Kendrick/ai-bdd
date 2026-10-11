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
import {
  cursorsFor,
  createRecorder,
  decide,
  hang,
  validateModelPlan,
  type ChaosEvent,
  type ChaosOptions,
  type ModelFault,
  type ModelFaultPlan,
} from './plan.ts';
import { seededRandom, type SeededRandom } from './random.ts';

const PURPOSES: readonly ModelPurpose[] = ['extract', 'act', 'checkgen', 'judge'];

export interface ChaosModelStats {
  /** Calls that reached the wrapper, per purpose. */
  readonly calls: Record<ModelPurpose, number>;
  /** Injections per purpose. */
  readonly faults: Record<ModelPurpose, number>;
  virtualDelayMs(): number;
}

export type ChaosModelSet = ModelSet & {
  readonly plan: ModelFaultPlan;
  /** The plan's seed as text: print it when a chaos test fails. */
  readonly seed: string;
  readonly events: readonly ChaosEvent[];
  readonly stats: ChaosModelStats;
};

const isPlainObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A response whose structured output was damaged so that no schema accepts it (never merely "extra" content). */
function invalidShape(res: ModelResponse, rng: SeededRandom): ModelResponse {
  const out: ModelResponse = { ...res };
  if (isPlainObject(res.object)) {
    const keys = Object.keys(res.object);
    const variant = keys.length === 0 ? 'root-array' : rng.pick(['wrong-type', 'wrong-type', 'root-array', 'root-number']);
    if (variant === 'wrong-type') out.object = { ...res.object, [rng.pick(keys)]: { chaos: true } };
    else if (variant === 'root-array') out.object = [];
    else out.object = 42;
    return out;
  }
  if (res.toolCalls.length > 0) {
    out.toolCalls = res.toolCalls.map((c) => ({ ...c, args: { ref: 12345, value: { chaos: true }, url: null } }));
    return out;
  }
  out.object = { chaos: true };
  return out;
}

/** Add `chars` characters to the first string found in the answer (or to the text), so everything else stays valid. */
function oversize(res: ModelResponse, chars: number, where: 'text' | 'object' | undefined): ModelResponse {
  const pad = 'x'.repeat(chars);
  const out: ModelResponse = { ...res, usage: { ...res.usage, outputTokens: res.usage.outputTokens + Math.ceil(chars / 4) } };
  const grow = (v: JsonValue): { value: JsonValue; done: boolean } => {
    if (typeof v === 'string') return { value: v + pad, done: true };
    if (Array.isArray(v)) {
      const next = [...v];
      for (let i = 0; i < next.length; i += 1) {
        const r = grow(next[i] as JsonValue);
        if (r.done) {
          next[i] = r.value;
          return { value: next, done: true };
        }
      }
      return { value: v, done: false };
    }
    if (isPlainObject(v)) {
      const next: JsonObject = { ...v };
      for (const k of Object.keys(next)) {
        const r = grow(next[k] as JsonValue);
        if (r.done) {
          next[k] = r.value;
          return { value: next, done: true };
        }
      }
    }
    return { value: v, done: false };
  };
  if ((where ?? (res.object !== undefined ? 'object' : 'text')) === 'object' && res.object !== undefined) {
    const grown = grow(res.object);
    out.object = grown.done ? grown.value : isPlainObject(res.object) ? { ...res.object, chaosPadding: pad } : res.object;
    return out;
  }
  out.text = (res.text ?? '') + pad;
  return out;
}

const sourceText = (res: ModelResponse): string =>
  res.object !== undefined ? JSON.stringify(res.object) : (res.text ?? (res.toolCalls.length > 0 ? JSON.stringify(res.toolCalls) : '{}'));

function mutate(fault: ModelFault, res: ModelResponse, rng: SeededRandom): ModelResponse {
  switch (fault.kind) {
    case 'malformed-json': {
      const src = sourceText(res);
      const out: ModelResponse = { ...res, toolCalls: [], finishReason: 'stop', text: `${src.slice(0, Math.max(1, Math.floor(src.length * 0.6)))} ,,}{` };
      delete out.object;
      return out;
    }
    case 'schema-invalid':
      return invalidShape(res, rng);
    case 'empty': {
      const out: ModelResponse = { ...res, toolCalls: [], finishReason: 'stop' };
      delete out.text;
      delete out.object;
      return out;
    }
    case 'bad-tool-call': {
      const hostile: ToolCall = { id: 'chaos-unknown', name: 'format_disk', args: { target: '/' } };
      let toolCalls: ToolCall[];
      if (fault.mode === 'unknown-tool') toolCalls = [hostile];
      else if (fault.mode === 'extra-unknown') toolCalls = [...res.toolCalls, hostile];
      else {
        const base = res.toolCalls.length > 0 ? res.toolCalls : [{ id: 'chaos-click', name: 'click', args: {} }];
        toolCalls = base.map((c) => ({ ...c, args: { ref: 12345, value: { chaos: true }, url: null } }));
      }
      return { ...res, toolCalls, finishReason: 'tool-calls' };
    }
    case 'oversized':
      return oversize(res, fault.chars ?? 1_000_000, fault.where);
    case 'truncated': {
      const src = sourceText(res);
      const out: ModelResponse = { ...res, toolCalls: [], finishReason: 'length', text: src.slice(0, Math.floor(src.length / 2)) };
      delete out.object;
      return out;
    }
    case 'finish-reason':
      return { ...res, finishReason: fault.reason };
    default:
      return res;
  }
}

function hangUntilAborted(signal: AbortSignal | undefined, ignoreSignal: boolean | undefined, keepAlive: boolean | undefined): Promise<never> {
  if (signal === undefined || ignoreSignal === true) return hang(keepAlive);
  return new Promise<never>((_, reject) => {
    const fail = (): void => reject(new AiBddError('ABORTED', 'chaos: hung model call aborted'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

/**
 * Wraps a `ModelSet` so that a seeded plan of faults strikes `generate` per purpose: provider outages and rate limits (N consecutive
 * failures, then success, with `{ from: 1, times: N }`), timeouts, malformed or schema-invalid structured output, empty answers,
 * hostile tool calls, oversized answers, truncation and hangs. Response faults damage the REAL answer of the wrapped model, so the
 * damage is realistic for the request; the wrapper never invents a successful answer.
 */
export function chaosModels(models: ModelSet, plan: ModelFaultPlan, options: ChaosOptions = {}): ChaosModelSet {
  validateModelPlan(plan);
  const cursors = cursorsFor(plan);
  const root = seededRandom(plan.seed).fork('models');
  const rec = createRecorder(options);
  const calls = Object.fromEntries(PURPOSES.map((p) => [p, 0])) as Record<ModelPurpose, number>;
  const faults = Object.fromEntries(PURPOSES.map((p) => [p, 0])) as Record<ModelPurpose, number>;

  const wrap = (purpose: ModelPurpose, inner: ChatModel): ChatModel => ({
    get id() {
      return inner.id;
    },
    async generate(req: ModelRequest): Promise<ModelResponse> {
      calls[purpose] += 1;
      const fired: { index: number; fault: ModelFault }[] = [];
      plan.rules.forEach((rule, index) => {
        if (rule.at !== '*' && rule.at !== purpose) return;
        if (rule.context !== undefined && !Object.entries(rule.context).every(([k, v]) => req.context[k] === v)) return;
        const cursor = cursors[index];
        if (cursor !== undefined && decide(rule, cursor)) fired.push({ index, fault: rule.fault });
      });
      const note = (f: { index: number; fault: ModelFault }, detail?: string): void => {
        faults[purpose] += 1;
        rec.record({ at: purpose, rule: f.index, fault: f.fault.kind, ...(detail === undefined ? {} : { detail }) });
      };

      for (const f of fired) {
        if (f.fault.kind === 'latency') {
          note(f, `${f.fault.ms} ms`);
          await rec.sleep(f.fault.ms);
        }
      }
      const terminal = fired.find((f) => f.fault.kind !== 'latency');
      const fault = terminal?.fault;
      if (terminal !== undefined && fault !== undefined) {
        switch (fault.kind) {
          case 'throw':
            note(terminal, fault.code);
            throw new AiBddError(fault.code, fault.message ?? `chaos: injected ${fault.code}`, {
              ...(fault.retryable === undefined ? {} : { retryable: fault.retryable }),
              details: { chaos: true, purpose },
            });
          case 'throw-raw':
            note(terminal);
            throw new Error(fault.message ?? 'chaos: injected raw model error');
          case 'unavailable':
            note(terminal);
            throw new AiBddError('MODEL_UNAVAILABLE', fault.message ?? 'chaos: model unavailable', {
              retryable: fault.permanent !== true,
              details: { chaos: true, purpose },
            });
          case 'rate-limit':
            note(terminal);
            throw new AiBddError('MODEL_UNAVAILABLE', fault.message ?? 'chaos: rate limited (HTTP 429)', {
              retryable: true,
              details: { chaos: true, purpose, statusCode: 429, ...(fault.retryAfterMs === undefined ? {} : { retryAfterMs: fault.retryAfterMs }) },
            });
          case 'timeout': {
            note(terminal, `${fault.ms ?? 30_000} ms`);
            await rec.sleep(fault.ms ?? 30_000);
            throw new AiBddError('MODEL_UNAVAILABLE', 'chaos: model request timed out', { retryable: true, details: { chaos: true, purpose, timedOut: true } });
          }
          case 'hang':
            note(terminal);
            return hangUntilAborted(req.signal, fault.ignoreSignal, options.keepAlive);
          default:
            break;
        }
      }
      const real = await inner.generate(req);
      if (terminal === undefined || fault === undefined) return real;
      note(terminal);
      return mutate(fault, real, root.fork(`${purpose}-${calls[purpose]}`));
    },
  });

  return {
    extract: wrap('extract', models.extract),
    act: wrap('act', models.act),
    checkgen: wrap('checkgen', models.checkgen),
    judge: wrap('judge', models.judge),
    plan,
    seed: seededRandom(plan.seed).seed,
    events: rec.events,
    stats: { calls, faults, virtualDelayMs: rec.virtualDelayMs },
  };
}
