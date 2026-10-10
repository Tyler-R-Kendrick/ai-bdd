// Chaos 9: secrets under chaos. A secret value is injected, then EVERY failure path is forced with the secret (and its encodings) in
// the error text: driver errors and raw exceptions, model errors, failed outcomes, lost sessions, failing cleanup. The value must
// appear in no file under .ai-bdd, not in stdout or stderr, not in the report, not in anything sent to a model, and not in the
// errors the SDK throws or returns.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DriverRule, ModelRule } from '@ai-bdd/testing';
import {
  T,
  chaosEngine,
  cliOutput,
  compilePlain,
  configArg,
  createProject,
  findSecret,
  runCli,
  secretForms,
  walkFiles,
  writeChaosConfig,
  type Project,
} from './helpers/kit.ts';

const SECRET = 'Zq7-uniq/Secret+Value!99';
const forms = secretForms(SECRET);
/** The text every injected failure carries: the raw value and the encodings the redactor promises to catch. */
const LEAK = `credential ${forms.raw} | ${forms.urlEncoded} | ${forms.base64} | ${forms.base64Unpadded} | ${JSON.stringify(forms.raw)}`;
const NEEDLES = [forms.raw, forms.urlEncoded, forms.base64, forms.base64Unpadded, JSON.stringify(forms.raw).slice(1, -1)];

const hasSecret = (text: string): string | undefined => NEEDLES.find((n) => n.length >= 4 && text.includes(n));

/** Every file under .ai-bdd plus the fake-model call log (what the models were sent): none may hold the secret. */
function scanFiles(project: Project): { file: string; form: string }[] {
  const hits: { file: string; form: string }[] = findSecret([project.aiBddDir, project.logPath], SECRET).map((h) => ({ file: h.file.slice(project.dir.length), form: h.form }));
  const json = walkFiles(project.aiBddDir).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl') || f.endsWith('.md') || f.endsWith('.xml') || f.endsWith('.txt'));
  for (const f of json) {
    const needle = hasSecret(readFileSync(f, 'utf8'));
    if (needle !== undefined && !hits.some((h) => h.file === f.slice(project.dir.length))) hits.push({ file: f.slice(project.dir.length), form: `needle:${needle}` });
  }
  return hits;
}

interface Case {
  name: string;
  driver?: DriverRule[];
  models?: ModelRule[];
  args: string[];
  /** compile first (so `run --no-compile` has plans) */
  planned: boolean;
}

const CASES: Case[] = [
  { name: 'driver: observe throws', driver: [{ at: 'observe', from: 3, fault: { kind: 'throw', code: 'DRIVER_ERROR', message: LEAK } }], args: ['run', '--no-compile'], planned: true },
  { name: 'driver: observe throws a plain Error', driver: [{ at: 'observe', from: 3, fault: { kind: 'throw-raw', message: LEAK } }], args: ['run', '--no-compile'], planned: true },
  { name: 'driver: perform throws a plain Error', driver: [{ at: 'perform', nth: 2, fault: { kind: 'throw-raw', message: LEAK } }], args: ['run', '--no-compile'], planned: true },
  { name: 'driver: perform reports { ok: false } with the secret', driver: [{ at: 'perform', nth: 2, fault: { kind: 'fail', message: LEAK } }], args: ['run', '--no-compile'], planned: true },
  { name: 'driver: session lost with the secret in the message', driver: [{ at: 'perform', nth: 3, fault: { kind: 'drop-session', message: LEAK } }], args: ['run', '--no-compile'], planned: true },
  { name: 'driver: openSession unavailable', driver: [{ at: 'openSession', fault: { kind: 'throw', code: 'DRIVER_UNAVAILABLE', message: LEAK } }], args: ['run', '--no-compile'], planned: true },
  { name: 'driver: create unavailable', driver: [{ at: 'create', fault: { kind: 'throw', code: 'DRIVER_UNAVAILABLE', message: LEAK } }], args: ['run', '--no-compile'], planned: true },
  { name: 'driver: close fails', driver: [{ at: 'close', fault: { kind: 'throw', code: 'DRIVER_ERROR', message: LEAK } }], args: ['run', '--no-compile'], planned: true },
  { name: 'driver: dispose fails', driver: [{ at: 'dispose', fault: { kind: 'throw-raw', message: LEAK } }], args: ['run', '--no-compile'], planned: true },
  { name: 'model: act unavailable', models: [{ at: 'act', fault: { kind: 'unavailable', message: LEAK } }], args: ['run', '--no-compile'], planned: true },
  { name: 'model: act throws a plain Error', models: [{ at: 'act', fault: { kind: 'throw-raw', message: LEAK } }], args: ['run', '--no-compile'], planned: true },
  { name: 'model: judge rate limited', models: [{ at: 'judge', fault: { kind: 'rate-limit', message: LEAK } }], args: ['run', '--no-compile'], planned: true },
  { name: 'model: checkgen throws a plain Error', models: [{ at: 'checkgen', fault: { kind: 'throw-raw', message: LEAK } }], args: ['run', '--no-compile'], planned: true },
  { name: 'model: extract unavailable (compile)', models: [{ at: 'extract', fault: { kind: 'unavailable', message: LEAK } }], args: ['compile'], planned: false },
  { name: 'model: extract throws a plain Error (compile)', models: [{ at: 'extract', fault: { kind: 'throw-raw', message: LEAK } }], args: ['compile'], planned: false },
  { name: 'model: extract throws a plain Error (run compiles first)', models: [{ at: 'extract', fault: { kind: 'throw-raw', message: LEAK } }], args: ['run'], planned: false },
];

