import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArtifactRef } from '@ai-bdd/sdk/contracts';
import { MAX_SCREENSHOT_ATTACHMENTS, collectScreenshots, readArtifact } from '../src/evidence.ts';
import { failureMessage, formatSteps } from '../src/format.ts';
import { globToRegExp, selectScenarios } from '../src/select.ts';
import { feature, plan, result, scenario, step } from './helpers/doubles.ts';

describe('globToRegExp: double star without a slash', () => {
  it.each([
    ['docs/**', 'docs/a.md', true],
    ['docs/**', 'docs/a/b/c.md', true],
    ['docs/**', 'docs/', true],
    ['docs/**', 'other/a.md', false],
    ['**', 'anything/at/all.md', true],
    ['**', '', true],
    ['a**b', 'ab', true],
    ['a**b', 'a/x/y/b', true],
    ['a**b', 'a/x/y/c', false],
    ['**.md', 'deep/er/file.md', true],
    ['**.md', 'file.txt', false],
  ])('%s vs %j -> %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });

  it('a single star never crosses a directory, a ** followed by a slash matches zero or more directories', () => {
    expect(globToRegExp('a/*').test('a/b/c')).toBe(false);
    expect(globToRegExp('a/**/c').test('a/c')).toBe(true);
    expect(globToRegExp('a/**/c').test('a/x/y/c')).toBe(true);
    expect(globToRegExp('a/**/c').test('a/x/y/d')).toBe(false);
  });

  it('regular expression metacharacters in the glob are literal', () => {
    for (const literal of ['a.b', 'a|b', 'a^b', 'a$b', 'a[1]', 'a{1}', 'a-b', 'a\\b']) {
      expect(globToRegExp(literal).test(literal)).toBe(true);
    }
    expect(globToRegExp('a.b').test('axb')).toBe(false);
    expect(globToRegExp('a|b').test('a')).toBe(false);
    expect(globToRegExp('a[1]').test('a1')).toBe(false);
  });
});

describe('selectScenarios: selectors', () => {
  const plans = [
    plan('docs/a.md', [feature('a--one', 'One', [scenario('a--one/x', 'X'), scenario('a--one/y', 'Y')]), feature('a--two', 'Two', [scenario('a--two/z', 'Z')])]),
    plan('docs/sub/b.md', [feature('b--three', 'Three', [scenario('b--three/w', 'W')])]),
  ];
  const ids = (selectors: string[]) => selectScenarios(plans, { selectors }).flatMap((g) => g.scenarios.map((s) => s.id));

  it('an exact scenario id', () => {
    expect(ids(['a--one/y'])).toEqual(['a--one/y']);
  });
  it('a prefix ending in "/" or "--" selects by scenario id prefix; one that does not end that way does not', () => {
    expect(ids(['a--one/'])).toEqual(['a--one/x', 'a--one/y']);
    expect(ids(['a--'])).toEqual(['a--one/x', 'a--one/y', 'a--two/z']);
    expect(ids(['a--one'])).toEqual([]);
    expect(ids(['a--on/'])).toEqual([]);
  });
  it('an exact doc uri selects every scenario of that document, also when the uri contains glob characters', () => {
    expect(ids(['docs/a.md'])).toEqual(['a--one/x', 'a--one/y', 'a--two/z']);
    const odd = [plan('docs/what?.md', [feature('w--f', 'F', [scenario('w--f/s', 'S')])])];
    expect(selectScenarios(odd, { selectors: ['docs/what?.md'] })).toHaveLength(1);
    expect(selectScenarios(odd, { selectors: ['docs/what.md'] })).toHaveLength(0);
    // as a glob, `?` matches one character of another document
    const plain = [plan('docs/whatx.md', [feature('x--f', 'F', [scenario('x--f/s', 'S')])])];
    expect(selectScenarios(plain, { selectors: ['docs/what?.md'] })).toHaveLength(1);
  });
  it('a doc glob selects matching documents only', () => {
    expect(ids(['docs/*.md'])).toEqual(['a--one/x', 'a--one/y', 'a--two/z']);
    expect(ids(['docs/**/*.md'])).toEqual(['a--one/x', 'a--one/y', 'a--two/z', 'b--three/w']);
    expect(ids(['docs/sub/**'])).toEqual(['b--three/w']);
  });
  it('several selectors are a union, in plan order', () => {
    expect(ids(['b--three/w', 'a--two/z'])).toEqual(['a--two/z', 'b--three/w']);
  });
  it('empty selectors, tags and grep select everything', () => {
    expect(selectScenarios(plans, { selectors: [], tags: [], grep: '' })).toHaveLength(3);
    expect(selectScenarios(plans, {})).toHaveLength(3);
  });
  it('tags and grep combine with selectors (all must hold); grep ignores case and tags ignore leading @', () => {
    const tagged = [plan('docs/t.md', [feature('t--f', 'F', [scenario('t--f/a', 'Upgrade to PRO', { tags: ['@billing'] }), scenario('t--f/b', 'Other', { tags: ['billing'] })])])];
    expect(selectScenarios(tagged, { tags: ['billing'], grep: 'pro' }).flatMap((g) => g.scenarios.map((s) => s.id))).toEqual(['t--f/a']);
    expect(selectScenarios(tagged, { tags: ['@@billing'] }).flatMap((g) => g.scenarios.map((s) => s.id))).toEqual(['t--f/a', 't--f/b']);
    expect(selectScenarios(tagged, { tags: ['billing'], grep: 'pro', selectors: ['t--f/b'] })).toEqual([]);
    expect(selectScenarios(tagged, { tags: ['nope'] })).toEqual([]);
  });
});

describe('formatSteps', () => {
  it('lists header, steps with path, determinism, fuzzy reasons and errors', () => {
    const text = formatSteps(
      result({
        title: 'Upgrade',
        status: 'failed',
        mode: 'mixed',
        recording: 'created',
        steps: [
          step({ kind: 'given', text: 'g', path: 'fixture', determinism: 'n/a' }),
          step({ kind: 'then', text: 't', status: 'failed', path: 'judge', determinism: 'fuzzy', fuzzyReasons: ['subjective', 'volatile-content'], error: { code: 'CHECK_FAILED', message: 'multi\n  line   message', retryable: false } }),
        ],
      }),
    );
    expect(text).toBe(
      [
        'Upgrade',
        'status: failed  mode: mixed  recording: created',
        '',
        '1. [passed] given g  (fixture, n/a)',
        '2. [failed] then t  (judge, fuzzy fuzzy(subjective,volatile-content))',
        '     CHECK_FAILED: multi line message',
        '',
      ].join('\n'),
    );
  });
});

describe('failureMessage', () => {
  const failed = (steps: ReturnType<typeof step>[], over: Parameters<typeof result>[0] = {}) => result({ status: 'failed', steps, ...over });

  it('returns null for passed, and for healed unless failOnHealed', () => {
    expect(failureMessage('L', result(), false)).toBeNull();
    expect(failureMessage('L', result(), true)).toBeNull();
    expect(failureMessage('L', result({ status: 'healed' }), false)).toBeNull();
    expect(failureMessage('L', result({ status: 'healed' }), true)).not.toBeNull();
  });

  it('a healed scenario with failOnHealed but no healed step still names the status and omits the step block', () => {
    const msg = failureMessage('Feat > Scen', result({ status: 'healed', steps: [] }), true);
    expect(msg).toBe(
      [
        'ai-bdd scenario "Feat > Scen" ended healed',
        '  id: docs-billing--upgrading/upgrade-to-pro',
        '  the recording no longer replays as recorded and the agent healed it (failOnHealed is set)',
        '  see the attached ai-bdd-result.json and ai-bdd-steps.txt for every step',
      ].join('\n'),
    );
  });

  it('describes the first failing step; skipped, healed and passed steps are not the failing one', () => {
    const msg = failureMessage(
      'L',
      failed([
        step({ status: 'healed', text: 'healed one' }),
        step({ status: 'skipped', text: 'skipped one' }),
        step({ status: 'blocked', text: 'the culprit', kind: 'when', path: 'fixture' }),
        step({ status: 'failed', text: 'a later failure' }),
      ]),
      false,
    );
    expect(msg).toContain('step 3 [when] "the culprit" ended blocked (path: fixture)');
    expect(msg).not.toContain('a later failure');
    expect(msg).toContain('  1 later step(s) skipped');
  });

  it('truncates long error details to 800 characters followed by "...", and keeps short ones whole', () => {
    const long = { blob: 'x'.repeat(2000) };
    const short = { a: 1 };
    const withDetails = (details: unknown) =>
      failureMessage('L', failed([step({ status: 'failed', error: { code: 'CHECK_FAILED', message: 'm', retryable: false, details: details as never } })]), false) ?? '';
    const longLine = withDetails(long).split('\n').find((l) => l.startsWith('  details: ')) ?? '';
    expect(longLine).toBe(`  details: ${JSON.stringify(long).slice(0, 800)}...`);
    expect(longLine).toHaveLength('  details: '.length + 800 + 3);
    expect(withDetails(short)).toContain('  details: {"a":1}\n');
    expect(withDetails(short)).not.toContain('...');
    // exactly at the limit is not truncated
    const exact = { s: 'y'.repeat(800 - '{"s":""}'.length) };
    expect(JSON.stringify(exact)).toHaveLength(800);
    expect(withDetails(exact)).toContain(`  details: ${JSON.stringify(exact)}\n`);
  });

  it('quotes the first "source" ref over context refs, falls back to the first ref, and omits an absent quote', () => {
    const h = 'a'.repeat(64);
    const ref = (chunkId: string, relation: 'source' | 'context', quote?: string) => ({ chunkId, hash: h, relation, ...(quote === undefined ? {} : { quote }) });
    const msgFor = (sources: ReturnType<typeof ref>[]) => failureMessage('L', failed([step({ status: 'failed', sources })]), false) ?? '';
    expect(msgFor([ref('ctx', 'context', 'c'), ref('src', 'source', 'multi\n  line')])).toContain('  source: src "multi line"\n');
    expect(msgFor([ref('ctx', 'context', 'only context')])).toContain('  source: ctx "only context"\n');
    expect(msgFor([ref('src', 'source')])).toContain('  source: src\n');
    expect(msgFor([])).not.toContain('  source:');
  });

  it('adds the scenario error, the discarded recording note and the footer, and none of them otherwise', () => {
    const full = failureMessage(
      'L',
      failed([step({ status: 'error' })], { recording: 'discarded', error: { code: 'DRIVER_ERROR', message: 'browser\n gone', retryable: true } }),
      false,
    ) ?? '';
    expect(full).toContain('  scenario error: DRIVER_ERROR: browser gone\n');
    expect(full).toContain('  the pending recording was discarded\n');
    expect(full.endsWith('  see the attached ai-bdd-result.json and ai-bdd-steps.txt for every step')).toBe(true);
    const plain = failureMessage('L', failed([step({ status: 'failed' })]), false) ?? '';
    expect(plain).not.toContain('scenario error');
    expect(plain).not.toContain('discarded');
    expect(plain).not.toContain('later step');
  });

  it('a failed scenario without any failing step still reports the status and id', () => {
    const msg = failureMessage('L', failed([]), false);
    expect(msg).toBe(
      [
        'ai-bdd scenario "L" ended failed',
        '  id: docs-billing--upgrading/upgrade-to-pro',
        '  see the attached ai-bdd-result.json and ai-bdd-steps.txt for every step',
      ].join('\n'),
    );
  });
});

describe('evidence', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pwtest-evidence-unit-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const ref = (path: string, sha = 'ab'.repeat(32), kind: ArtifactRef['kind'] = 'screenshot'): ArtifactRef => ({ sha256: sha, path, kind, bytes: 1 });

  it('readArtifact refuses paths that resolve to the run directory itself and never reads a directory', async () => {
    mkdirSync(join(root, 'run-1', 'artifacts'), { recursive: true });
    expect(await readArtifact([join(root, 'run-1')], ref(''))).toBeNull();
    expect(await readArtifact([join(root, 'run-1')], ref('.'))).toBeNull();
    expect(await readArtifact([join(root, 'run-1')], ref('artifacts'))).toBeNull();
  });

  it('readArtifact rejects absolute paths, parent segments (either separator) and finds the file in the first directory that has it', async () => {
    mkdirSync(join(root, 'new'), { recursive: true });
    mkdirSync(join(root, 'old'), { recursive: true });
    writeFileSync(join(root, 'old', 'a.png'), 'OLD');
    writeFileSync(join(root, 'new', 'b.png'), 'NEW-B');
    writeFileSync(join(root, 'old', 'b.png'), 'OLD-B');
    writeFileSync(join(root, 'secret.png'), 'SECRET');
    const dirs = [join(root, 'new'), join(root, 'old')];
    expect((await readArtifact(dirs, ref('a.png')))?.toString()).toBe('OLD');
    expect((await readArtifact(dirs, ref('b.png')))?.toString()).toBe('NEW-B');
    expect(await readArtifact(dirs, ref('../secret.png'))).toBeNull();
    expect(await readArtifact(dirs, ref('sub\\..\\..\\secret.png'))).toBeNull();
    expect(await readArtifact(dirs, ref(join(root, 'secret.png')))).toBeNull();
    expect(await readArtifact([], ref('a.png'))).toBeNull();
    expect(await readArtifact(dirs, ref('missing.png'))).toBeNull();
  });

  it('collectScreenshots returns nothing without screenshots and does not even look at the runs directory', async () => {
    const steps = [step({ evidence: [ref('x.json', 'cd'.repeat(32), 'observation')] }), step()];
    expect(await collectScreenshots(join(root, 'does-not-exist'), steps)).toEqual([]);
    expect(await collectScreenshots(root, [])).toEqual([]);
  });

  it('collectScreenshots searches newest run first, deduplicates by hash (keeping the first step) and ignores files that are not directories', async () => {
    mkdirSync(join(root, 'run-0001'));
    mkdirSync(join(root, 'run-0002'));
    writeFileSync(join(root, 'run-0003'), 'a plain file, not a run directory');
    writeFileSync(join(root, 'run-0001', 'a.png'), 'OLD');
    writeFileSync(join(root, 'run-0002', 'a.png'), 'NEW');
    const sha = 'ab'.repeat(32);
    const shots = await collectScreenshots(root, [step({ evidence: [ref('a.png', sha)] }), step({ evidence: [ref('a.png', sha)] })]);
    expect(shots.map((s) => [s.name, s.body.toString()])).toEqual([[`step-1-screenshot-${sha.slice(0, 8)}.png`, 'NEW']]);
  });

  it(`collectScreenshots attaches at most ${MAX_SCREENSHOT_ATTACHMENTS} screenshots, the first ones`, async () => {
    mkdirSync(join(root, 'run-1'));
    const refs: ArtifactRef[] = [];
    for (let i = 0; i < MAX_SCREENSHOT_ATTACHMENTS + 5; i += 1) {
      const sha = i.toString(16).padStart(64, '0');
      writeFileSync(join(root, 'run-1', `${sha}.png`), String(i));
      refs.push(ref(`${sha}.png`, sha));
    }
    const shots = await collectScreenshots(root, refs.map((r) => step({ evidence: [r] })));
    expect(shots).toHaveLength(MAX_SCREENSHOT_ATTACHMENTS);
    expect(shots[0]?.body.toString()).toBe('0');
    expect(shots.at(-1)?.body.toString()).toBe(String(MAX_SCREENSHOT_ATTACHMENTS - 1));
  });
});
