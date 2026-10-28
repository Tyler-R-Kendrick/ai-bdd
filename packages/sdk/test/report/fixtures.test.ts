import { describe, expect, it } from 'vitest';
import { RunReportSchema } from '../../src/report/schema.ts';
import { type FixtureName, REGENERATE_FIXTURES, describeErrors, readFixture, runReportValidator, validateWithSchema } from './schema-kit.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Path = (string | number)[];
const validate = runReportValidator();
const NAMES: FixtureName[] = ['passed', 'failed'];
const fixture = (name: FixtureName): Json => readFixture(name) as Json;

/** A copy of `value` with the node at `path` replaced (or removed when `replacement` is `undefined`). */
function mutate(value: Json, path: Path, replacement: Json | undefined): Json {
  const copy = structuredClone(value);
  if (path.length === 0) return replacement ?? null;
  let node = copy as Record<string | number, Json>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, Json>;
  const last = path[path.length - 1] as string | number;
  if (replacement === undefined) delete node[last];
  else node[last] = replacement;
  return copy;
}

/** Both validators on one value: Ajv on the committed JSON Schema, and zod, the source the schema is generated from. */
function verdicts(report: Json): { ajv: boolean; zod: boolean; errors: ReturnType<typeof validateWithSchema>['errors'] } {
  const { valid, errors } = validateWithSchema(validate, report);
  return { ajv: valid, zod: RunReportSchema.safeParse(report).success, errors };
}

/** Every path below the root, objects and arrays included. */
function paths(value: Json, base: Path = []): Path[] {
  if (value === null || typeof value !== 'object') return [];
  const entries: [string | number, Json][] = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
  return entries.flatMap(([key, child]) => [[...base, key], ...paths(child, [...base, key])]);
}

describe.each(NAMES)('report.v2.%s.json, captured from a real run', (name) => {
  const report = fixture(name) as Record<string, Json>;

  it(`is valid against the committed schema (Ajv 2020, strict) and against the zod schema; if a fixture is stale: ${REGENERATE_FIXTURES}`, () => {
    const v = verdicts(report);
    expect(v.ajv, describeErrors(v.errors)).toBe(true);
    expect(v.zod).toBe(true);
  });

  it('parses to itself: the zod schema strips and defaults nothing', () => {
    expect(RunReportSchema.parse(report)).toEqual(report);
  });
});

describe('the fixtures say what they claim', () => {
  const passed = fixture('passed') as { exitCode: number; options: Record<string, Json>; scenarios: { status: string; mode: string }[]; usage: { modelCalls: number }; warnings: Json[] };
  const failed = fixture('failed') as {
    exitCode: number;
    totals: Record<string, number>;
    scenarios: { status: string; recording: string; error?: { code: string }; steps: { status: string; judge?: Json; check?: Json }[] }[];
  };

  it('passed: a frozen, agent-free replay with no model calls, exit 0', () => {
    expect(passed.exitCode).toBe(0);
    expect(passed.options).toMatchObject({ frozen: true, noAgent: true });
    expect(passed.scenarios.length).toBeGreaterThan(0);
    expect(passed.scenarios.every((s) => s.status === 'passed' && s.mode === 'replay')).toBe(true);
    expect(passed.usage.modelCalls).toBe(0);
  });

  it('failed: a failed check and a failed judge, healed steps, discarded recordings, exit 1', () => {
    expect(failed.exitCode).toBe(1);
    expect(failed.totals).toMatchObject({ failed: 2, passed: 3 });
    expect(failed.scenarios.flatMap((s) => (s.error === undefined ? [] : [s.error.code])).sort()).toEqual(['CHECK_FAILED', 'JUDGE_FAILED']);
    const steps = failed.scenarios.flatMap((s) => s.steps);
    expect(steps.some((s) => s.status === 'healed')).toBe(true);
    expect(steps.some((s) => s.judge !== undefined)).toBe(true);
    expect(steps.some((s) => s.check !== undefined)).toBe(true);
    expect(failed.scenarios.filter((s) => s.recording === 'discarded')).toHaveLength(2);
  });
});

