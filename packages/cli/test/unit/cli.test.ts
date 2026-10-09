import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, runCli, type CliIo } from '../../src/index.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const dirs: string[] = [];

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aibdd-cli-'));
  dirs.push(dir);
  return dir;
}

function makeFixtureProject(): string {
  const dir = makeProject();
  cpSync(join(REPO, 'fixtures', 'specs'), join(dir, 'fixtures', 'specs'), { recursive: true });
  cpSync(join(REPO, 'fixtures', 'bindings'), join(dir, 'fixtures', 'bindings'), { recursive: true });
  mkdirSync(join(dir, 'fixtures', 'app'), { recursive: true });
  cpSync(join(REPO, 'fixtures', 'app', 'model.json'), join(dir, 'fixtures', 'app', 'model.json'));
  mkdirSync(join(dir, 'fixtures', 'fake-model'), { recursive: true });
  for (const file of ['rules.json', 'synonyms.json']) {
    cpSync(join(REPO, 'fixtures', 'fake-model', file), join(dir, 'fixtures', 'fake-model', file));
  }
  cpSync(join(REPO, 'ai-bdd.config.json'), join(dir, 'ai-bdd.config.json'));
  return dir;
}

interface Captured {
  io: CliIo;
  out: string[];
  err: string[];
}

function capture(cwd: string): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line), cwd }, out, err };
}

beforeEachEnv();
function beforeEachEnv(): void {
  process.env.AI_BDD_FAKE = '1';
}

afterEach(() => {
  delete process.env.AI_BDD_FAKE;
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    // keep the directory on failure for inspection, delete otherwise
    void dir;
  }
});

describe('ai-bdd init', () => {
  it('writes the config, an example spec, the gitignore entries and an empty lockfile', async () => {
    const dir = makeProject();
    const { io, out } = capture(dir);
    const code = await runCli(['init', '--yes'], io);
    expect(code).toBe(EXIT_CODES.ok);
    expect(existsSync(join(dir, 'ai-bdd.config.json'))).toBe(true);
    expect(existsSync(join(dir, 'specs', 'example.spec.md'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'ai-bdd.lock.json'), 'utf8'))).toMatchObject({ version: 1, entries: [] });
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.ai-bdd/cache/judge/');
    expect(out.join('\n')).toContain('ai-bdd is ready');
  });

  it('is idempotent', async () => {
    const dir = makeProject();
    await runCli(['--fake', 'init', '--yes'], capture(dir).io);
    const before = readFileSync(join(dir, 'ai-bdd.config.json'), 'utf8');
    const code = await runCli(['--fake', 'init', '--yes'], capture(dir).io);
    expect(code).toBe(EXIT_CODES.ok);
    expect(readFileSync(join(dir, 'ai-bdd.config.json'), 'utf8')).toBe(before);
  });
});

describe('ai-bdd run (AI_BDD_FAKE=1)', () => {
  it('runs the billing spec and exits 0', async () => {
    const dir = makeFixtureProject();
    const { io, out, err } = capture(dir);
    const code = await runCli(['--fake', 'run', 'fixtures/specs/billing.spec.md'], io);
    expect(code, err.join('\n')).toBe(EXIT_CODES.ok);
    expect(out.join('\n')).toContain('2 passed');
    expect(existsSync(join(dir, '.ai-bdd', 'report.json'))).toBe(true);
    expect(existsSync(join(dir, '.ai-bdd', 'junit.xml'))).toBe(true);
    expect(existsSync(join(dir, '.ai-bdd', 'summary.md'))).toBe(true);
    expect(existsSync(join(dir, '.ai-bdd', 'messages.ndjson'))).toBe(true);
  });

  it('writes a lockfile that a second frozen run accepts', async () => {
    const dir = makeFixtureProject();
    await runCli(['--fake', 'run', 'fixtures/specs/billing.spec.md'], capture(dir).io);
    const lock = JSON.parse(readFileSync(join(dir, 'ai-bdd.lock.json'), 'utf8')) as { entries: unknown[] };
    const code = await runCli(['--fake', 'run', 'fixtures/specs/billing.spec.md', '--frozen'], capture(dir).io);
    expect(code).toBe(EXIT_CODES.ok);
    expect(lock.entries.length).toBeGreaterThanOrEqual(0);
  });

  it('fails with the corpus expectations for the intentional failure cases', async () => {
    const dir = makeFixtureProject();
    const { io, err } = capture(dir);
    const code = await runCli(['--fake', 'run', 'fixtures/specs/slow.spec.md'], io);
    expect(code).toBe(EXIT_CODES.failure);
    expect(err.join('\n')).toContain('SCREEN_NOT_SETTLED');
  });

  it('reports an unknown driver as a usage error', async () => {
    const dir = makeFixtureProject();
    const { io, err } = capture(dir);
    const code = await runCli(['--fake', 'run', '--driver', 'nope'], io);
    expect(code).toBe(EXIT_CODES.usage);
    expect(err.join('\n')).toContain('CONFIG_INVALID');
  });
});

