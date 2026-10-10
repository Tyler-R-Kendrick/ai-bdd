import { AiBddError, notImplemented, type Clock, type CreateEvidenceStore, type CreateRedactor, type CreateSettler, type VerifyRun } from '../contracts/index.ts';
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new AiBddError('ABORTED', 'aborted')); }, { once: true });
    }),
};
export const createEvidenceStore: CreateEvidenceStore = () => notImplemented('evidence.createEvidenceStore');
export const createRedactor: CreateRedactor = () => notImplemented('evidence.createRedactor');
export const createSettler: CreateSettler = () => notImplemented('evidence.createSettler');
export const verifyRun: VerifyRun = () => notImplemented('evidence.verifyRun');
