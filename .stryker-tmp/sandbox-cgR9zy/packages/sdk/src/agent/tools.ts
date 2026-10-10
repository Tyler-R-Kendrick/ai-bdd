// @ts-nocheck
import type { JsonObject, ToolSpec, ValueSource, Verb } from '../contracts/index.ts';

export const COMPLETE_STEP = 'complete_step';

const REF = { type: 'string', description: 'ref of the target element from the latest observation' } as const;

function obj(properties: JsonObject, required: string[]): JsonObject {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** Tool specs for the offered verbs, in capability order, plus complete_step. */
export function buildTools(verbs: readonly Verb[], maxWaitMs: number): ToolSpec[] {
  const specs: Record<Verb, ToolSpec> = {
    click: { name: 'click', description: 'Click an element.', inputSchema: obj({ ref: REF }, ['ref']) },
    fill: {
      name: 'fill',
      description: 'Type into a text field. Provide exactly one of text (literal), param (name of a step param) or secret (name of a secret).',
      inputSchema: obj(
        {
          ref: REF,
          text: { type: 'string', description: 'literal text to type' },
          param: { type: 'string', description: 'name of a step param whose value is typed' },
          secret: { type: 'string', description: 'name of a secret whose value is typed' },
        },
        ['ref'],
      ),
    },
    press: {
      name: 'press',
      description: 'Press a keyboard key, optionally focusing an element first.',
      inputSchema: obj({ key: { type: 'string', description: 'for example Enter, Escape, Tab' }, ref: REF }, ['key']),
    },
    select: {
      name: 'select',
      description: 'Choose an option in a select/combobox.',
      inputSchema: obj({ ref: REF, option: { type: 'string', description: 'visible option label' } }, ['ref', 'option']),
    },
    check: {
      name: 'check',
      description: 'Set a checkbox or switch to checked or unchecked.',
      inputSchema: obj({ ref: REF, checked: { type: 'boolean' } }, ['ref', 'checked']),
    },
    hover: { name: 'hover', description: 'Hover over an element.', inputSchema: obj({ ref: REF }, ['ref']) },
    scroll: {
      name: 'scroll',
      description: 'Scroll the page, or a specific element.',
      inputSchema: obj({ direction: { type: 'string', enum: ['up', 'down'] }, ref: REF }, ['direction']),
    },
    navigate: {
      name: 'navigate',
      description: 'Navigate to a URL. Only URLs allowed by policy work.',
      inputSchema: obj({ url: { type: 'string' } }, ['url']),
    },
    back: { name: 'back', description: 'Go back in history.', inputSchema: obj({}, []) },
    wait: {
      name: 'wait',
      description: `Wait for the given number of milliseconds (at most ${maxWaitMs}).`,
      inputSchema: obj({ ms: { type: 'integer', minimum: 0, maximum: maxWaitMs } }, ['ms']),
    },
  };
  const seen = new Set<Verb>();
  const tools: ToolSpec[] = [];
  for (const v of verbs) {
    if (seen.has(v)) continue;
    seen.add(v);
    tools.push(specs[v]);
  }
  tools.push({
    name: COMPLETE_STEP,
    description: 'End the step. Use status "done" once the step has been carried out, or "blocked" if it cannot be carried out.',
    inputSchema: obj({ status: { type: 'string', enum: ['done', 'blocked'] }, summary: { type: 'string' } }, ['status', 'summary']),
  });
  return tools;
}

export const ALL_VERBS: readonly Verb[] = ['navigate', 'click', 'fill', 'press', 'select', 'check', 'hover', 'scroll', 'back', 'wait'];

export function isVerb(name: string): name is Verb {
  return (ALL_VERBS as readonly string[]).includes(name);
}

export type ParsedCall =
  | { verb: 'navigate'; url: string }
  | { verb: 'click' | 'hover'; ref: string }
  | { verb: 'fill'; ref: string; value: ValueSource }
  | { verb: 'press'; key: string; ref?: string }
  | { verb: 'select'; ref: string; option: string }
  | { verb: 'check'; ref: string; checked: boolean }
  | { verb: 'scroll'; direction: 'up' | 'down'; ref?: string }
  | { verb: 'back' }
  | { verb: 'wait'; ms: number };

export type Parsed = { ok: true; call: ParsedCall } | { ok: false; message: string };

function present(v: unknown): boolean {
  return v !== undefined && v !== null;
}

function str(args: JsonObject, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

/** Validates the arguments of a verb tool call. `null` counts as absent (strict-schema providers). */
export function parseVerbCall(verb: string, args: JsonObject, maxWaitMs: number): Parsed {
  const bad = (message: string): Parsed => ({ ok: false, message });
  const needRef = (): string | undefined => {
    const r = str(args, 'ref');
    return r !== undefined && r !== '' ? r : undefined;
  };
  const optRef = (): { ok: true; ref?: string } | { ok: false } => {
    if (!present(args['ref'])) return { ok: true };
    const r = needRef();
    return r === undefined ? { ok: false } : { ok: true, ref: r };
  };
  switch (verb) {
    case 'navigate': {
      const url = str(args, 'url');
      return url === undefined || url === '' ? bad('navigate requires a non-empty string "url"') : { ok: true, call: { verb, url } };
    }
    case 'click':
    case 'hover': {
      const ref = needRef();
      return ref === undefined ? bad(`${verb} requires a string "ref"`) : { ok: true, call: { verb, ref } };
    }
    case 'fill': {
      const ref = needRef();
      if (ref === undefined) return bad('fill requires a string "ref"');
      const given = (['text', 'param', 'secret'] as const).filter((k) => present(args[k]));
      if (given.length !== 1) return bad('fill requires exactly one of "text", "param" or "secret"');
      const k = given[0] as 'text' | 'param' | 'secret';
      const v = str(args, k);
      if (v === undefined) return bad(`fill "${k}" must be a string`);
      const value: ValueSource = k === 'text' ? { literal: v } : k === 'param' ? { param: v } : { secret: v };
      return { ok: true, call: { verb, ref, value } };
    }
    case 'press': {
      const key = str(args, 'key');
      if (key === undefined || key === '') return bad('press requires a non-empty string "key"');
      const r = optRef();
      if (!r.ok) return bad('press "ref" must be a non-empty string when given');
      return { ok: true, call: r.ref === undefined ? { verb, key } : { verb, key, ref: r.ref } };
    }
    case 'select': {
      const ref = needRef();
      const option = str(args, 'option');
      if (ref === undefined || option === undefined) return bad('select requires string "ref" and "option"');
      return { ok: true, call: { verb, ref, option } };
    }
    case 'check': {
      const ref = needRef();
      const checked = args['checked'];
      if (ref === undefined || typeof checked !== 'boolean') return bad('check requires string "ref" and boolean "checked"');
      return { ok: true, call: { verb, ref, checked } };
    }
    case 'scroll': {
      const direction = args['direction'];
      if (direction !== 'up' && direction !== 'down') return bad('scroll requires "direction" of "up" or "down"');
      const r = optRef();
      if (!r.ok) return bad('scroll "ref" must be a non-empty string when given');
      return { ok: true, call: r.ref === undefined ? { verb, direction } : { verb, direction, ref: r.ref } };
    }
    case 'back':
      return { ok: true, call: { verb } };
    case 'wait': {
      const ms = args['ms'];
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return bad('wait requires a non-negative number "ms"');
      if (ms > maxWaitMs) return bad(`wait "ms" must be at most ${maxWaitMs}`);
      return { ok: true, call: { verb, ms: Math.round(ms) } };
    }
    default:
      return bad(`unknown tool ${verb}`);
  }
}
