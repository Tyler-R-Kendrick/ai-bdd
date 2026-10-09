import type { JsonValue, Verb } from '@ai-bdd/contracts';

/**
 * The Cua Driver tools this driver depends on (contract version 0.8.0).
 *
 * The list is the pinned contract: `selfCheck()` fails with DRIVER_INCOMPATIBLE
 * listing whatever is missing, so a driver upgrade cannot silently break a run
 * (VERIFY V3 — the fixtures in test/fixtures are `synthetic: true` because the Cua
 * CLI cannot run in this sandbox).
 */
export const REQUIRED_TOOLS = [
  'start_session',
  'end_session',
  'get_session',
  'list_apps',
  'list_windows',
  'get_window_state',
  'list_sessions',
  'verify_state',
  'click',
  'type_text',
  'press_key',
  'hotkey',
  'scroll',
  'drag',
  'move_cursor',
  'get_screen_size',
  'get_cursor_position',
  'set_window_frame',
] as const;

export type RequiredTool = (typeof REQUIRED_TOOLS)[number];

/**
 * Verb mapping from ai-bdd to Cua Driver.
 *
 * `navigate` is deliberately absent: a native desktop has no URL bar, so the verb
 * is not advertised at all instead of failing at run time.
 */
export const CUA_VERB_MAP: Record<Verb, { tool: string | null; foregroundOnly: boolean }> = {
  tap: { tool: 'click', foregroundOnly: false },
  doubleTap: { tool: 'click', foregroundOnly: false },
  longPress: { tool: 'click', foregroundOnly: false },
  secondaryTap: { tool: 'click', foregroundOnly: false },
  hover: { tool: 'move_cursor', foregroundOnly: false },
  type: { tool: 'type_text', foregroundOnly: true },
  typeSecret: { tool: 'type_text', foregroundOnly: true },
  press: { tool: 'press_key', foregroundOnly: true },
  select: { tool: 'click', foregroundOnly: false },
  check: { tool: 'click', foregroundOnly: false },
  scroll: { tool: 'scroll', foregroundOnly: true },
  scrollTo: { tool: 'scroll', foregroundOnly: true },
  drag: { tool: 'drag', foregroundOnly: true },
  navigate: { tool: null, foregroundOnly: false },
  back: { tool: 'press_key', foregroundOnly: true },
  upload: { tool: null, foregroundOnly: true },
  tapAt: { tool: 'click', foregroundOnly: false },
  typeAt: { tool: 'type_text', foregroundOnly: true },
  invokeMenu: { tool: 'invoke_menu', foregroundOnly: false },
};

/** Capabilities derived from the contract's tool list. */
export function capabilitiesFromTools(tools: string[], backgroundOnly = false): {
  verbs: Verb[];
  pixels: boolean;
  tree: boolean;
  video: boolean;
  nativePredicates: boolean;
  maskingProven: boolean;
  deliveryModes: Array<'background' | 'foreground'>;
} {
  const verbs = (Object.keys(CUA_VERB_MAP) as Verb[]).filter((verb) => {
    const entry = CUA_VERB_MAP[verb];
    if (entry.tool === null || !tools.includes(entry.tool)) return false;
    // Background-only mode refuses the verbs that type into the foreground app (R-K13).
    if (backgroundOnly && entry.foregroundOnly) return false;
    return true;
  });
  return {
    verbs,
    pixels: tools.includes('get_window_state'),
    tree: tools.includes('get_window_state'),
    video: false,
    nativePredicates: tools.includes('verify_state'),
    maskingProven: false,
    deliveryModes: backgroundOnly ? ['background'] : ['background', 'foreground'],
  };
}

/**
 * Parses Cua's snapshot-bound element tokens. They are only valid against the
 * newest observation (`^s[0-9a-f]{8}:[0-9]+$`), so a stale token is rejected rather
 * than guessed.
 */
export function isElementToken(value: string): boolean {
  return /^s[0-9a-f]{8}:\d+$/u.test(value);
}

export interface CuaNode {
  role: string;
  name: string;
  token?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  children?: CuaNode[];
  state?: Record<string, JsonValue>;
}

/** Maps `verify_state` results onto the predicate vocabulary. `unknown` is a failure. */
export function mapVerifyState(results: string[]): Array<'satisfied' | 'unsatisfied' | 'unknown'> {
  return results.map((result) => {
    const normalized = result.toLowerCase();
    if (normalized === 'satisfied' || normalized === 'unsatisfied') return normalized;
    return 'unknown';
  });
}

export interface CuaErrorMapping {
  [code: string]: string;
}

/** Cua error codes mapped onto ai-bdd codes. */
export const CUA_ERROR_MAP: CuaErrorMapping = {
  POLICY_DENIED: 'POLICY_DENIED',
  APP_NOT_ALLOWED: 'POLICY_DENIED',
  PIXEL_TAINTED: 'PIXEL_TAINTED',
  SESSION_LIMIT: 'SESSION_LIMIT',
  SESSION_NOT_FOUND: 'NO_SESSION',
  SNAPSHOT_STALE: 'DRIVER_INCOMPATIBLE',
  PERMISSION_REQUIRED: 'DRIVER_UNAVAILABLE',
};

export function mapCuaError(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return CUA_ERROR_MAP[code] ?? code;
}
