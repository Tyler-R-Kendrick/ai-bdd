/** Explicit operational vocabulary: never copy native messages, URLs, paths or credentials. */
export type NativeT3Phase =
  | 'queue' | 'verify-tools' | 'acquire-lease' | 'restore-state'
  | 'native-start' | 'model-host' | 'opencode-launch' | 'opencode-readiness'
  | 't3-project-registration' | 't3-serve' | 't3-readiness' | 't3-oauth'
  | 't3-admission' | 'initial-checkpoint' | 'native-restart' | 'inference'
  | 'local-inference' | 'final-checkpoint' | 'cleanup' | 'native-model-request';
type ErrorClass = 'http' | 'abort' | 'timeout' | 'local-model' | 'system' | 'other';
const codes = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EADDRINUSE', 'EPIPE', 'ENOSPC', 'ERR_DLOPEN_FAILED', 'ERR_INVALID_ARG_VALUE',
  'ERR_INVALID_URL', 'ERR_SOCKET_CLOSED', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'context', 'assets', 'schema',
  'busy', 'deadline', 'aborted', 'memory', 'runtime',
]);
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL']);
type ErrorMetadata = { errorClass: ErrorClass; status?: number; code?: string; exitCode?: number; signal?: string };
export type NativeT3Event = Readonly<{
  phase: NativeT3Phase;
  state: 'start' | 'complete' | 'failure' | 'probe' | 'exit' | 'request';
  elapsedMs?: number;
  messages?: number;
  envelopeMatches?: number;
  contentKinds?: readonly ('parts' | 'text' | 'other')[];
} & Partial<ErrorMetadata>>;
export type NativeT3Observer = (event: NativeT3Event) => void | Promise<void>;
function failureMetadata(error: unknown): ErrorMetadata {
  // An arbitrary thrown value (including hostile getters) must not break execution or enter logs.
  try {
    const value = error as any;
    const status = value?.statusCode;
    const rawCode = value?.code ?? value?.cause?.code;
    const code = typeof rawCode === 'string' && codes.has(rawCode) ? rawCode : undefined;
    const errorClass: ErrorClass = value?.name === 'AbortError' ? 'abort'
      : value?.name === 'TimeoutError' ? 'timeout'
      : value?.name === 'LocalModelError' ? 'local-model'
      : Number.isInteger(status) && status >= 400 && status <= 599 ? 'http'
      : code ? 'system' : 'other';
    return { errorClass,
      ...(Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}),
      ...(code ? { code } : {}),
      ...(Number.isInteger(rawCode) && rawCode >= 0 && rawCode <= 255 ? { exitCode: rawCode } : {}),
      ...(typeof value?.signal === 'string' && signals.has(value.signal) ? { signal: value.signal } : {}),
    };
  } catch { return { errorClass: 'other' }; }
}
export class NativeT3Diagnostics {
  constructor(private readonly observer?: NativeT3Observer) {}
  private emit(event: NativeT3Event) {
    try { void Promise.resolve(this.observer?.(Object.freeze(event))).catch(() => {}); }
    catch { /* Observability must never change the native operation. */ }
  }
  async run<T>(phase: NativeT3Phase, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    this.emit({ phase, state: 'start' });
    try {
      const result = await work();
      this.emit({ phase, state: 'complete', elapsedMs: Math.max(0, Math.min(180000, Date.now() - started)) });
      return result;
    } catch (error) { this.failure(phase, error); throw error; }
  }
  failure(phase: NativeT3Phase, error: unknown) { this.emit({ phase, state: 'failure', ...failureMetadata(error) }); }
  probe(phase: NativeT3Phase, status: number | undefined, error?: unknown) {
    this.emit({ phase, state: 'probe', ...(Number.isInteger(status) && status! >= 100 && status! <= 599 ? { status } : {}), ...(error === undefined ? {} : failureMetadata(error)) });
  }
  exit(phase: NativeT3Phase, code: number | null, signal: string | null) {
    this.emit({ phase, state: 'exit', ...(Number.isInteger(code) && code! >= 0 && code! <= 255 ? { exitCode: code! } : {}), ...(signal && signals.has(signal) ? { signal } : {}) });
  }
  request(messages: unknown[], envelopeMatches?: number) {
    this.emit({ phase: 'native-model-request', state: 'request', messages: Math.min(100, messages.length),
      ...(Number.isInteger(envelopeMatches) && envelopeMatches! >= 0 ? { envelopeMatches: Math.min(100, envelopeMatches!) } : {}),
      contentKinds: Object.freeze(messages.slice(0, 100).map((value: any) => Array.isArray(value?.content) ? 'parts' as const : typeof value?.content === 'string' ? 'text' as const : 'other' as const)) });
  }
}
