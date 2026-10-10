import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import { main } from '../src/main.ts';
import { makeConfig, makeEngine, makeReport, runCli } from './helpers.ts';

const pkgVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('main: usage errors (exit 2)', () => {
  it.each([
    [['frobnicate'], "error: unknown command 'frobnicate'"],
    [['--bogus'], "error: unknown option '--bogus'"],
    [['status', '--bogus'], "error: unknown option '--bogus'"],
    [['status', 'extra'], "error: too many arguments for 'status'. Expected 0 arguments but got 1: extra."],
    [['show', 'a', 'b'], "error: too many arguments for 'show'. Expected 1 argument but got 2: a, b."],
    [['review', 'accept'], "error: missing required argument 'ids'"],
    [['verify-run'], "error: missing required argument 'runDir'"],
    [['run', '--tag'], "error: option '--tag <tags>' argument missing"],
    [['-c'], "error: option '-c, --config <path>' argument missing"],
  ])('%j prints commander\'s message plus a hint on stderr, nothing on stdout, and never loads the engine', async (argv, message) => {
    const h = await runCli(argv);
    expect(h.code).toBe(2);
    expect(h.stdout).toBe('');
    expect(h.stderr).toBe(`${message}\n(run with --help for usage)\n`);
    expect(h.loadConfig).not.toHaveBeenCalled();
    expect(h.createEngine).not.toHaveBeenCalled();
  });

  it('no command prints the full usage on stderr and exits 2', async () => {
    const h = await runCli([]);
    expect(h.code).toBe(2);
    expect(h.stdout).toBe('');
    expect(h.stderr).toMatch(/^Usage: ai-bdd \[options\] \[command\]\n/);
    expect(h.stderr).toContain('Commands:');
    expect(h.stderr).toContain('doctor [options]');
  });

  it('argument validators throw AiBddError USAGE, rendered as "error [USAGE]" with exit 2', async () => {
    const workers = await runCli(['run', '--workers', '0']);
    expect(workers.code).toBe(2);
    expect(workers.stderr).toBe('ai-bdd: error [USAGE]: --workers expects a positive integer, got "0".\n');
    const reporter = await runCli(['run', '--reporter', 'xml']);
    expect(reporter.code).toBe(2);
    expect(reporter.stderr).toBe('ai-bdd: error [USAGE]: Unknown reporter "xml". Expected one of: json, junit, markdown.\n');
    const action = await runCli(['review', 'bless', 'x']);
    expect(action.code).toBe(2);
    expect(action.stderr).toBe('ai-bdd: error [USAGE]: Unknown review action "bless". Expected one of: accept, reject, pin, unpin.\n');
    for (const h of [workers, reporter, action]) {
      expect(h.stdout).toBe('');
      expect(h.createEngine).not.toHaveBeenCalled();
    }
  });
});