describe('a report the schema must reject', () => {
  interface Case {
    name: string;
    from: FixtureName;
    path: Path;
    to: Json | undefined;
    /** the Ajv error that must be among those reported: where, and which keyword */
    at: string;
    keyword: string;
  }
  const failedScenario0 = ['scenarios', 0];
  const failedStep0 = ['scenarios', 0, 'steps', 0];
  const judged = ['scenarios', 4, 'steps', 1, 'judge'];
  const cases: Case[] = [
    { name: 'schemaVersion 1 from the legacy report format', from: 'passed', path: ['schemaVersion'], to: 1, at: '/schemaVersion', keyword: 'const' },
    { name: 'an unknown scenario status', from: 'passed', path: [...failedScenario0, 'status'], to: 'flaky', at: '/scenarios/0/status', keyword: 'enum' },
    { name: 'an unknown step status', from: 'passed', path: [...failedStep0, 'status'], to: 'ok', at: '/scenarios/0/steps/0/status', keyword: 'enum' },
    { name: 'an unknown status counted in totals', from: 'passed', path: ['totals', 'flaky'], to: 1, at: '/totals', keyword: 'additionalProperties' },
    { name: 'a status missing from totals', from: 'passed', path: ['totals', 'error'], to: undefined, at: '/totals', keyword: 'required' },
    { name: 'a negative count in totals', from: 'passed', path: ['totals', 'passed'], to: -1, at: '/totals/passed', keyword: 'minimum' },
    { name: 'negative model calls in the run usage', from: 'passed', path: ['usage', 'modelCalls'], to: -1, at: '/usage/modelCalls', keyword: 'minimum' },
    { name: 'negative tokens for one purpose', from: 'failed', path: ['usage', 'byPurpose', 'judge', 'inputTokens'], to: -3, at: '/usage/byPurpose/judge/inputTokens', keyword: 'minimum' },
    { name: 'negative tokens in a step', from: 'passed', path: [...failedStep0, 'usage', 'outputTokens'], to: -1, at: '/scenarios/0/steps/0/usage/outputTokens', keyword: 'minimum' },
    { name: 'negative model calls in a scenario', from: 'passed', path: [...failedScenario0, 'usage', 'modelCalls'], to: -2, at: '/scenarios/0/usage/modelCalls', keyword: 'minimum' },
    { name: 'a negative number of actions', from: 'passed', path: [...failedStep0, 'actions'], to: -1, at: '/scenarios/0/steps/0/actions', keyword: 'minimum' },
    { name: 'a fractional token count', from: 'passed', path: ['usage', 'outputTokens'], to: 1.5, at: '/usage/outputTokens', keyword: 'type' },
    { name: 'exit code 5', from: 'passed', path: ['exitCode'], to: 5, at: '/exitCode', keyword: 'enum' },
    { name: 'the exit code as a string', from: 'passed', path: ['exitCode'], to: '0', at: '/exitCode', keyword: 'type' },
    { name: 'no exit code', from: 'passed', path: ['exitCode'], to: undefined, at: '', keyword: 'required' },
    { name: 'no scenarios', from: 'passed', path: ['scenarios'], to: undefined, at: '', keyword: 'required' },
    { name: 'a field the contract does not have', from: 'passed', path: ['verdict'], to: 'green', at: '', keyword: 'additionalProperties' },
    { name: 'a field the contract does not have on a step', from: 'passed', path: [...failedStep0, 'note'], to: 'x', at: '/scenarios/0/steps/0', keyword: 'additionalProperties' },
    { name: 'an upper-case evidence hash', from: 'failed', path: [...failedScenario0, 'steps', 1, 'evidence', 0, 'sha256'], to: 'E88761294EB96F937486825C7D36AD6B768F6CC335E954E37035B8D492DEE42A', at: '/scenarios/0/steps/1/evidence/0/sha256', keyword: 'pattern' },
    { name: 'a negative artifact size', from: 'failed', path: [...failedScenario0, 'steps', 1, 'evidence', 0, 'bytes'], to: -1, at: '/scenarios/0/steps/1/evidence/0/bytes', keyword: 'minimum' },
    { name: 'an error code the contract does not define', from: 'failed', path: [...failedScenario0, 'error', 'code'], to: 'NOPE', at: '/scenarios/0/error/code', keyword: 'enum' },
    { name: 'an unknown recordings mode', from: 'passed', path: ['options', 'recordingsMode'], to: 'readonly', at: '/options/recordingsMode', keyword: 'enum' },
    { name: 'a predicate the checker does not know', from: 'passed', path: [...failedScenario0, 'steps', 1, 'check', 'results', 0, 'predicate', 'op'], to: 'regex', at: '/scenarios/0/steps/1/check/results/0/predicate', keyword: 'oneOf' },
    { name: 'a warning with an unknown severity', from: 'passed', path: ['warnings'], to: [{ code: 'PLAN_STALE', severity: 'fatal', message: 'x' }], at: '/warnings/0/severity', keyword: 'enum' },
    { name: 'a negative step duration', from: 'passed', path: [...failedStep0, 'durationMs'], to: -1, at: '/scenarios/0/steps/0/durationMs', keyword: 'minimum' },
    { name: 'a negative scenario duration', from: 'passed', path: [...failedScenario0, 'durationMs'], to: -0.5, at: '/scenarios/0/durationMs', keyword: 'minimum' },
    { name: 'a negative estimated cost', from: 'passed', path: ['usage', 'estimatedCostUsd'], to: -0.01, at: '/usage/estimatedCostUsd', keyword: 'minimum' },
    { name: 'a judge score above 1', from: 'failed', path: [...judged, 'score'], to: 1.2, at: '/scenarios/4/steps/1/judge/score', keyword: 'maximum' },
    { name: 'a negative judge spread', from: 'failed', path: [...judged, 'spread'], to: -0.1, at: '/scenarios/4/steps/1/judge/spread', keyword: 'minimum' },
    { name: 'a sample probability above 1', from: 'failed', path: [...judged, 'samples', 0, 'probability'], to: 1.5, at: '/scenarios/4/steps/1/judge/samples/0/probability', keyword: 'maximum' },
    { name: 'a start time without milliseconds', from: 'passed', path: ['startedAt'], to: '2026-10-17T01:14:10Z', at: '/startedAt', keyword: 'pattern' },
    { name: 'a finish time with an offset instead of Z', from: 'passed', path: ['finishedAt'], to: '2026-10-17T03:14:10.915+02:00', at: '/finishedAt', keyword: 'pattern' },
    { name: 'a start time that is a date only', from: 'failed', path: ['startedAt'], to: '2026-10-17', at: '/startedAt', keyword: 'pattern' },
  ];

  it.each(cases)('$name', ({ from, path, to, at, keyword }) => {
    const base = fixture(from);
    expect(verdicts(base).ajv, 'the unmutated fixture is valid').toBe(true);
    const v = verdicts(mutate(base, path, to));
    expect(v.ajv, 'Ajv accepted it').toBe(false);
    expect(v.zod, 'zod accepted it').toBe(false);
    expect(v.errors.map((e) => `${e.instancePath} ${e.keyword}`), describeErrors(v.errors)).toContain(`${at} ${keyword}`);
  });

  it('keeps the other optional fields optional: these variants are valid', () => {
    const variants: [Path, Json][] = [
      [['usage', 'estimatedCostUsd'], 0.25],
      [['warnings'], [{ code: 'PLAN_STALE', severity: 'error', message: 'Plan for docs/a.md is stale', uri: 'docs/a.md', range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 9 }, details: { docs: ['docs/a.md'] } }]],
      [['scenarios', 0, 'confirm'], { runs: 2, reclassified: ['when:abc'], failed: false }],
    ];
    for (const [path, value] of variants) {
      const v = verdicts(mutate(fixture('passed'), path, value));
      expect([v.ajv, v.zod], describeErrors(v.errors)).toEqual([true, true]);
    }
  });
});

describe('the committed JSON Schema and the zod schema it is generated from agree', () => {
  const wrong: Json[] = [null, 'wrong', -1, {}, []];

  it.each(NAMES)('on every deletion and every wrong-typed replacement of every node of report.v2.%s.json', (name) => {
    const base = fixture(name);
    const disagreements: string[] = [];
    let tried = 0;
    let rejected = 0;
    for (const path of paths(base)) {
      for (const to of [undefined, ...wrong]) {
        const v = verdicts(mutate(base, path, to));
        tried += 1;
        if (!v.ajv) rejected += 1;
        if (v.ajv !== v.zod) disagreements.push(`${path.join('/')} -> ${JSON.stringify(to)}: Ajv ${v.ajv ? 'accepts' : 'rejects'}, zod ${v.zod ? 'accepts' : 'rejects'}`);
      }
    }
    expect(disagreements).toEqual([]);
    expect(tried).toBeGreaterThan(1000);
    expect(rejected, 'most mutations break the report, so the comparison is not vacuous').toBeGreaterThan(tried / 2);
  });
});
