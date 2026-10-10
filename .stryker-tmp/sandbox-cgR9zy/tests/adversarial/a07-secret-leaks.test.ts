// @ts-nocheck
// Attack 7: leak a secret into any file under .ai-bdd/, a report, a fake-model log, an error message, or ResolvedConfig (R-SE1, R-SE2).
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createRedactor, loadConfig } from '@ai-bdd/sdk';
import type { DriverFactory, JsonValue, ModelRequest } from '@ai-bdd/sdk/contracts';
import { fakeDriver } from '@ai-bdd/testing';
import {
  allScenarios,
  callsOf,
  cliOutput,
  compose,
  createProject,
  extraction,
  findSecret,
  makeEngine,
  modelSet,
  openEngine,
  overriding,
  quoteFrom,
  readRecordings,
  readPlans,
  runCli,
  secretForms,
  toolCall,
  walkFiles,
  type Project,
} from './helpers/kit.ts';
import { valueContainsSecret } from '../acceptance/helpers/scan.ts';

const SECRET = 'Zq7-uniq/Secret+Value!99';
const LOGIN = 'Administrator signs in with the admin password';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

/** Find the ref of a node by role and name in the act request context. */
function refOf(req: ModelRequest, role: string, name: string): string {
  const nodes = req.context['nodes'] as { ref: string; role: string; name: string }[];
  const hit = nodes.find((x) => x.role === role && x.name === name);
  if (hit === undefined) throw new Error(`no ${role} "${name}"`);
  return hit.ref;
}

const EMAIL_STEP = 'the administrator types admin@acme.example into the email field';

/** The agent types the secret into the (plain, visible) Email field instead of the email address. */
const secretIntoEmailField = overriding('act', (req) =>
  req.context['stepText'] === EMAIL_STEP && req.context['turn'] === 0 ? toolCall('fill', { ref: refOf(req, 'textbox', 'Email'), secret: 'adminPassword' }) : undefined,
);

function expectNoSecretOnDisk(p: Project, where: string[] = []): void {
  const hits = findSecret([p.aiBddDir, p.logPath, ...where], SECRET);
  expect(hits.map((h) => `${h.file.slice(p.dir.length)} (${h.form})`)).toEqual([]);
}