describe('main: help and version (exit 0)', () => {
  it('--help prints usage on stdout only and exits 0', async () => {
    const h = await runCli(['--help']);
    expect(h.code).toBe(0);
    expect(h.stderr).toBe('');
    expect(h.stdout).toMatch(/^Usage: ai-bdd \[options\] \[command\]\n\nTurn plain markdown documents into executable acceptance tests\.\n/);
    expect(h.stdout).toContain('-c, --config <path>');
    expect(h.createEngine).not.toHaveBeenCalled();
  });

  it('a command --help is help for that command, exit 0', async () => {
    const h = await runCli(['doctor', '--help']);
    expect(h.code).toBe(0);
    expect(h.stdout).toMatch(/^Usage: ai-bdd doctor \[options\]\n/);
    expect(h.stdout).toContain('--offline');
    expect(h.stderr).toBe('');
  });

  it('--version and -V print exactly the package version and exit 0', async () => {
    for (const flag of ['--version', '-V']) {
      const h = await runCli([flag]);
      expect(h.code).toBe(0);
      expect(h.stdout).toBe(`${pkgVersion}\n`);
      expect(h.stderr).toBe('');
    }
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('main: exit code of the executed action', () => {
  it('init returns 0 by default and commands return the code their action produced', async () => {
    const h = await runCli(['verify-run', '/r'], { engine: { verifyRun: vi.fn(async () => ({ ok: false, problems: ['x'] })) } });
    expect(h.code).toBe(1);
    const ok = await runCli(['verify-run', '/r']);
    expect(ok.code).toBe(0);
  });

  it('the exit code of a run is the report exit code, and the summary goes to stdout', async () => {
    const h = await runCli(['run'], { engine: { run: vi.fn(async () => makeReport({ exitCode: 4 })) } });
    expect(h.code).toBe(4);
    expect(h.stdout).toContain('Exit code: 4');
    expect(h.stderr).toBe('');
  });
});

describe('main: JSON vs human output', () => {
  it('status prints a human summary by default and parseable JSON (and only JSON) with --json', async () => {
    const status = { docs: [{ docUri: 'docs/a.md', state: 'fresh' as const, dirtySections: [], staleFeatures: [], uncovered: [], notTestable: [], unreviewedScenarios: [] }] };
    const engine = { status: vi.fn(async () => status) };
    const human = await runCli(['status'], { engine });
    expect(human.stdout).toContain('docs/a.md  [fresh]');
    expect(() => JSON.parse(human.stdout)).toThrow();
    const json = await runCli(['status', '--json'], { engine });
    expect(JSON.parse(json.stdout)).toEqual(status);
    expect(json.stdout.endsWith('\n')).toBe(true);
    expect(json.stderr).toBe('');
  });

  it('an error under --json still goes to stderr in the human format, with nothing on stdout', async () => {
    const h = await runCli(['status', '--json'], { engine: { status: vi.fn(async () => { throw new AiBddError('PLAN_CORRUPT', 'broken'); }) } });
    expect(h.code).toBe(2);
    expect(h.stdout).toBe('');
    expect(h.stderr).toBe('ai-bdd: error [PLAN_CORRUPT]: broken\n');
  });
});

describe('main: default process IO', () => {
  const spyStreams = () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => (out.push(String(s)), true)) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => (err.push(String(s)), true)) as never);
    return { out, err };
  };

  it('without io, writes to process.stdout and process.stderr', async () => {
    const { out, err } = spyStreams();
    expect(await main(['--version'])).toBe(0);
    expect(out.join('')).toBe(`${pkgVersion}\n`);
    expect(await main(['frobnicate'])).toBe(2);
    expect(err.join('')).toBe("error: unknown command 'frobnicate'\n(run with --help for usage)\n");
    expect(out.join('')).toBe(`${pkgVersion}\n`);
  });

  it('without io, takes env from process.env and cwd from process.cwd()', async () => {
    const { err } = spyStreams();
    vi.stubEnv('AI_BDD_DEBUG', '1');
    const loadConfig = vi.fn(async () => {
      const e = new TypeError('kaput');
      e.stack = 'TypeError: kaput\n    at here (x.ts:1:1)';
      throw e;
    });
    const code = await main(['status'], {}, { loadConfig });
    expect(code).toBe(3);
    expect(loadConfig).toHaveBeenCalledWith({ cwd: process.cwd(), env: process.env });
    expect(err.join('')).toBe('ai-bdd: internal error: kaput\nTypeError: kaput\n    at here (x.ts:1:1)\n');
  });

  it('a partial io is completed field by field with the process defaults', async () => {
    let out = '';
    const config = makeConfig();
    const loadConfig = vi.fn(async () => config);
    const createEngine = vi.fn(async () => makeEngine(config));
    const { err } = spyStreams();
    const code = await main(['status'], { stdout: { write: (s: string) => (out += s) }, cwd: '/only-cwd' }, { loadConfig, createEngine });
    expect(code).toBe(0);
    expect(out).toBe('No documents found.\n');
    expect(err).toEqual([]);
    expect(loadConfig).toHaveBeenCalledWith({ cwd: '/only-cwd', env: process.env });
  });
});

describe('main: help width follows the terminal only for the real streams', () => {
  function withTty<T>(stream: NodeJS.WriteStream, columns: number, fn: () => Promise<T>): Promise<T> {
    const isTTY = Object.getOwnPropertyDescriptor(stream, 'isTTY');
    const cols = Object.getOwnPropertyDescriptor(stream, 'columns');
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true, writable: true });
    Object.defineProperty(stream, 'columns', { value: columns, configurable: true, writable: true });
    const restore = (name: string, d: PropertyDescriptor | undefined) => (d ? Object.defineProperty(stream, name, d) : Reflect.deleteProperty(stream, name));
    return fn().finally(() => {
      restore('isTTY', isTTY);
      restore('columns', cols);
    });
  }
  const initLine = (text: string) => text.split('\n').find((l) => l.trim().startsWith('init'));

  it('injected streams always use the deterministic 80 column layout', async () => {
    const h = await runCli(['--help']);
    const line = initLine(h.stdout);
    expect(line).toBeDefined();
    // 80 columns: the init description does not fit on one line
    expect(line).not.toContain('.ai-bdd/plans/');
  });

  it('process.stdout on a TTY uses its column count for --help', async () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => ((out += s), true)) as never);
    const code = await withTty(process.stdout, 200, () => main(['--help']));
    expect(code).toBe(0);
    expect(initLine(out)).toContain('write ai-bdd.config.ts (or .json), docs/example.md, .gitignore entries and .ai-bdd/plans/');
  });

  it('process.stdout that is not a TTY keeps the 80 column layout', async () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => ((out += s), true)) as never);
    const was = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true, writable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true, writable: true });
    try {
      expect(await main(['--help'])).toBe(0);
    } finally {
      if (was) Object.defineProperty(process.stdout, 'isTTY', was);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
      Reflect.deleteProperty(process.stdout, 'columns');
    }
    expect(initLine(out)).not.toContain('.ai-bdd/plans/');
  });

  it('process.stderr on a TTY uses its column count when usage is printed for an empty command line', async () => {
    let err = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => ((err += s), true)) as never);
    const code = await withTty(process.stderr, 200, () => main([]));
    expect(code).toBe(2);
    expect(initLine(err)).toContain('write ai-bdd.config.ts (or .json), docs/example.md, .gitignore entries and .ai-bdd/plans/');
  });

  it('process.stderr that is not a TTY keeps the 80 column layout', async () => {
    let err = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => ((err += s), true)) as never);
    expect(await main([])).toBe(2);
    expect(initLine(err)).not.toContain('.ai-bdd/plans/');
  });
});
