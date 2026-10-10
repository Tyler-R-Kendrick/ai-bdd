import type { RunReport, ScenarioResult, StepResult } from '../contracts/index.ts';
import { failureInfo, firstFailingStep, healedSteps, isFailing, oneLine, seconds } from './common.ts';
import { xmlAttr, xmlText } from './xml.ts';

function stepLine(index: number, step: StepResult): string {
  const code = step.error !== undefined ? ` ${step.error.code}` : '';
  return `${index + 1}. [${step.status}${code}] ${step.kind} ${oneLine(step.text)}`;
}

function failureBody(sc: ScenarioResult): string {
  const lines: string[] = [`Scenario: ${oneLine(sc.title)}`, `Status: ${sc.status}`];
  const first = firstFailingStep(sc);
  if (first !== undefined) {
    lines.push(`First failing step: ${first.index + 1} (${first.step.kind}) ${oneLine(first.step.text)}`);
    if (first.step.error !== undefined) lines.push(`Step error: ${first.step.error.code}: ${oneLine(first.step.error.message)}`);
  }
  if (sc.error !== undefined) lines.push(`Scenario error: ${sc.error.code}: ${oneLine(sc.error.message)}`);
  lines.push('Steps:');
  (sc.steps ?? []).forEach((s, i) => lines.push(`  ${stepLine(i, s)}`));
  return lines.join('\n');
}

function healedNote(sc: ScenarioResult): string {
  const lines = ['ai-bdd: this scenario passed only after healing; the recorded replay diverged and the agent re-performed the step(s).'];
  (sc.steps ?? []).forEach((s, i) => {
    if (s.status === 'healed') lines.push(`healed step ${i + 1}: ${s.kind} ${oneLine(s.text)}`);
  });
  return lines.join('\n');
}

function renderTestcase(sc: ScenarioResult): string {
  const healed = healedSteps(sc).length > 0 || sc.status === 'healed';
  const out: string[] = [];
  out.push(`    <testcase name="${xmlAttr(sc.title)}" classname="${xmlAttr(sc.featureId)}" time="${seconds(sc.durationMs)}">`);
  if (healed) {
    out.push('      <properties>');
    out.push('        <property name="ai-bdd.healed" value="true"/>');
    out.push('      </properties>');
  }
  if (sc.status === 'skipped') {
    out.push('      <skipped/>');
  } else if (sc.status === 'error') {
    const info = failureInfo(sc);
    out.push(`      <error message="${xmlAttr(info.message)}" type="${xmlAttr(info.code)}">${xmlText(failureBody(sc))}</error>`);
  } else if (isFailing(sc.status)) {
    const info = failureInfo(sc);
    out.push(`      <failure message="${xmlAttr(info.message)}" type="${xmlAttr(info.code)}">${xmlText(failureBody(sc))}</failure>`);
  }
  if (healed) out.push(`      <system-out>${xmlText(healedNote(sc))}</system-out>`);
  out.push('    </testcase>');
  return out.join('\n');
}

interface Counts { tests: number; failures: number; errors: number; skipped: number; timeMs: number }

function count(scs: readonly ScenarioResult[]): Counts {
  const c: Counts = { tests: scs.length, failures: 0, errors: 0, skipped: 0, timeMs: 0 };
  for (const sc of scs) {
    if (sc.status === 'error') c.errors++;
    else if (sc.status === 'skipped') c.skipped++;
    else if (isFailing(sc.status)) c.failures++;
    c.timeMs += Number.isFinite(sc.durationMs) ? sc.durationMs : 0;
  }
  return c;
}

function countAttrs(c: Counts): string {
  return `tests="${c.tests}" failures="${c.failures}" errors="${c.errors}" skipped="${c.skipped}" time="${seconds(c.timeMs)}"`;
}

/** One `<testsuite>` per feature (in order of first appearance in the report), one `<testcase>` per scenario. */
export function renderJunit(report: RunReport): string {
  const byFeature = new Map<string, ScenarioResult[]>();
  for (const sc of report.scenarios ?? []) {
    const list = byFeature.get(sc.featureId);
    if (list === undefined) byFeature.set(sc.featureId, [sc]);
    else list.push(sc);
  }
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push(`<testsuites name="ai-bdd" ${countAttrs(count(report.scenarios ?? []))}>`);
  for (const [featureId, scs] of byFeature) {
    lines.push(`  <testsuite name="${xmlAttr(featureId)}" ${countAttrs(count(scs))} timestamp="${xmlAttr(report.startedAt)}">`);
    for (const sc of scs) lines.push(renderTestcase(sc));
    lines.push('  </testsuite>');
  }
  lines.push('</testsuites>');
  return `${lines.join('\n')}\n`;
}
