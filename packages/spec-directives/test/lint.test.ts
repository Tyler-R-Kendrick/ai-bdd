import { describe, expect, it } from 'vitest';
import type { Scenario, SourceLocation, SpecDocument, Step } from '@ai-bdd/contracts';
import { lintSteps } from '../src/index.js';

function loc(line: number): SourceLocation {
  return { uri: 'lint://spec', line, column: 1 };
}

function mkStep(partial: {
  id?: string;
  text: string;
  kind: Step['kind'];
  kindSource: Step['kindSource'];
  options?: Step['options'];
  phase?: Step['phase'];
}): Step {
  const step: Step = {
    id: partial.id ?? `step:${partial.text}`,
    text: partial.text,
    normalized: partial.text,
    kind: partial.kind,
    kindSource: partial.kindSource,
    args: [],
    location: loc(1),
    options: partial.options ?? {},
    originChain: [],
  };
  if (partial.phase !== undefined) step.phase = partial.phase;
  return step;
}

function mkScenario(partial: { name: string; options?: Scenario['options']; steps?: Step[] }): Scenario {
  return {
    id: `lint://spec#${partial.name}`,
    name: partial.name,
    tags: [],
    steps: partial.steps ?? [],
    options: partial.options ?? {},
    location: loc(2),
  };
}

function mkDoc(partial: {
  options?: SpecDocument['options'];
  contexts?: Step[];
  teardown?: Step[];
  scenarios?: Scenario[];
}): SpecDocument {
  return {
    id: 'lint://spec',
    name: 'Lint',
    uri: 'lint://spec',
    dialect: 'gauge',
    tags: [],
    options: partial.options ?? {},
    contexts: partial.contexts ?? [],
    teardown: partial.teardown ?? [],
    scenarios: partial.scenarios ?? [],
    diagnostics: [],
  };
}

const codes = (doc: SpecDocument): string[] => lintSteps(doc).map((d) => d.code);

describe('lintSteps (sections 7.3-7.4)', () => {
  it('reports inferred kinds for default and prefix steps', () => {
    const doc = mkDoc({
      scenarios: [
        mkScenario({
          name: 'S',
          steps: [
            mkStep({ text: 'open billing', kind: 'action', kindSource: 'default' }),
            mkStep({ text: 'the badge reads Pro', kind: 'assertion', kindSource: 'prefix' }),
          ],
        }),
      ],
    });
    const diagnostics = lintSteps(doc);
    expect(diagnostics.map((d) => d.code)).toEqual(['KIND_INFERRED', 'KIND_INFERRED']);
    expect(diagnostics.every((d) => d.severity === 'info')).toBe(true);
  });

  it('does not report keyword or directive kinds', () => {
    const doc = mkDoc({
      scenarios: [
        mkScenario({
          name: 'S',
          steps: [mkStep({ text: 'x', kind: 'setup', kindSource: 'keyword' }), mkStep({ text: 'y', kind: 'action', kindSource: 'directive' })],
        }),
      ],
    });
    expect(codes(doc)).toEqual([]);
  });

  it('flags assertion-only directives on non-assertion steps', () => {
    const doc = mkDoc({
      scenarios: [
        mkScenario({
          name: 'S',
          steps: [mkStep({ text: 'open billing', kind: 'action', kindSource: 'directive', options: { mode: 'judge' } })],
        }),
      ],
    });
    const diagnostics = lintSteps(doc);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('DIRECTIVE_INVALID_VALUE');
    expect(diagnostics[0]?.severity).toBe('warning');
  });

  it('accepts assertion-only directives on assertion steps', () => {
    const doc = mkDoc({
      scenarios: [
        mkScenario({
          name: 'S',
          steps: [mkStep({ text: 'the badge reads Pro', kind: 'assertion', kindSource: 'keyword', options: { mode: 'judge', vision: true } })],
        }),
      ],
    });
    expect(codes(doc)).toEqual([]);
  });

  it('flags a step-scope failThreshold that is not below threshold', () => {
    const doc = mkDoc({
      scenarios: [
        mkScenario({
          name: 'S',
          steps: [mkStep({ text: 'the badge reads Pro', kind: 'assertion', kindSource: 'keyword', options: { threshold: 0.5, failThreshold: 0.6 } })],
        }),
      ],
    });
    const diagnostics = lintSteps(doc);
    expect(diagnostics.map((d) => d.code)).toEqual(['DIRECTIVE_INVALID_VALUE']);
    expect(diagnostics[0]?.severity).toBe('error');
  });

  it('reports spec directives that have no step', () => {
    expect(codes(mkDoc({ options: { kind: 'setup' } }))).toEqual(['DIRECTIVE_ORPHAN']);
  });

  it('reports scenario directives that have no step', () => {
    const doc = mkDoc({ scenarios: [mkScenario({ name: 'Empty', options: { mode: 'judge' } })] });
    expect(codes(doc)).toEqual(['DIRECTIVE_ORPHAN']);
  });

  it('lints context and teardown steps', () => {
    const doc = mkDoc({
      contexts: [mkStep({ text: 'seed a workspace', kind: 'action', kindSource: 'default' })],
      teardown: [mkStep({ text: 'reset data', kind: 'action', kindSource: 'default' })],
    });
    expect(codes(doc)).toEqual(['KIND_INFERRED', 'KIND_INFERRED']);
  });

  it('does not double-lint the context copies inlined into scenarios', () => {
    const doc = mkDoc({
      contexts: [mkStep({ text: 'seed a workspace', kind: 'action', kindSource: 'default' })],
      scenarios: [
        mkScenario({
          name: 'S',
          steps: [
            mkStep({ text: 'seed a workspace', kind: 'action', kindSource: 'default', phase: 'context' }),
            mkStep({ text: 'open billing', kind: 'action', kindSource: 'default', phase: 'scenario' }),
          ],
        }),
      ],
    });
    expect(codes(doc)).toEqual(['KIND_INFERRED', 'KIND_INFERRED']);
  });
});
