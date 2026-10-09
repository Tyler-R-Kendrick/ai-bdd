/**
 * Document lint (sections 7.3, 7.4 and the `ai-bdd lint` command in 9.2).
 *
 * Rules:
 *  - KIND_INFERRED (info): a step whose kind came from the `default` or
 *    `prefix` heuristic is reported so a human can confirm the classification.
 *  - DIRECTIVE_INVALID_VALUE (warning): an assertion-only directive sits on a
 *    step whose kind is not `assertion`.
 *  - DIRECTIVE_INVALID_VALUE (error): step-scope `failThreshold` is not lower
 *    than `threshold`.
 *  - DIRECTIVE_ORPHAN (warning): a scope carries directives but no step they
 *    could apply to.
 */
import { DIRECTIVE_KEYS } from '@ai-bdd/contracts';
import type { Diagnostic, Scenario, SpecDocument, Step, StepOptions } from '@ai-bdd/contracts';
import { ASSERTION_ONLY_KEYS } from './options.js';

function hasAnyOption(options: Partial<StepOptions>): boolean {
  return DIRECTIVE_KEYS.some((key) => options[key] !== undefined);
}

function ownSteps(scenario: Scenario): Step[] {
  return scenario.steps.filter((step) => step.phase === undefined || step.phase === 'scenario');
}

function lintStep(step: Step, diagnostics: Diagnostic[]): void {
  if (step.kindSource === 'default' || step.kindSource === 'prefix') {
    diagnostics.push({
      code: 'KIND_INFERRED',
      severity: 'info',
      message: `Step kind inferred as "${step.kind}" (${step.kindSource}) for "${step.text}".`,
      location: step.location,
    });
  }
  if (step.kind !== 'assertion') {
    for (const key of ASSERTION_ONLY_KEYS) {
      if (step.options[key] !== undefined) {
        diagnostics.push({
          code: 'DIRECTIVE_INVALID_VALUE',
          severity: 'warning',
          message: `Directive "${key}" only applies to assertion steps, but "${step.text}" is a ${step.kind} step.`,
          location: step.location,
        });
      }
    }
  }
  const { threshold, failThreshold } = step.options;
  if (threshold !== undefined && failThreshold !== undefined && !(failThreshold < threshold)) {
    diagnostics.push({
      code: 'DIRECTIVE_INVALID_VALUE',
      severity: 'error',
      message: `failThreshold (${failThreshold}) must be lower than threshold (${threshold}).`,
      location: step.location,
    });
  }
}

export function lintSteps(doc: SpecDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const totalSteps = doc.contexts.length + doc.teardown.length + doc.scenarios.reduce((n, s) => n + ownSteps(s).length, 0);

  if (hasAnyOption(doc.options) && totalSteps === 0) {
    diagnostics.push({
      code: 'DIRECTIVE_ORPHAN',
      severity: 'warning',
      message: 'Spec directives are not attached to any step.',
      location: { uri: doc.uri, line: 1, column: 1 },
    });
  }

  for (const step of doc.contexts) lintStep(step, diagnostics);
  for (const step of doc.teardown) lintStep(step, diagnostics);

  for (const scenario of doc.scenarios) {
    const steps = ownSteps(scenario);
    if (hasAnyOption(scenario.options) && steps.length === 0) {
      diagnostics.push({
        code: 'DIRECTIVE_ORPHAN',
        severity: 'warning',
        message: `Scenario directives are not attached to any step in "${scenario.name}".`,
        location: scenario.location,
      });
    }
    for (const step of steps) lintStep(step, diagnostics);
  }
  return diagnostics;
}
