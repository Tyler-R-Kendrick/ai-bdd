import { describe, expect, it, vi } from 'vitest';
import { AiBddError, type CompileResult, type Diagnostic, type ExitCode } from '@ai-bdd/sdk/contracts';
import { compileExitCode, formatDiagnostic } from '../src/commands/compile.ts';
import { makeCompileResult, runCli } from './helpers.ts';

type DocCompileResult = CompileResult['docs'][number];
const doc = (over: Partial<DocCompileResult> = {}): DocCompileResult => ({
  docUri: 'docs/a.md', state: 'fresh', extractedSections: [], failedSections: [], added: [], updated: [], removed: [], diagnostics: [], ...over,
});
const diag = (over: Partial<Diagnostic> = {}): Diagnostic => ({ code: 'EXTRACT_UNGROUNDED', severity: 'warning', message: 'msg', ...over });
const lines = (s: string) => s.split('\n');

describe('compile: formatDiagnostic', () => {
  const range = { startLine: 7, startColumn: 2, endLine: 8, endColumn: 4 };
  it('adds the location only when a uri is known, and the start line only when a range is known', () => {
    expect(formatDiagnostic(diag())).toBe('warning EXTRACT_UNGROUNDED: msg');
    expect(formatDiagnostic(diag({ uri: 'docs/a.md' }))).toBe('warning EXTRACT_UNGROUNDED: msg (docs/a.md)');
    expect(formatDiagnostic(diag({ uri: 'docs/a.md', range }))).toBe('warning EXTRACT_UNGROUNDED: msg (docs/a.md:7)');
    // a range without a uri has nothing to point at
    expect(formatDiagnostic(diag({ range }))).toBe('warning EXTRACT_UNGROUNDED: msg');
  });
  it('starts with the severity', () => {
    expect(formatDiagnostic(diag({ severity: 'error', code: 'DOC_READ_FAILED', message: 'cannot read' }))).toBe('error DOC_READ_FAILED: cannot read');
  });
});

describe('compile: compileExitCode', () => {
  const result = (exitCode: ExitCode, docs: DocCompileResult[]): CompileResult => makeCompileResult({ exitCode, docs });
  it.each([
    ['clean run', 0, [doc()], false, 0],
    ['no documents', 0, [], false, 0],
    ['failed section', 0, [doc({ failedSections: ['s1'] })], false, 1],
    ['error diagnostic', 0, [doc({ diagnostics: [diag({ severity: 'error' })] })], false, 1],
    ['warning diagnostic only', 0, [doc({ diagnostics: [diag({ severity: 'warning' })] })], false, 0],
    ['stale doc without --check', 0, [doc({ state: 'stale' })], false, 0],
    ['stale doc with --check', 0, [doc({ state: 'stale' })], true, 4],
    ['new doc with --check', 0, [doc({ state: 'new' })], true, 4],
    ['orphaned doc with --check', 0, [doc({ state: 'orphaned' })], true, 4],
    ['fresh docs with --check', 0, [doc(), doc({ docUri: 'b' })], true, 0],
    ['only one stale doc among fresh ones with --check', 0, [doc(), doc({ docUri: 'b', state: 'stale' })], true, 4],
    ['extraction errors and stale with --check: frozen violation wins', 0, [doc({ state: 'stale', failedSections: ['s'] })], true, 4],
    ['engine exit 1 and stale with --check', 1, [doc({ state: 'stale' })], true, 4],
    ['engine exit 1 and fresh with --check', 1, [doc()], true, 1],
    ['engine exit 2 passes through with --check', 2, [doc({ state: 'stale' })], true, 2],
    ['engine exit 3 beats a stale doc with --check', 3, [doc({ state: 'stale' })], true, 3],
    ['engine exit 4 stays 4', 4, [doc()], true, 4],
    ['engine exit 3 stays 3 without --check', 3, [doc({ failedSections: ['s'] })], false, 3],
    ['engine exit 2 stays 2 despite failed sections', 2, [doc({ failedSections: ['s'] })], false, 2],
  ] as [string, ExitCode, DocCompileResult[], boolean, ExitCode][])('%s', (_label, engineExit, docs, check, expected) => {
    expect(compileExitCode(result(engineExit, docs), check)).toBe(expected);
  });
});

