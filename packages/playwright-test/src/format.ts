import type { ChunkRef, ScenarioResult, StepResult } from '@ai-bdd/sdk/contracts';

const DETAILS_LIMIT = 800;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function describeSource(sources: readonly ChunkRef[]): string | null {
  const first = sources.find((s) => s.relation === 'source') ?? sources[0];
  if (first === undefined) return null;
  const quote = first.quote === undefined ? '' : ` "${oneLine(first.quote)}"`;
  return `${first.chunkId}${quote}`;
}

/** A human readable listing of the step results, attached to every test. */
export function formatSteps(result: ScenarioResult): string {
  const lines = [`${result.title}`, `status: ${result.status}  mode: ${result.mode}  recording: ${result.recording}`, ''];
  result.steps.forEach((step, i) => {
    const fuzzy = step.determinism === 'fuzzy' ? ` fuzzy(${step.fuzzyReasons.join(',')})` : '';
    lines.push(`${i + 1}. [${step.status}] ${step.kind} ${step.text}  (${step.path}, ${step.determinism}${fuzzy})`);
    if (step.error !== undefined) lines.push(`     ${step.error.code}: ${oneLine(step.error.message)}`);
  });
  return `${lines.join('\n')}\n`;
}

function describeStep(step: StepResult, index: number): string[] {
  const lines = [`  step ${index + 1} [${step.kind}] "${oneLine(step.text)}" ended ${step.status} (path: ${step.path})`];
  if (step.error !== undefined) {
    lines.push(`  error: ${step.error.code}: ${oneLine(step.error.message)}`);
    if (step.error.details !== undefined) {
      const details = JSON.stringify(step.error.details);
      lines.push(`  details: ${details.length > DETAILS_LIMIT ? `${details.slice(0, DETAILS_LIMIT)}...` : details}`);
    }
  }
  const source = describeSource(step.sources);
  if (source !== null) lines.push(`  source: ${source}`);
  return lines;
}

/**
 * Decides whether a scenario result is acceptable. Returns null when it is (passed, or healed without
 * `failOnHealed`), otherwise the failure message naming the failing step and its error code.
 */
export function failureMessage(label: string, result: ScenarioResult, failOnHealed: boolean): string | null {
  if (result.status === 'passed') return null;
  if (result.status === 'healed' && !failOnHealed) return null;

  const lines = [`ai-bdd scenario "${label}" ended ${result.status}`, `  id: ${result.scenarioId}`];
  if (result.status === 'healed') {
    lines.push('  the recording no longer replays as recorded and the agent healed it (failOnHealed is set)');
    const index = result.steps.findIndex((s) => s.status === 'healed');
    const step = result.steps[index];
    if (step !== undefined) lines.push(...describeStep(step, index));
  } else {
    const index = result.steps.findIndex((s) => s.status !== 'passed' && s.status !== 'healed' && s.status !== 'skipped');
    const step = result.steps[index];
    if (step !== undefined) lines.push(...describeStep(step, index));
    if (result.error !== undefined) lines.push(`  scenario error: ${result.error.code}: ${oneLine(result.error.message)}`);
    const skipped = result.steps.filter((s) => s.status === 'skipped').length;
    if (skipped > 0) lines.push(`  ${skipped} later step(s) skipped`);
    if (result.recording === 'discarded') lines.push('  the pending recording was discarded');
  }
  lines.push('  see the attached ai-bdd-result.json and ai-bdd-steps.txt for every step');
  return lines.join('\n');
}