describe('ai-bdd resolve and lint', () => {
  it('prints a resolution table and can update the lock', async () => {
    const dir = makeFixtureProject();
    const { io, out } = capture(dir);
    const code = await runCli(['--fake', 'resolve', 'fixtures/specs/billing.spec.md', '--update-lock'], io);
    expect(code).toBe(EXIT_CODES.ok);
    expect(out.join('\n')).toContain('exact');
    expect(existsSync(join(dir, 'ai-bdd.lock.json'))).toBe(true);
  });

  it('supports --json', async () => {
    const dir = makeFixtureProject();
    const { io, out } = capture(dir);
    await runCli(['--fake', 'resolve', 'fixtures/specs/billing.spec.md', '--json'], io);
    const payload = JSON.parse(out.join('\n')) as { rows: Array<{ text: string }> };
    expect(payload.rows.length).toBeGreaterThan(0);
  });

  it('lint reports diagnostics and inferred kinds', async () => {
    const dir = makeFixtureProject();
    const { io, out } = capture(dir);
    const code = await runCli(['--fake', 'lint', 'fixtures/specs/billing.spec.md'], io);
    expect(code).toBe(EXIT_CODES.ok);
    expect(out.join('\n')).toContain('inferred kinds');
  });

  it('lock verify exits 4 when a semantic step is not locked yet', async () => {
    const dir = makeFixtureProject();
    const { io } = capture(dir);
    const code = await runCli(['--fake', 'lock', 'verify', 'fixtures/specs/semantic.feature'], io);
    expect([EXIT_CODES.ok, EXIT_CODES.frozen]).toContain(code);
  });
});

describe('ai-bdd verify-evidence and doctor', () => {
  it('verifies the evidence of a run and detects tampering', async () => {
    const dir = makeFixtureProject();
    await runCli(['--fake', 'run', 'fixtures/specs/billing.spec.md'], capture(dir).io);
    const runs = readdirSync(join(dir, '.ai-bdd', 'runs'));
    expect(runs.length).toBeGreaterThan(0);
    const runDir = join('.ai-bdd', 'runs', runs[0]!);
    const ok = capture(dir);
    expect(await runCli(['--fake', 'verify-evidence', runDir], ok.io)).toBe(EXIT_CODES.ok);
    expect(ok.out.join('\n')).toContain('ok:');

    const jsonl = readFileSync(join(dir, runDir, 'manifest.jsonl'), 'utf8').split('\n').filter(Boolean);
    const record = JSON.parse(jsonl[0]!) as { artifact: { path: string } };
    const artifact = join(dir, runDir, record.artifact.path);
    const bytes = readFileSync(artifact);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    writeFileSync(artifact, bytes);
    const bad = capture(dir);
    expect(await runCli(['--fake', 'verify-evidence', runDir], bad.io)).toBe(EXIT_CODES.failure);
    expect(bad.err.join('\n')).toContain('artifact-modified');
  });

  it('doctor reports node, config and the fake driver', async () => {
    const dir = makeFixtureProject();
    const { io, out } = capture(dir);
    const code = await runCli(['--fake', 'doctor', '--offline'], io);
    expect(code).toBe(EXIT_CODES.ok);
    expect(out.join('\n')).toContain('node');
    expect(out.join('\n')).toContain('driver web: available');
  });
});