describe('chaos 9: the secret never surfaces through the CLI', () => {
  for (const c of CASES) {
    it.concurrent(`${c.name}`, async () => {
      const project = createProject({ docs: ['login'] });
      try {
        if (c.planned) await compilePlain(project);
        const config = writeChaosConfig(project, {
          ...(c.driver === undefined ? {} : { driverPlan: { seed: 'sec', rules: c.driver } }),
          ...(c.models === undefined ? {} : { modelPlan: { seed: 'sec', rules: c.models } }),
          adminPassword: SECRET,
        });
        const r = await runCli(project, c.args, { config: configArg(project, config), env: { ACME_ADMIN_PASSWORD: SECRET, AI_BDD_DEBUG: '1' }, timeoutMs: 120_000 });
        expect([0, 1, 2, 3, 4], cliOutput(r)).toContain(r.code);
        expect(hasSecret(r.stdout), 'stdout').toBeUndefined();
        expect(hasSecret(r.stderr), 'stderr').toBeUndefined();
        expect(scanFiles(project), 'files').toEqual([]);
      } finally {
        project.cleanup();
      }
    });
  }

  it.concurrent('a clean characterization with the same secret really exercises the redactor (the scan is not vacuous): the value was typed into the app, yet appears nowhere', async () => {
    const project = createProject({ docs: ['login'] });
    try {
      const config = writeChaosConfig(project, { adminPassword: SECRET });
      const r = await runCli(project, ['run'], { config: configArg(project, config), env: { ACME_ADMIN_PASSWORD: SECRET } });
      expect(r.code, cliOutput(r)).toBe(0);
      expect(r.stdout).toContain('PASS');
      expect(JSON.stringify(readFileSync(project.logPath, 'utf8'))).toContain('adminPassword'); // the model saw the secret's NAME
      expect(scanFiles(project)).toEqual([]);
      expect(hasSecret(r.stdout + r.stderr)).toBeUndefined();
    } finally {
      project.cleanup();
    }
  });
});

