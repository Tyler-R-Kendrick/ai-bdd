import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Engine, RunReport, ScenarioResult } from '../../src/contracts/index.ts';
import { createEngine, type EngineModules } from '../../src/engine/index.ts';
import { REPORT_DATA_FIELDS } from '../../src/engine/report.ts';
import { createRedactor } from '../../src/evidence/index.ts';
import { RunReportSchema, runReportJsonSchema } from '../../src/report/schema.ts';
import { makeFixture, type Fixture } from './fakes.ts';

const open: { fx: Fixture; engine: Engine }[] = [];
async function setup(opts: Parameters<typeof makeFixture>[0], env: Record<string, string>, overrides: (fx: Fixture) => Partial<EngineModules> = () => ({})) {
  const fx = await makeFixture(opts);
  const engine = await createEngine(fx.config, { modules: { ...fx.modules, ...overrides(fx) }, env });
  open.push({ fx, engine });
  return { fx, engine };
}
afterEach(async () => {
  for (const { fx, engine } of open.splice(0)) {
    await engine.close().catch(() => undefined);
    await rm(fx.world.tmp, { recursive: true, force: true });
  }
});

describe('the run id is the one the engine generated', () => {
  it('R-SE1: an evidence store that returns another run id is refused with INTERNAL, so no chosen text reaches the unredacted runId', async () => {
    const { engine } = await setup({}, {}, (fx) => ({
      createEvidenceStore: async (o) => ({ ...(await fx.modules.createEvidenceStore(o)), runId: 'job-chosen-by-the-store' }),
    }));
    await expect(engine.run()).rejects.toMatchObject({ code: 'INTERNAL', message: 'the evidence store changed the run id the engine generated' });
  });
});

/** A secret `S` read from AI_BDD_S, redacted by the real redactor rather than the fixture's. */
const withSecret = (value: string) => ({
  opts: { user: { secrets: { S: { env: 'AI_BDD_S' } } } },
  env: { AI_BDD_S: value },
  modules: (): Partial<EngineModules> => ({ createRedactor }),
});

describe('every report is redacted', () => {
  it('R-SE1: the exit-4 report of a frozen run passes through the redactor too (its warnings name the docs)', async () => {
    const s = withSecret('billing'); // part of the doc path docs/billing.md, which the PLAN_STALE warning names
    const { engine } = await setup(s.opts, s.env, s.modules);
    const report = await engine.run({ frozen: true });
    expect(report.exitCode).toBe(4);
    expect(report.warnings.map((w) => [w.code, w.uri])).toContainEqual(['PLAN_STALE', 'docs/<secret:S>.md']);
    expect(JSON.stringify(report)).not.toContain('billing');
  });
});

describe('redaction keeps the report schema', () => {
  /** Every step fails with an error whose text, details and predicate results carry `text`, and whose details have a key `key`. */
  const failingWith = (fx: Fixture, text: string, key: string): Partial<EngineModules> => ({
    createRedactor,
    createRunner: (deps) => {
      const runner = fx.modules.createRunner(deps);
      const fail = (r: ScenarioResult): ScenarioResult => ({
        ...r,
        steps: r.steps.map((st) => ({
          ...st,
          error: { code: 'CHECK_FAILED', message: `the ${text} was rejected`, retryable: false, details: { [key]: text, list: [`a ${text}`] } },
          check: { passed: false, results: [{ predicate: { op: 'route', match: 'equals', value: `/${text}` }, satisfied: false, actual: { [key]: 1 } }] },
        })),
      });
      return { runScenario: async (t, o) => fail(await runner.runScenario(t, o)), runAll: async (ts, o) => (await runner.runAll(ts, o)).map(fail) };
    },
  });

  it('R-SE1: a secret equal to a field name (code) does not rename the field; keys inside details and actual are still redacted', async () => {
    const { fx, engine } = await setup({ user: { secrets: { S: { env: 'AI_BDD_S' } } } }, { AI_BDD_S: 'code' }, (f) => failingWith(f, 'code', 'code'));
    const report = await engine.run();
    const written = JSON.parse(await readFile(join(dirname(fx.config.runsDir), 'report', 'report.json'), 'utf8')) as RunReport;
    for (const r of [report, written]) {
      const step = r.scenarios[0]?.steps[0];
      expect(step?.error).toEqual({ code: 'CHECK_FAILED', message: 'the <secret:S> was rejected', retryable: false, details: { '<secret:S>': '<secret:S>', list: ['a <secret:S>'] } });
      expect(step?.check?.results[0]).toEqual({ predicate: { op: 'route', match: 'equals', value: '/<secret:S>' }, satisfied: false, actual: { '<secret:S>': 1 } });
      expect(RunReportSchema.safeParse(r).error).toBeUndefined();
      expect(JSON.stringify(r)).not.toMatch(/"code"\s*:\s*"(?!CHECK_FAILED|PLAN_STALE)/);
    }
  });

  it('R-SE1: a secret in a data key is redacted even when no field name equals it', async () => {
    const secret = 'tok_dummy_marker_0123456789abcdef';
    const { engine } = await setup({ user: { secrets: { S: { env: 'AI_BDD_S' } } } }, { AI_BDD_S: secret }, (f) => failingWith(f, 'x', `session ${secret}`));
    const report = await engine.run();
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.scenarios[0]?.steps[0]?.error?.details).toEqual({ 'session <secret:S>': 'x', list: ['a x'] });
  });

  it('the data fields are exactly the report fields the JSON Schema leaves open (any JSON)', () => {
    const open = new Set<string>();
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (node !== null && typeof node === 'object') {
        const props = (node as { properties?: Record<string, unknown> }).properties ?? {};
        for (const [name, schema] of Object.entries(props)) if ((schema as { $ref?: string }).$ref === '#/$defs/JsonValue') open.add(name);
        Object.values(node).forEach(visit);
      }
    };
    visit(runReportJsonSchema());
    expect([...open].sort()).toEqual([...REPORT_DATA_FIELDS].sort());
  });
});