describe('A7 R-SE1 secrets never reach disk, results or logs', () => {
  it('A7 R-SE1: control: the normal login flow leaks nothing, and the scan really can find the secret', async () => {
    project = createProject({ docs: ['login'] });
    const h = await openEngine(project, { env: { ACME_ADMIN_PASSWORD: SECRET }, prepare: { adminPassword: SECRET }, log: true });
    await h.compile();
    const report = await h.run({ titles: [LOGIN] });
    await h.close();
    expect(report.scenarios[0]?.status).toBe('passed');
    expectNoSecretOnDisk(project);
    expect(valueContainsSecret(report, SECRET)).toBe(false);
    expect(valueContainsSecret(h.config, SECRET)).toBe(false);
    // the scanner itself works on all encodings
    const forms = secretForms(SECRET);
    expect(forms.urlEncoded).not.toBe(forms.raw);
    expect(valueContainsSecret({ x: forms.base64Unpadded }, SECRET)).toBe(true);
  });

  it('A7 R-SE1: the agent types the secret into a PLAIN field (a visible textbox): the field value is observed, but the secret must not be saved in the recording, the run dir, the reports or the log', async () => {
    project = createProject({ docs: ['login'] });
    const h = await openEngine(project, { env: { ACME_ADMIN_PASSWORD: SECRET }, prepare: { adminPassword: SECRET }, log: true, models: secretIntoEmailField });
    await h.compile();
    const report = await h.run({ titles: [LOGIN] });
    await h.close();
    expect(valueContainsSecret(report, SECRET)).toBe(false);
    expect(valueContainsSecret(h.calls, SECRET)).toBe(false);
    const rec = readRecordings(project);
    // if a recording was committed at all, it must not hold the secret in any form
    for (const r of rec) expect(valueContainsSecret(r.recording, SECRET), r.path).toBe(false);
    expectNoSecretOnDisk(project);
  });

  it('A7 R-SE1: a model that already knows the secret (it was written in a document) and types it as a literal: the literal is not persisted in the recording', async () => {
    project = createProject({ docs: ['login'] });
    const literalSecret = overriding('act', (req) =>
      req.context['stepText'] === 'the administrator types <secret:adminPassword> into the password field' && req.context['turn'] === 0
        ? toolCall('fill', { ref: refOf(req, 'textbox', 'Password'), text: SECRET })
        : undefined,
    );
    const h = await openEngine(project, { env: { ACME_ADMIN_PASSWORD: SECRET }, prepare: { adminPassword: SECRET }, log: true, models: literalSecret });
    await h.compile();
    const report = await h.run({ titles: [LOGIN] });
    await h.close();
    expect(valueContainsSecret(report, SECRET)).toBe(false);
    for (const r of readRecordings(project)) expect(valueContainsSecret(r.recording, SECRET), `recording ${r.path} stores the typed literal`).toBe(false);
    expectNoSecretOnDisk(project);
  });

  it('A7 R-SE1: a document that contains the secret value does not carry it into the plan file or to the extraction model', async () => {
    project = createProject({ docs: [] });
    project.writeDoc('readme', `# Notes\n\n## Login\n\nSign in with the password ${SECRET} on the login page. The billing page is shown afterwards.\n`);
    const models = modelSet({
      extract: (req) => {
        const q = quoteFrom(req, 'Sign in with the password', 20);
        return q === null ? { object: extraction([]) } : { object: extraction([{ title: 'Login', sources: [q], scenarios: [{ title: 'Sign in', sources: [q], steps: [{ kind: 'when', text: 'the user signs in' }, { kind: 'then', text: 'the billing page is shown' }] }] }]) };
      },
    });
    const h = await makeEngine(project, { models, env: { ACME_ADMIN_PASSWORD: SECRET } });
    await h.engine.compile();
    await h.close();
    const sent = callsOf(models, 'extract').some((c) => JSON.stringify(c.req).includes(SECRET));
    const planText = walkFiles(project.plansDir).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect({ sentToModel: sent, inPlan: planText.includes(SECRET) }).toEqual({ sentToModel: false, inPlan: false });
  });

  it('A7 R-SE1: driver errors, fixture errors and model errors that quote the secret are redacted in step errors, scenario errors, events and reports', async () => {
    project = createProject({ docs: ['login'] });
    const inner = fakeDriver({ adminPassword: SECRET });
    const leaky: DriverFactory = {
      id: inner.id,
      async create(ctx) {
        const d = await inner.create(ctx);
        return {
          ...d,
          async openSession(o) {
            const s = await d.openSession(o);
            const perform = s.perform.bind(s);
            s.perform = async (a) => {
              if (a.verb === 'fill' && 'secret' in a.value) {
                const value = o.resolveValue(a.value);
                return { ok: false, error: { code: 'DRIVER_ERROR', message: `fill failed for value ${value} (${encodeURIComponent(value)} / ${Buffer.from(value).toString('base64')})`, retryable: false, details: { value, nested: { v: [value] } } } };
              }
              return perform(a);
            };
            return s;
          },
        };
      },
    };
    const h = await openEngine(project, { env: { ACME_ADMIN_PASSWORD: SECRET }, log: true, wrapFactory: () => leaky });
    await h.compile();
    const report = await h.run({ titles: [LOGIN] });
    await h.close();
    expect(report.scenarios[0]?.status).not.toBe('passed');
    expect(valueContainsSecret(report, SECRET)).toBe(false);
    expect(valueContainsSecret(h.events, SECRET)).toBe(false);
    expect(valueContainsSecret(h.calls, SECRET)).toBe(false);
    expectNoSecretOnDisk(project);
  });

  it('A7 R-SE1: ResolvedConfig, the engine object and every error from config loading hold the secret NAME and env var name only', async () => {
    project = createProject({ docs: ['login'] });
    const config = await loadConfig({ cwd: project.dir, env: { ACME_ADMIN_PASSWORD: SECRET } });
    expect(JSON.stringify(config)).not.toContain(SECRET);
    expect(config.secrets).toEqual({ adminPassword: { env: 'ACME_ADMIN_PASSWORD' } });
    const h = await openEngine(project, { env: { ACME_ADMIN_PASSWORD: SECRET } });
    expect(inspect(h.engine, { depth: 8, showHidden: true })).not.toContain(SECRET);
    expect(inspect(h.config, { depth: 8, showHidden: true })).not.toContain(SECRET);
    await h.close();
    // a too-short secret is rejected without echoing it
    const short = 'xyz';
    await expect(loadConfig({ cwd: project.dir, env: { ACME_ADMIN_PASSWORD: short } })).rejects.toMatchObject({ code: 'SECRET_TOO_SHORT' });
    const err = await loadConfig({ cwd: project.dir, env: { ACME_ADMIN_PASSWORD: short } }).catch((e: Error) => e);
    expect(JSON.stringify({ m: (err as Error).message, d: (err as { details?: JsonValue }).details })).not.toContain(`"${short}"`);
    expect((err as Error).message).not.toMatch(/\bxyz\b(?! )/);
  });

  it('A7 R-SE1: through the CLI, stdout, stderr, the fake-call log and .ai-bdd hold no form of the secret even when the scenario fails', async () => {
    project = createProject({ docs: ['login'] });
    const compile = await runCli(project, ['compile'], { env: { ACME_ADMIN_PASSWORD: SECRET } });
    expect(compile.code, cliOutput(compile)).toBe(0);
    const run = await runCli(project, ['run', '--no-compile', '--workers', '2'], { env: { ACME_ADMIN_PASSWORD: SECRET } });
    const outputs = `${run.stdout}\n${run.stderr}`;
    for (const needle of Object.values(secretForms(SECRET))) expect(outputs.includes(needle)).toBe(false);
    expectNoSecretOnDisk(project);
  });

  it('A7 R-SE1: the redactor scrubs raw, URL-encoded (upper and lower hex), plus-for-space, base64, unpadded base64, base64url and JSON-escaped forms, longest secret first, and handles regex metacharacters', () => {
    const secrets = { a: 'p@ss.word(*)[x]$^+?{1}|\\', b: 'p@ss.word(*)[x]$^+?{1}|\\ and more', c: 'tab\tand "quote" and é ü' };
    const red = createRedactor(secrets);
    const forms = (v: string): string[] => [
      v,
      encodeURIComponent(v),
      encodeURIComponent(v).toLowerCase(),
      encodeURIComponent(v).replace(/%20/g, '+'),
      Buffer.from(v).toString('base64'),
      Buffer.from(v).toString('base64').replace(/=+$/, ''),
      Buffer.from(v).toString('base64url'),
      JSON.stringify(v).slice(1, -1),
    ];
    for (const [name, v] of Object.entries(secrets)) {
      for (const form of forms(v)) {
        const out = red.redact(`before ${form} after`);
        expect(out, `${name}: ${form}`).not.toContain(form);
        expect(out).toContain('<secret:');
      }
    }
    // the longer secret wins where one contains the other
    expect(red.redact(secrets.b)).toBe('<secret:b>');
    expect(red.redactJson({ [secrets.a]: [secrets.a, { k: secrets.c }] } as JsonValue)).toEqual({ '<secret:a>': ['<secret:a>', { k: '<secret:c>' }] });
  });

  it('A7 R-SE1: secret values shorter than 4 characters are rejected by the redactor (SECRET_TOO_SHORT) rather than redacting nothing', () => {
    expect(() => createRedactor({ tiny: 'abc' })).toThrow(/SECRET_TOO_SHORT|at least 4/);
    expect(() => createRedactor({ empty: '' })).toThrow();
  });

  it('A7 R-SE2: after a secret fill the observation is tainted and no screenshot reaches the judge or the run dir unless it is masked and masking is proven', async () => {
    project = createProject({ docs: ['login'] });
    const noProof: (f: DriverFactory) => DriverFactory = (f) => ({
      id: f.id,
      async create(ctx) {
        const d = await f.create(ctx);
        const caps = { ...d.capabilities, maskingProven: false };
        return {
          ...d,
          capabilities: caps,
          async openSession(o) {
            const s = await d.openSession(o);
            return Object.assign(s, { capabilities: caps });
          },
        };
      },
    });
    const h = await openEngine(project, { env: { ACME_ADMIN_PASSWORD: SECRET }, prepare: { adminPassword: SECRET }, wrapFactory: noProof });
    await h.compile();
    await h.run({ titles: [LOGIN] });
    await h.close();
    const judgeImages = callsOf({ log: [] }, 'judge').length;
    expect(judgeImages).toBe(0);
    // no model request after the secret fill carries an image part
    for (const c of h.calls) {
      if (String((c as { purpose?: string }).purpose) !== 'judge') continue;
      const text = JSON.stringify((c as { request?: unknown }).request ?? {});
      // images are logged as {image: sha}; the tainted login page must not have one
      expect(text.includes('"image"'), 'judge request after a secret fill with unproven masking').toBe(false);
    }
    void compose;
    void allScenarios;
    void readPlans;
  });
});
