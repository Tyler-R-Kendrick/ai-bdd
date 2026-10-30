import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

export type PermissionRequest = {
  toolCall?: { kind?: unknown; title?: unknown; rawInput?: unknown };
  options?: unknown;
};
export type PermissionTerminal = {
  input?: Readable & { isTTY?: boolean };
  output?: Writable & { isTTY?: boolean };
  timeoutMs?: number;
};
const kinds = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'fetch',
  'other',
]);
const text = (value: unknown) =>
  String(value ?? '')
    // eslint-disable-next-line no-control-regex -- Remove untrusted terminal control characters.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .slice(0, 800);

/** Grants belong to one ACP session, never another run, principal or verifier. */
export class TerminalPermissionSession {
  private readonly grants = new Set<string>();
  private readonly closed = new AbortController();
  private tail = Promise.resolve();
  private pending = 0;
  constructor(
    readonly signal: AbortSignal,
    readonly terminal: PermissionTerminal = {},
  ) {}
  close() {
    this.grants.clear();
    this.closed.abort();
  }
  async choose(request: PermissionRequest): Promise<string | undefined> {
    const kind = request.toolCall?.kind;
    const options = request.options;
    if (
      typeof kind !== 'string' ||
      !kinds.has(kind) ||
      !Array.isArray(options) ||
      options.length > 20
    )
      return;
    // Never return allow_always: that could persist a grant inside the external
    // agent beyond this connector session. Session grants are held only here.
    const option = options.find(
      (value: any) =>
        value?.kind === 'allow_once' &&
        typeof value.optionId === 'string' &&
        value.optionId.length <= 128,
    );
    if (!option || this.signal.aborted || this.closed.signal.aborted) return;
    const input = this.terminal.input ?? process.stdin;
    const output = this.terminal.output ?? process.stderr;
    if (!input.isTTY || !output.isTTY) return;
    if (this.grants.has(kind)) return option.optionId;
    if (this.pending >= 8) return;
    this.pending++;
    let finish!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      await previous;
      if (this.signal.aborted || this.closed.signal.aborted) return;
      if (this.grants.has(kind)) return option.optionId;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.max(10, Math.min(120000, this.terminal.timeoutMs ?? 60000)),
      );
      const combined = AbortSignal.any([
        this.signal,
        this.closed.signal,
        controller.signal,
      ]);
      const readline = createInterface({ input, output, terminal: false });
      try {
        output.write(
          '\nLocal agent permission (' +
            text(kind) +
            ')\n' +
            text(request.toolCall?.title) +
            '\n',
        );
        if (request.toolCall?.rawInput !== undefined)
          output.write(text(JSON.stringify(request.toolCall.rawInput)) + '\n');
        const answer = (
          await readline.question(
            '[o] allow once, [s] allow this kind in this ACP session, [d] deny (default): ',
            { signal: combined },
          )
        )
          .trim()
          .toLowerCase();
        if (combined.aborted) return;
        if (['s', 'session', '2'].includes(answer)) {
          this.grants.add(kind);
          return option.optionId;
        }
        if (['o', 'once', '1'].includes(answer)) return option.optionId;
        return;
      } catch {
        return;
      } finally {
        clearTimeout(timer);
        readline.close();
      }
    } finally {
      this.pending--;
      finish();
    }
  }
}
