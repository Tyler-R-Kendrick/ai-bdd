import type { Verb } from '@ai-bdd/contracts';

/**
 * Verb mapping from ai-bdd to the `e2e mcp` tool catalog (section 11.2).
 * The catalog is raw session tools only: `e2e mcp` has no act/assert/waitFor.
 */
export const E2E_VERB_MAP: Record<Verb, string | null> = {
  tap: 'tap',
  doubleTap: 'double_tap',
  longPress: 'long_press',
  secondaryTap: 'right_click',
  hover: 'hover',
  type: 'type',
  typeSecret: 'type_secret',
  press: 'press',
  select: 'select',
  check: 'check',
  scroll: 'scroll',
  scrollTo: 'scroll_to',
  drag: 'drag',
  navigate: 'navigate',
  back: 'back',
  upload: 'upload',
  tapAt: 'tap_at',
  typeAt: 'type_at',
  invokeMenu: null,
};

/** Every tool name `e2e mcp` is documented to expose (F-E3). */
export const E2E_CATALOG = [
  'observe',
  'tap',
  'double_tap',
  'long_press',
  'right_click',
  'hover',
  'type',
  'press',
  'select',
  'check',
  'scroll',
  'scroll_to',
  'drag',
  'upload',
  'navigate',
  'back',
  'type_secret',
  'dismiss_keyboard',
  'locate',
  'screenshot',
  'tap_at',
  'hover_at',
  'type_at',
  'press_at',
  'select_at',
  'start_recording',
  'stop_recording',
] as const;

/** Capabilities are derived from the session catalog, so absent verbs stay absent. */
export function capabilitiesFromCatalog(catalog: string[]): {
  verbs: Verb[];
  pixels: boolean;
  tree: boolean;
  video: boolean;
  nativePredicates: boolean;
  maskingProven: boolean;
} {
  const verbs = (Object.keys(E2E_VERB_MAP) as Verb[]).filter((verb) => {
    const tool = E2E_VERB_MAP[verb];
    return tool !== null && catalog.includes(tool);
  });
  return {
    verbs,
    pixels: catalog.includes('screenshot'),
    tree: catalog.includes('observe'),
    video: catalog.includes('start_recording') && catalog.includes('stop_recording'),
    nativePredicates: false,
    maskingProven: catalog.includes('type_secret'),
  };
}

/** Maps the e2e error codes of F-E3 onto ai-bdd error codes. */
export const E2E_ERROR_MAP: Record<string, string> = {
  PIXEL_TAINTED: 'PIXEL_TAINTED',
  POLICY_DENIED: 'POLICY_DENIED',
  SESSION_OPEN: 'SESSION_LIMIT',
  CONFIG_IN_USE: 'RESOURCE_LOCKED',
  ENGINE_IN_USE: 'RESOURCE_LOCKED',
  NO_SESSION: 'NO_SESSION',
};

export function mapE2eError(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return E2E_ERROR_MAP[code] ?? code;
}

/** Parses the `--max-sessions` cap (1..16, default 4) out of options. */
export function normalizeMaxSessions(value: number | undefined): number {
  if (value === undefined) return 4;
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new RangeError('maxSessions must be an integer between 1 and 16');
  }
  return value;
}

/** Builds the `e2e mcp` argv (flag names verified against e2e 0.19.0). */
export function e2eMcpArgs(options: { config?: string; target?: string; maxSessions?: number }): string[] {
  const args = ['mcp'];
  if (options.config) args.push('--config', options.config);
  if (options.target) args.push('--target', options.target);
  args.push('--max-sessions', String(normalizeMaxSessions(options.maxSessions)));
  return args;
}
