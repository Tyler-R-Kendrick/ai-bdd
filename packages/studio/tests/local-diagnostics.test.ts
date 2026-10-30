import { afterEach, describe, expect, it } from 'vitest';
import { generateText } from 'ai';
import { LocalInferenceDiagnostics, localWorkerPhase, type LocalInferenceEvent } from '../server/local/local-diagnostics.ts';
import { closeLocalModels, createLocalLanguageModel, evaluateLocalDecisions } from '../server/local/model.ts';

afterEach(() => closeLocalModels());
it('accepts only finite worker phases and projects out all input/output/error payloads', () => {
  const events: LocalInferenceEvent[] = [];
  const observer = new LocalInferenceDiagnostics('generate', event => { events.push(event); });
  expect(observer.progress({ type: 'phase', phase: 'weights-verified', rss: 12345, prompt: 'SECRET', output: 'SECRET', path: '/SECRET', cause: new Error('SECRET') })).toBe(true);
  let reads = 0;
  expect(localWorkerPhase({ type: 'phase', get phase() { return ++reads === 1 ? 'worker-start' : 'SECRET'; }, rss: 1 })).toEqual({ phase: 'worker-start', rssBytes: 1 });
  for (const value of [
    { type: 'phase', phase: 'SECRET', rss: 1 },
    { type: 'phase', phase: 'model-loaded', rss: NaN },
    { type: 'phase', phase: 'model-loaded', rss: -1 },
    { type: 'phase', phase: 'model-loaded', rss: Infinity },
    Object.defineProperty({}, 'type', { get() { throw new Error('SECRET'); } }),
  ]) expect(localWorkerPhase(value)).toBeUndefined();
  observer.finish(Object.assign(new Error('SECRET'), { code: 'deadline', cause: 'SECRET', toJSON() { throw new Error('SECRET'); } }));
  observer.finish(new Error('SECRET'));
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({ phase: 'request', command: 'generate', state: 'failure', code: 'deadline' });
  expect(events.every(Object.isFrozen)).toBe(true);
  expect(JSON.stringify(events)).not.toContain('SECRET');
});
it('keeps hostile exceptions and observer failures outside execution and bounded exit metadata', async () => {
  const events: LocalInferenceEvent[] = [];
  const observer = new LocalInferenceDiagnostics('decide', event => { events.push(event); return Promise.reject(new Error('SECRET')); });
  observer.start();
  observer.exit(Object.assign(new Error('SECRET'), { code: 'SECRET' }), 'SECRET');
  observer.exit(1, 'SIGKILL');
  observer.finish(Object.defineProperty({}, 'code', { get() { throw new Error('SECRET'); } }));
  await new Promise(resolve => setImmediate(resolve));
  expect(events[2]).toMatchObject({ phase: 'worker-exit', exitCode: 1, signal: 'SIGKILL' });
  expect(JSON.stringify(events)).not.toContain('SECRET');
  const sync = new LocalInferenceDiagnostics('generate', () => { throw new Error('SECRET'); });
  expect(() => { sync.start(); sync.progress({ type: 'phase', phase: 'worker-start', rss: 1 }); sync.finish(); }).not.toThrow();
});

const directory = process.env.STUDIO_LOCAL_TEST_MODEL_DIR;
if (process.env.STUDIO_REQUIRE_LOCAL_MODEL_TEST === '1' && !directory) throw new Error('Real model directory is required');
describe.skipIf(!directory)('actual shared CPU phase IPC', () => {
  it('keeps generation and decision observers with their own task despite throwing callbacks', async () => {
    const generation: LocalInferenceEvent[] = [], decisions: LocalInferenceEvent[] = [];
    const model = createLocalLanguageModel({ directory: directory!, onEvent: event => {
      generation.push(event);
      if (generation.length % 2) throw new Error('SECRET');
      return Promise.reject(new Error('SECRET'));
    } });
    const [answer, decision] = await Promise.all([
      generateText({ model, system: 'Answer briefly.', prompt: 'What is 2 + 2?', maxOutputTokens: 32, maxRetries: 0 }),
      evaluateLocalDecisions({ directory: directory!, onEvent: event => { decisions.push(event); } }, {
        input: 'The chosen color is blue.',
        questions: [{ id: 'blue', kind: 'boolean', instructions: 'Does the document mention blue?' }],
      }),
    ]);
    expect(answer.text).toContain('4');
    expect(decision.probabilityKind).toBe('conditional-option-likelihood');
    expect(generation.every(event => event.command === 'generate')).toBe(true);
    expect(decisions.every(event => event.command === 'decide')).toBe(true);
    for (const phase of ['worker-start', 'weights-verified', 'binding-loaded', 'model-loaded', 'inference-start', 'complete'])
      expect([...generation, ...decisions].some(event => event.phase === phase)).toBe(true);
    expect(decisions.some(event => event.phase === 'inference-start')).toBe(true);
    expect(generation.at(-1)).toMatchObject({ phase: 'request', state: 'complete' });
    expect(decisions.at(-1)).toMatchObject({ phase: 'request', state: 'complete' });
    expect(JSON.stringify([...generation, ...decisions])).not.toMatch(/SECRET|chosen color|What is/);
  });
});