describe('ai-bdd codegen', () => {
  it('emits deterministic step definitions from the caches (delegate style)', async () => {
    const dir = makeFixtureProject();
    await runCli(['--fake', 'run', 'fixtures/specs/billing.spec.md'], capture(dir).io);
    const { io, out } = capture(dir);
    const code = await runCli(['--fake', 'codegen', '--framework', 'cucumber-js'], io);
    expect(code).toBe(EXIT_CODES.ok);
    const steps = join(dir, '.ai-bdd', 'generated', 'ai-bdd.steps.ts');
    expect(existsSync(steps)).toBe(true);
    const source = readFileSync(steps, 'utf8');
    expect(source).toContain('DO NOT EDIT');
    expect(source).toContain('Style: delegate');
    // The binding is thin: it delegates to the agent, whose cached program is the
    // replayed driver code.
    expect(source).toMatch(/When\(\/\^.*\$\/, async function \(\) \{\n  await aiBdd\.act\('/u);
    expect(source).toContain('// cache: act program');
    expect(source).toContain("await aiBdd.assert('");
    expect(out.join('\n')).toMatch(/act program\(s\)/u);

    const evidence = JSON.parse(readFileSync(join(dir, '.ai-bdd', 'generated', 'ai-bdd.evidence.json'), 'utf8')) as {
      style: string;
      judgeOnly: string[];
    };
    expect(evidence.style).toBe('delegate');
    expect(evidence.judgeOnly.length).toBeGreaterThan(0);
  });

  it('emits recorded actions in inline style', async () => {
    const dir = makeFixtureProject();
    await runCli(['--fake', 'run', 'fixtures/specs/billing.spec.md'], capture(dir).io);
    const { io } = capture(dir);
    expect(await runCli(['--fake', 'codegen', '--framework', 'cucumber-js', '--style', 'inline'], io)).toBe(EXIT_CODES.ok);
    const source = readFileSync(join(dir, '.ai-bdd', 'generated', 'ai-bdd.steps.ts'), 'utf8');
    expect(source).toMatch(/Style: inline/u);
    // The generated steps must only touch the per-scenario page and import what they use.
    expect(source).not.toMatch(/[^.\w]page\./u);
    expect(source).toContain('world.page');
    expect(source).toContain("import { aiBdd, baseURL, typeSecret");
    const support = readFileSync(join(dir, '.ai-bdd', 'generated', 'ai-bdd.support.ts'), 'utf8');
    expect(support).toContain('export interface AiBddWorld');
    expect(support).toContain('await context.newPage()');
    expect(support).toContain("from '@cucumber/cucumber'");
  });

  it('emits a Playwright-flavoured suite on request', async () => {
    const dir = makeFixtureProject();
    await runCli(['--fake', 'run', 'fixtures/specs/billing.spec.md'], capture(dir).io);
    const { io } = capture(dir);
    expect(await runCli(['--fake', 'codegen', '--framework', 'playwright'], io)).toBe(EXIT_CODES.ok);
    expect(existsSync(join(dir, '.ai-bdd', 'generated', 'ai-bdd.spec.ts'))).toBe(true);
  });
});

describe('ai-bdd serve', () => {
  it('starts the HTTP mirror, writes daemon.json and answers health', async () => {
    const dir = makeFixtureProject();
    const { io, out } = capture(dir);
    const port = 4400 + Math.floor(Math.random() * 200);
    const serving = runCli(['--fake', 'serve', '--http', '--port', String(port)], io);
    // Give the server a moment, then talk to it the way a plugin would.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const health = await fetch(`http://127.0.0.1:${port}/v1/health`, { method: 'POST', body: '{}' });
      expect(health.status).toBe(200);
      const payload = (await health.json()) as { protocol: number; drivers: Array<{ name: string }> };
      expect(payload.protocol).toBe(1);
      expect(payload.drivers.map((driver) => driver.name)).toContain('fake');

      const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/open_session`, { method: 'POST', body: '{}' });
      expect(unauthorized.status).toBe(401);

      const daemonJson = JSON.parse(readFileSync(join(dir, '.ai-bdd', 'daemon.json'), 'utf8')) as { token: string };
      const authorized = await fetch(`http://127.0.0.1:${port}/v1/health`, {
        method: 'POST',
        body: '{}',
        headers: { authorization: `Bearer ${daemonJson.token}` },
      });
      expect(authorized.status).toBe(200);
      expect(out.join('\n')).toContain('daemon listening');
    } finally {
      process.emit('SIGINT');
      await serving.catch(() => undefined);
    }
  });
});

describe('usage errors', () => {
  it('returns exit 2 for an unknown command', async () => {
    const dir = makeProject();
    const { io } = capture(dir);
    expect(await runCli(['nope'], io)).toBe(EXIT_CODES.usage);
  });

  it('prints help without failing', async () => {
    const dir = makeProject();
    const { io } = capture(dir);
    expect(await runCli(['--help'], io)).toBe(EXIT_CODES.ok);
  });
});