describe('chaos 9: the secret never surfaces through the SDK (results, events, thrown errors, files)', () => {
  const DRIVER_HOOKS: [DriverRule['at'], DriverRule['fault']][] = [
    ['create', { kind: 'throw', code: 'DRIVER_UNAVAILABLE', message: LEAK }],
    ['create', { kind: 'throw-raw', message: LEAK }],
    ['openSession', { kind: 'throw', code: 'SESSION_LIMIT', message: LEAK }],
    ['openSession', { kind: 'throw-raw', message: LEAK }],
    ['observe', { kind: 'throw', code: 'DRIVER_ERROR', message: LEAK }],
    ['observe', { kind: 'throw-raw', message: LEAK }],
    ['observe', { kind: 'drop-session', message: LEAK }],
    ['perform', { kind: 'throw', code: 'DRIVER_UNAVAILABLE', message: LEAK }],
    ['perform', { kind: 'throw-raw', message: LEAK }],
    ['perform', { kind: 'fail', code: 'TARGET_NOT_FOUND', message: LEAK }],
    ['perform', { kind: 'drop-session', message: LEAK }],
    ['close', { kind: 'throw-raw', message: LEAK }],
    ['dispose', { kind: 'throw-raw', message: LEAK }],
  ];
  const MODEL_FAULTS: [ModelRule['at'], ModelRule['fault']][] = [
    ['act', { kind: 'unavailable', message: LEAK }],
    ['act', { kind: 'rate-limit', message: LEAK }],
    ['act', { kind: 'throw', code: 'MODEL_OUTPUT_INVALID', message: LEAK }],
    ['act', { kind: 'throw-raw', message: LEAK }],
    ['checkgen', { kind: 'throw-raw', message: LEAK }],
    ['checkgen', { kind: 'unavailable', message: LEAK }],
    ['judge', { kind: 'throw', code: 'MODEL_UNAVAILABLE', message: LEAK }],
    ['judge', { kind: 'throw-raw', message: LEAK }],
    ['judge', { kind: 'timeout', ms: 1000 }],
  ];

  async function drive(driver: DriverRule[], models: ModelRule[]): Promise<{ texts: string[]; project: Project }> {
    const project = createProject({ docs: ['login'] });
    const texts: string[] = [];
    await compilePlain(project);
    const ce = await chaosEngine(project, {
      prepare: { adminPassword: SECRET },
      ...(driver.length > 0 ? { driverPlan: { seed: 'sdk', rules: driver } } : {}),
      ...(models.length > 0 ? { modelPlan: { seed: 'sdk', rules: models } } : {}),
    });
    try {
      const report = await ce.h.run();
      texts.push(JSON.stringify(report));
    } catch (err) {
      texts.push(`run rejected: ${err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)}`);
    }
    texts.push(JSON.stringify(ce.h.events));
    try {
      await ce.h.close();
    } catch (err) {
      texts.push(`close rejected: ${err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)}`);
    }
    return { texts, project };
  }

  for (const [at, fault] of DRIVER_HOOKS) {
    it(`driver ${at} / ${fault.kind}`, async () => {
      const { texts, project } = await drive([{ at, fault } as DriverRule], []);
      try {
        for (const t of texts) expect(hasSecret(t), t.slice(0, 400)).toBeUndefined();
        expect(scanFiles(project)).toEqual([]);
      } finally {
        project.cleanup();
      }
    });
  }

  for (const [at, fault] of MODEL_FAULTS) {
    it(`model ${at} / ${fault.kind}`, async () => {
      const { texts, project } = await drive([], [{ at, fault } as ModelRule]);
      try {
        for (const t of texts) expect(hasSecret(t), t.slice(0, 400)).toBeUndefined();
        expect(scanFiles(project)).toEqual([]);
      } finally {
        project.cleanup();
      }
    });
  }

  it('compile with a model that throws the secret: the returned diagnostics and the thrown errors are clean', async () => {
    const project = createProject({ docs: ['login'] });
    try {
      const ce = await chaosEngine(project, { prepare: { adminPassword: SECRET }, modelPlan: { seed: 'c', rules: [{ at: 'extract', fault: { kind: 'throw-raw', message: LEAK } }] } });
      const result = await ce.h.compile();
      expect(hasSecret(JSON.stringify(result))).toBeUndefined();
      await ce.h.close();
      expect(scanFiles(project)).toEqual([]);
      expect(T.login.length).toBeGreaterThan(0);
    } finally {
      project.cleanup();
    }
  });
});
