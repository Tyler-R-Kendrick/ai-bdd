/** Translate ai-bdd key names (Playwright style: `Enter`, `Control+A`, `ArrowDown`) into Cua Driver `press_key` arguments. */

export interface CuaKey { key: string; modifiers: string[] }

const NAMED: Record<string, string> = {
  enter: 'enter', return: 'return', tab: 'tab', escape: 'escape', esc: 'escape', space: 'space', ' ': 'space',
  backspace: 'backspace', delete: 'delete', del: 'delete', insert: 'insert', home: 'home', end: 'end',
  pageup: 'pageup', pagedown: 'pagedown', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
  up: 'up', down: 'down', left: 'left', right: 'right',
};

const PLATFORM_META = process.platform === 'darwin' ? 'cmd' : 'super';

const MODIFIERS: Record<string, string> = {
  control: 'ctrl', ctrl: 'ctrl', shift: 'shift', alt: 'alt', option: 'alt',
  meta: PLATFORM_META, cmd: PLATFORM_META, command: PLATFORM_META, super: PLATFORM_META, win: PLATFORM_META,
  controlormeta: process.platform === 'darwin' ? 'cmd' : 'ctrl',
};

/** `Control+Shift+K` -> `{ key: 'K', modifiers: ['ctrl', 'shift'] }`. Returns `undefined` for an empty or unknown spec. */
export function parseKey(spec: string): CuaKey | undefined {
  if (spec.length === 0) return undefined;
  // "+" itself is a key: "Control++" means Control and "+".
  const parts = spec === '+' ? ['+'] : spec.endsWith('++') ? [...spec.slice(0, -2).split('+'), '+'] : spec.split('+');
  const keyPart = parts[parts.length - 1] as string;
  const modifiers: string[] = [];
  for (const m of parts.slice(0, -1)) {
    const mapped = MODIFIERS[m.toLowerCase()];
    if (mapped === undefined) return undefined;
    if (!modifiers.includes(mapped)) modifiers.push(mapped);
  }
  const lower = keyPart.toLowerCase();
  const named = NAMED[lower];
  if (named !== undefined) return { key: named, modifiers };
  if (/^f([1-9]|1[0-2])$/.test(lower)) return { key: lower, modifiers };
  if (keyPart.length === 1) return { key: keyPart, modifiers };
  return undefined;
}
