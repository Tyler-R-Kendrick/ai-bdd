import type {
  ActProgram, EffectSignature, FuzzyReason, JsonValue, NodeKey, Redactor, RecordedAction, Selector, ValueSource,
} from '../contracts/index.ts';

/**
 * Secret hygiene for recordings (R-SE1). A recording is committed to the repository, so no secret value, nor any
 * encoding of one the redactor knows (raw, URL-encoded, base64, JSON-escaped), may appear in it.
 *
 * The redactor is the single source of truth for "contains a secret variant": a string contains one exactly when
 * `redact(text) !== text`.
 */
export interface SecretContext {
  redactor: Redactor;
  /** The value of a named secret; lets a literal that equals a secret be recorded as `{secret: name}`. */
  secretValue?: ((name: string) => string | undefined) | undefined;
}

export function hasSecret(redactor: Redactor, text: string): boolean {
  return text.length > 0 && redactor.redact(text) !== text;
}

/** Whether the serialized form of `value` (keys included) holds any secret variant. This is the save-time guard. */
export function jsonHasSecret(redactor: Redactor, value: unknown): boolean {
  const text = JSON.stringify(value);
  return text !== undefined && redactor.redact(text) !== text;
}

function jsonValueHasSecret(redactor: Redactor, v: JsonValue): boolean {
  return v !== null && typeof v === 'object' ? jsonHasSecret(redactor, v) : typeof v === 'string' && hasSecret(redactor, v);
}

function keyHasSecret(redactor: Redactor, k: NodeKey): boolean {
  return hasSecret(redactor, k.role) || hasSecret(redactor, k.name);
}

/** Drops effect entries that carry a secret: a recorded signature must never hold what the page reflected back. */
function scrubEffect(effect: EffectSignature, redactor: Redactor): EffectSignature {
  return {
    routeBefore: effect.routeBefore,
    routeAfter: effect.routeAfter,
    appeared: effect.appeared.filter((k) => !keyHasSecret(redactor, k)),
    disappeared: effect.disappeared.filter((k) => !keyHasSecret(redactor, k)),
    changed: effect.changed.filter(
      (c) => !keyHasSecret(redactor, c.key) && !hasSecret(redactor, c.state) && !jsonValueHasSecret(redactor, c.from) && !jsonValueHasSecret(redactor, c.to),
    ),
  };
}

function scrubSelector(sel: Selector, redactor: Redactor): { selector: Selector; changed: boolean } {
  let changed = false;
  const red = (s: string): string => {
    const r = redactor.redact(s);
    if (r !== s) changed = true;
    return r;
  };
  const out: Selector = {
    role: red(sel.role),
    name: red(sel.name),
    ancestors: sel.ancestors.map((a) => ({ role: red(a.role), name: red(a.name) })),
    index: sel.index,
    of: sel.of,
  };
  if (sel.testId !== undefined) out.testId = red(sel.testId);
  return { selector: out, changed };
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** A literal equal to a secret value becomes `{secret: name}`; a literal merely containing a variant is redacted. */
function scrubValue(v: ValueSource, ctx: SecretContext): { value: ValueSource; changed: boolean } {
  if (!('literal' in v)) return { value: v, changed: false };
  if (!hasSecret(ctx.redactor, v.literal)) return { value: v, changed: false };
  if (ctx.secretValue !== undefined) {
    for (const name of ctx.redactor.secretNames) {
      const secret = ctx.secretValue(name);
      if (secret !== undefined && (secret === v.literal || norm(secret) === norm(v.literal))) return { value: { secret: name }, changed: false };
    }
  }
  return { value: { literal: ctx.redactor.redact(v.literal) }, changed: true };
}

function scrubAction(a: RecordedAction, ctx: SecretContext): { action: RecordedAction; changed: boolean } {
  const { redactor } = ctx;
  let changed = false;
  const sel = (s: Selector): Selector => {
    const r = scrubSelector(s, redactor);
    changed ||= r.changed;
    return r.selector;
  };
  const val = (v: ValueSource): ValueSource => {
    const r = scrubValue(v, ctx);
    changed ||= r.changed;
    return r.value;
  };
  const red = (s: string): string => {
    const r = redactor.redact(s);
    changed ||= r !== s;
    return r;
  };
  let action: RecordedAction;
  switch (a.verb) {
    case 'navigate': action = { verb: 'navigate', url: red(a.url) }; break;
    case 'back':
    case 'wait': action = a; break;
    case 'click':
    case 'hover': action = { verb: a.verb, target: sel(a.target) }; break;
    case 'fill': action = { verb: 'fill', target: sel(a.target), value: val(a.value) }; break;
    case 'select': action = { verb: 'select', target: sel(a.target), option: val(a.option) }; break;
    case 'check': action = { verb: 'check', target: sel(a.target), checked: a.checked }; break;
    case 'press': action = a.target === undefined ? { verb: 'press', key: red(a.key) } : { verb: 'press', key: red(a.key), target: sel(a.target) }; break;
    case 'scroll': action = a.target === undefined ? a : { verb: 'scroll', direction: a.direction, target: sel(a.target) }; break;
  }
  return { action, changed };
}

/**
 * Removes every secret from an act program and reports the extra fuzzy reasons that follow:
 * - effect entries (node names, field values) that reflect a secret are dropped; an effect emptied this way yields
 *   `no-observable-effect`;
 * - a selector, URL, key or route that holds a secret can no longer be replayed exactly, so the step turns fuzzy
 *   (`secret-in-recording`) and keeps only the redacted text as a hint;
 * - a literal that equals a secret value is recorded as `{secret: name}` instead.
 * Idempotent.
 */
export function scrubActProgram(act: ActProgram, ctx: SecretContext): { act: ActProgram; fuzzyReasons: FuzzyReason[] } {
  const { redactor } = ctx;
  const reasons: FuzzyReason[] = [];
  let unreplayable = false;
  const actions = act.actions.map((a) => {
    const r = scrubAction(a, ctx);
    unreplayable ||= r.changed;
    return r.action;
  });
  const startRoute = redactor.redact(act.startRoute);
  if (startRoute !== act.startRoute) unreplayable = true;
  const effect = scrubEffect(act.effect, redactor);
  const routeBefore = redactor.redact(effect.routeBefore);
  const routeAfter = redactor.redact(effect.routeAfter);
  if (routeBefore !== effect.routeBefore || routeAfter !== effect.routeAfter) unreplayable = true;

  const dropped =
    effect.appeared.length !== act.effect.appeared.length ||
    effect.disappeared.length !== act.effect.disappeared.length ||
    effect.changed.length !== act.effect.changed.length;
  const emptied = effect.appeared.length === 0 && effect.disappeared.length === 0 && effect.changed.length === 0;
  if (dropped && emptied && routeBefore === routeAfter) reasons.push('no-observable-effect');
  if (unreplayable) reasons.push('secret-in-recording');
  return {
    act: { startRoute, startLandmarks: act.startLandmarks, actions, effect: { ...effect, routeBefore, routeAfter } },
    fuzzyReasons: reasons,
  };
}
