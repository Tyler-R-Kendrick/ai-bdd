/** Finite IPC metadata only. Never expose model input/output, environment, paths or library errors. */
const workerPhases = new Set([
  'worker-start', 'weights-verified', 'binding-loaded', 'model-loaded', 'inference-start', 'complete',
]);
export type LocalWorkerPhase = 'worker-start' | 'weights-verified' | 'binding-loaded' | 'model-loaded' | 'inference-start' | 'complete';
const errorCodes = new Set(['configuration', 'assets', 'context', 'schema', 'inference', 'busy', 'deadline', 'memory', 'ENOENT', 'EACCES', 'EPERM', 'EPIPE', 'ERR_DLOPEN_FAILED']);
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL']);
export type LocalInferenceEvent = Readonly<{
  command: 'generate' | 'decide';
  phase: LocalWorkerPhase | 'request' | 'worker-exit';
  state: 'start' | 'progress' | 'complete' | 'failure' | 'exit';
  elapsedMs: number;
  rssBytes?: number;
  code?: string;
  exitCode?: number;
  signal?: string;
}>;
export type LocalInferenceObserver = (event: LocalInferenceEvent) => void | Promise<void>;
export function localWorkerPhase(value: unknown): { phase: LocalWorkerPhase; rssBytes: number } | undefined {
  try {
    const input = value as any;
    const type = input?.type, phase = input?.phase, rss = input?.rss;
    if (type !== 'phase' || !workerPhases.has(phase) || !Number.isSafeInteger(rss) || rss < 0) return;
    return { phase, rssBytes: rss };
  } catch { return; }
}
/** A fresh instance belongs to one queued task, never to the process-wide shared model pool. */
export class LocalInferenceDiagnostics {
  private readonly started = Date.now();
  private finished = false;
  constructor(private readonly command: LocalInferenceEvent['command'], private readonly observer?: LocalInferenceObserver) {}
  private emit(value: Omit<LocalInferenceEvent, 'command' | 'elapsedMs'>) {
    try {
      const event = Object.freeze({ ...value, command: this.command, elapsedMs: Math.max(0, Math.min(60000, Date.now() - this.started)) });
      void Promise.resolve(this.observer?.(event)).catch(() => {});
    } catch { /* Observability cannot change model execution. */ }
  }
  start() { this.emit({ phase: 'request', state: 'start' }); }
  progress(value: unknown) {
    if (this.finished) return false;
    const phase = localWorkerPhase(value);
    if (!phase) return false;
    this.emit({ ...phase, state: 'progress' });
    return true;
  }
  finish(error?: unknown) {
    if (this.finished) return;
    this.finished = true;
    let code: string | undefined;
    try {
      const value = error as any;
      const rawCode = value?.code, name = value?.name;
      code = errorCodes.has(rawCode) ? rawCode : name === 'AbortError' ? 'aborted' : name === 'TimeoutError' ? 'deadline' : undefined;
    } catch { /* Do not inspect arbitrary thrown values further. */ }
    this.emit({ phase: 'request', state: error === undefined ? 'complete' : 'failure', ...(code ? { code } : {}) });
  }
  exit(code: unknown, signal: unknown) {
    let errorCode: string | undefined;
    try { const rawCode = (code as any)?.code; if (typeof rawCode === 'string' && errorCodes.has(rawCode)) errorCode = rawCode; } catch {}
    this.emit({ phase: 'worker-exit', state: 'exit',
      ...(Number.isInteger(code) && Number(code) >= 0 && Number(code) <= 255 ? { exitCode: Number(code) } : {}),
      ...(typeof signal === 'string' && signals.has(signal) ? { signal } : {}),
      ...(errorCode ? { code: errorCode } : {}),
    });
  }
}
