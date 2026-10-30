/** Mandatory offline image regression: quota alone does not expose single-affinity oversubscription. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { createLocalLanguageModel, evaluateLocalDecisions, closeLocalModels } from './local-model.js';

assert.equal(process.env.STUDIO_SMOKE_CPU_AFFINITY, '1');
assert.notEqual(process.getuid(), 0);
const directory = process.env.STUDIO_LOCAL_MODEL_DIR;
assert.ok(directory && isAbsolute(directory));

if (process.argv[2] !== '--single-cpu') {
  const allowed = /^Cpus_allowed_list:\s*(\d+)/m.exec(await readFile('/proc/self/status', 'utf8'));
  assert.ok(allowed, 'The Linux image must expose its actual permitted CPU affinity');
  const child = spawn('/usr/bin/taskset', ['-c', allowed[1], process.execPath, fileURLToPath(import.meta.url), '--single-cpu'], {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', NODE_ENV: 'production', STUDIO_SMOKE_CPU_AFFINITY: '1', STUDIO_LOCAL_MODEL_DIR: directory, DO_NOT_TRACK: '1' },
    stdio: 'inherit',
  });
  const ceiling = setTimeout(() => child.kill('SIGKILL'), 90000);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null, 'The actual affinity regression must complete and clean up');
    assert.equal(code, 0);
  } finally { clearTimeout(ceiling); }
} else {
  assert.equal(availableParallelism(), 1, 'Quota-only CPU restriction is insufficient');
  const events = [], cases = [];
  const observer = event => { events.push(event); };
  try {
    const model = createLocalLanguageModel({ directory, onEvent: observer });
    const small = await generateText({ model, system: 'You are a helpful assistant. Answer briefly.', prompt: 'What is 2 + 2?', maxOutputTokens: 64, maxRetries: 0 });
    assert.match(small.text, /\b4\b/);
    cases.push('actual arithmetic chat');
    const json = await generateText({ model, system: 'You are a helpful assistant. Answer briefly.', prompt: 'What is 2 + 2? Return JSON with integer answer.', output: Output.object({ schema: z.object({ answer: z.number().int() }).strict() }), maxOutputTokens: 64, maxRetries: 0 });
    assert.deepEqual(json.output, { answer: 4 });
    cases.push('actual native schema-constrained JSON');
    const start = Date.now();
    const long = await generateText({ model, system: 'You are a helpful assistant. Answer briefly.', prompt: 'Reference context is fixed synthetic data.\n'.repeat(235) + '\nWhat is 2 + 2? Reply only with the numeral.', maxOutputTokens: 32, maxRetries: 0, abortSignal: AbortSignal.timeout(45000) });
    assert.ok(long.text.trim().length > 0, 'The throughput workload must actually generate text');
    assert.ok(long.usage.inputTokens >= 1600, 'The complete long source must reach native inference');
    assert.ok(Date.now() - start < 45000);
    assert.equal(long.providerMetadata?.['llama-cpp-cpu']?.device, 'cpu');
    assert.ok(long.providerMetadata?.['llama-cpp-cpu']?.processRssBytes < 1073741824);
    cases.push('complete long-source prefill and decode within the original 45s budget; throughput only');
    const decisionStart = Date.now();
    const decisions = await evaluateLocalDecisions({ directory, timeoutMs: 30000, onEvent: observer }, {
      input: 'The chosen color is blue. The plan has no human approval.',
      questions: [
        { id: 'blue', kind: 'boolean', instructions: 'Does the document mention the color blue?' },
        { id: 'red', kind: 'boolean', instructions: 'Does the document mention the color red?' },
        { id: 'approval', kind: 'boolean', instructions: 'Has a human approved the plan?' },
        { id: 'color', kind: 'choice', instructions: 'Which color is chosen?', choices: [{ value: 'red' }, { value: 'blue' }, { value: 'green' }] },
        { id: 'coverage', kind: 'score', instructions: 'Select the acceptance-test coverage level.', levels: [{ label: 'No observable acceptance behavior' }, { label: 'Observable behavior but no executable test' }, { label: 'Observable behavior with an executable test' }] },
      ],
    }, AbortSignal.timeout(30000));
    assert.equal(decisions.answers.length, 5);
    assert.equal(decisions.answers[0].value, true);
    assert.equal(decisions.answers[1].value, false);
    assert.equal(decisions.answers[2].value, false);
    assert.equal(decisions.answers[3].value, 'blue');
    const score = decisions.answers[4];
    assert.equal(score.kind, 'score');
    assert.ok(Math.abs(score.value - score.probabilities.reduce((sum, item) => sum + Number(item.value) * item.probability, 0)) < 1e-8);
    assert.equal(decisions.probabilityKind, 'conditional-option-likelihood');
    assert.equal(decisions.calibrated, false);
    assert.ok(decisions.rss < 1073741824);
    assert.ok(Date.now() - decisionStart < 30000);
    for (const answer of decisions.answers) assert.ok(Math.abs(answer.probabilities.reduce((sum, item) => sum + item.probability, 0) - 1) < 1e-8);
    cases.push('actual balanced native predicates and finite ordinal distributions within the original 30s review budget; no general rubric accuracy claim');
    const starts = events.filter(event => event.phase === 'worker-start');
    assert.ok(starts.length >= 4);
    assert.ok(starts.every(event => event.availableParallelism === 1), 'The actual model subprocess must inherit single-CPU affinity');
    assert.ok(events.some(event => event.command === 'generate' && event.phase === 'decode-start'));
    assert.ok(events.some(event => event.command === 'decide' && event.phase === 'prefill-complete'));
    console.log(JSON.stringify({ scope: 'offline-single-affinity-actual-CPU-image-regression', availableParallelism: 1, checks: cases, passed: true }));
  } finally { await closeLocalModels(); }
}