describe('compile: output', () => {
  it('prints per-doc lines with counts, extracted/failed sections, ids with +/~/- markers and diagnostics', async () => {
    const compile = vi.fn(async () =>
      makeCompileResult({
        docs: [
          doc({
            docUri: 'docs/a.md', state: 'stale', extractedSections: ['s1', 's2'], failedSections: ['s3'],
            added: ['f-new'], updated: ['f-upd'], removed: ['f-gone', 'f-gone2'],
            diagnostics: [diag({ message: 'dropped', uri: 'docs/a.md', range: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 5 } }), diag({ severity: 'error', code: 'DOC_READ_FAILED', message: 'unreadable' })],
          }),
          doc({ docUri: 'docs/b.md', state: 'fresh' }),
        ],
        usage: { modelCalls: 5, inputTokens: 900, outputTokens: 80 },
        exitCode: 0,
      }),
    );
    const h = await runCli(['compile'], { engine: { compile } });
    expect(h.code).toBe(1);
    expect(lines(h.stdout)).toEqual([
      'docs/a.md  [stale]  +1 ~1 -2, 2 section(s) extracted, 1 FAILED',
      '    + f-new',
      '    ~ f-upd',
      '    - f-gone',
      '    - f-gone2',
      '    failed section: s3',
      '    warning EXTRACT_UNGROUNDED: dropped (docs/a.md:3)',
      '    error DOC_READ_FAILED: unreadable',
      'docs/b.md  [fresh]  +0 ~0 -0',
      'Model calls: 5 (900 input / 80 output tokens)',
      '',
    ]);
  });

  it('without documents prints "No documents found." and still exits 0', async () => {
    const h = await runCli(['compile']);
    expect(h.code).toBe(0);
    expect(lines(h.stdout)).toEqual(['No documents found.', 'Model calls: 0 (0 input / 0 output tokens)', '']);
  });

  it('--check message counts the non-fresh documents; --dry-run notes that nothing was written; --check wins over --dry-run', async () => {
    const compile = vi.fn(async () => makeCompileResult({ docs: [doc({ state: 'stale' }), doc({ docUri: 'b', state: 'new' }), doc({ docUri: 'c' })] }));
    const check = await runCli(['compile', '--check'], { engine: { compile } });
    expect(check.stdout).toContain('Check failed: 2 document(s) are not fresh. Run `ai-bdd compile`.\n');
    expect(check.code).toBe(4);
    const dry = await runCli(['compile', '--dry-run'], { engine: { compile } });
    expect(dry.stdout).toContain('Dry run: no plan files were written.\n');
    expect(dry.stdout).not.toContain('Check ');
    expect(dry.code).toBe(0);
    const both = await runCli(['compile', '--check', '--dry-run'], { engine: { compile } });
    expect(both.stdout).toContain('Check failed');
    expect(both.stdout).not.toContain('Dry run');
    const plain = await runCli(['compile'], { engine: { compile } });
    expect(plain.stdout).not.toContain('Dry run');
    expect(plain.stdout).not.toContain('Check ');
  });

  it('forwards the abort signal to the engine, and omits it when there is none', async () => {
    const ac = new AbortController();
    const withSignal = await runCli(['compile'], { deps: { signal: ac.signal } });
    expect((withSignal.engine.compile as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].signal).toBe(ac.signal);
    const without = await runCli(['compile']);
    expect((without.engine.compile as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toStrictEqual({ full: false, dryRun: false, check: false });
  });

  it('an engine error (e.g. unreadable model) is mapped to its exit code, with the engine closed', async () => {
    const h = await runCli(['compile'], { engine: { compile: vi.fn(async () => { throw new AiBddError('MODEL_UNAVAILABLE', 'extract model down'); }) } });
    expect(h.code).toBe(3);
    expect(h.stderr).toBe('ai-bdd: error [MODEL_UNAVAILABLE]: extract model down\n');
    expect(h.engine.close).toHaveBeenCalledOnce();
  });
});

describe('review: error handling per id', () => {
  const review = (impl: (id: string, action: string) => Promise<void>) => ({ review: vi.fn(impl) as never });

  it.each([
    ['accept', 'accepted'],
    ['reject', 'rejected'],
    ['pin', 'pinned'],
    ['unpin', 'unpinned'],
  ])('%s is passed to the engine for each id and reported as "%s <id>"', async (action, past) => {
    const h = await runCli(['review', action, 'a', 'b']);
    expect(h.code).toBe(0);
    expect((h.engine.review as ReturnType<typeof vi.fn>).mock.calls).toEqual([['a', action], ['b', action]]);
    expect(h.stdout).toBe(`${past} a\n${past} b\n`);
    expect(h.stderr).toBe('');
  });

  it('reports an AiBddError per id with code and message, keeps going, and exits with the mapped code', async () => {
    const h = await runCli(['review', 'accept', 'ok1', 'missing', 'ok2'], {
      engine: review(async (id) => {
        if (id === 'missing') throw new AiBddError('SCENARIO_NOT_FOUND', 'no scenario "missing"');
      }),
    });
    expect(h.code).toBe(2);
    expect(h.stdout).toBe('accepted ok1\naccepted ok2\n');
    expect(h.stderr).toBe('ai-bdd: missing: [SCENARIO_NOT_FOUND] no scenario "missing"\n');
  });

  it('reports an unexpected Error by message and a non-Error by its string form; both are exit 3', async () => {
    const h = await runCli(['review', 'pin', 'a', 'b'], {
      engine: review(async (id) => {
        if (id === 'a') throw new TypeError('disk full');
        throw 'weird';
      }),
    });
    expect(h.code).toBe(3);
    expect(h.stderr).toBe('ai-bdd: a: disk full\nai-bdd: b: weird\n');
    expect(h.stdout).toBe('');
  });

  it('the worst exit code of all ids wins, regardless of order', async () => {
    const codes: Record<string, AiBddError> = {
      one: new AiBddError('CHECK_FAILED', 'x'),
      two: new AiBddError('SCENARIO_NOT_FOUND', 'x'),
      three: new AiBddError('DRIVER_ERROR', 'x'),
      four: new AiBddError('PLAN_STALE', 'x'),
    };
    const run = async (ids: string[]) =>
      (await runCli(['review', 'accept', ...ids], { engine: review(async (id) => { throw codes[id]; }) })).code;
    expect(await run(['one', 'two'])).toBe(2);
    expect(await run(['two', 'one'])).toBe(2);
    expect(await run(['two', 'three', 'one'])).toBe(3);
    expect(await run(['three', 'two'])).toBe(3);
    expect(await run(['three', 'four', 'two'])).toBe(4);
    expect(await run(['one'])).toBe(1);
  });

  it('secrets in an error message are scrubbed', async () => {
    const h = await runCli(['review', 'accept', 'a'], {
      env: { TOKEN: 'tok-123456' },
      config: { secrets: { t: { env: 'TOKEN' } } },
      engine: review(async () => { throw new Error('failed with tok-123456'); }),
    });
    expect(h.stderr).toBe('ai-bdd: a: failed with [redacted]\n');
  });
});

describe('verify-run: fallbacks', () => {
  it('uses the SDK verifyRun when there is no config and the dir is resolved against cwd', async () => {
    const verifyRun = vi.fn(async () => ({ ok: true, problems: [] }));
    const loadConfig = vi.fn(async () => { throw new AiBddError('CONFIG_NOT_FOUND', 'none'); });
    const h = await runCli(['verify-run', 'runs/r1'], { cwd: '/w', deps: { loadConfig, verifyRun } });
    expect(h.code).toBe(0);
    expect(verifyRun).toHaveBeenCalledWith('/w/runs/r1');
    expect(h.stdout).toBe('OK: runs/r1 verified.\n');
  });

  it('an explicit --config that does not exist stays exit 2 and never falls back', async () => {
    const verifyRun = vi.fn();
    const loadConfig = vi.fn(async () => { throw new AiBddError('CONFIG_NOT_FOUND', 'none'); });
    const h = await runCli(['-c', 'nope.json', 'verify-run', 'r'], { deps: { loadConfig, verifyRun: verifyRun as never } });
    expect(h.code).toBe(2);
    expect(h.stderr).toBe('ai-bdd: error [CONFIG_NOT_FOUND]: none\n');
    expect(verifyRun).not.toHaveBeenCalled();
  });

  it('other config errors are not swallowed', async () => {
    const loadConfig = vi.fn(async () => { throw new AiBddError('CONFIG_INVALID', 'bad'); });
    const h = await runCli(['verify-run', 'r'], { deps: { loadConfig } });
    expect(h.code).toBe(2);
    expect(h.stderr).toBe('ai-bdd: error [CONFIG_INVALID]: bad\n');
  });

  it('EVIDENCE_CORRUPT from the engine is reported as a problem with its message, exit 1', async () => {
    const verifyRun = vi.fn(async () => { throw new AiBddError('EVIDENCE_CORRUPT', 'manifest.json is not valid JSON'); });
    const h = await runCli(['verify-run', 'r'], { engine: { verifyRun } });
    expect(h.code).toBe(1);
    expect(h.stdout).toBe('FAILED: r has 1 problem(s):\n  - manifest.json is not valid JSON\n');
  });

  it('lists every problem under the failure header', async () => {
    const verifyRun = vi.fn(async () => ({ ok: false, problems: ['a.png hash mismatch', 'b.json missing'] }));
    const h = await runCli(['verify-run', '/abs/run'], { engine: { verifyRun } });
    expect(h.code).toBe(1);
    expect(h.stdout).toBe('FAILED: /abs/run has 2 problem(s):\n  - a.png hash mismatch\n  - b.json missing\n');
    expect(verifyRun).toHaveBeenCalledWith('/abs/run');
  });
});
