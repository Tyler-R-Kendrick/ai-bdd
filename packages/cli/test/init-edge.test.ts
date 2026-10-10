import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE_NAMES, CONFIG_JSON_TEMPLATE, CONFIG_TS_TEMPLATE, EXAMPLE_DOC, GITIGNORE_ENTRIES } from '../src/templates.ts';
import { runCli } from './helpers.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ai-bdd-init-edge-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = (p: string) => readFile(join(dir, p), 'utf8');
const exists = (p: string) => stat(join(dir, p)).then(() => true, () => false);
const init = (...args: string[]) => runCli(['init', ...args], { cwd: dir });
const lines = (s: string) => s.split('\n');

describe('init: report lines', () => {
  it('a fresh project reports every created item, the ignore additions and the next step, in order', async () => {
    const h = await init();
    expect(h.code).toBe(0);
    expect(h.stderr).toBe('');
    expect(lines(h.stdout)).toEqual([
      'created  ai-bdd.config.ts',
      'created  docs/example.md',
      'updated  .gitignore (+.ai-bdd/runs/, .ai-bdd/cache/, .ai-bdd/report/)',
      'created  .ai-bdd/plans/',
      '',
      'Next: edit the config, then run `ai-bdd compile` and `ai-bdd show`.',
      '',
    ]);
    expect(await read('.gitignore')).toBe('.ai-bdd/runs/\n.ai-bdd/cache/\n.ai-bdd/report/\n');
  });

  it('a second run reports skipped / ok for everything and rewrites nothing', async () => {
    await init();
    const h = await init();
    expect(lines(h.stdout).slice(0, 4)).toEqual([
      'skipped  ai-bdd.config.ts (already exists; use --yes to overwrite)',
      'skipped  docs/example.md (already exists; use --yes to overwrite)',
      'ok       .gitignore already ignores .ai-bdd/runs/, .ai-bdd/cache/ and .ai-bdd/report/',
      'ok       .ai-bdd/plans/',
    ]);
  });

  it('--yes reports "overwritten" for existing files and "created" for new ones', async () => {
    await mkdir(join(dir, 'docs'));
    await writeFile(join(dir, 'docs/example.md'), 'MINE');
    const h = await init('--yes');
    expect(lines(h.stdout).slice(0, 2)).toEqual(['created  ai-bdd.config.ts', 'overwritten docs/example.md']);
    expect(await read('docs/example.md')).toBe(EXAMPLE_DOC);
  });

  it('--yes --json over an existing TS config writes the JSON config and warns which one wins', async () => {
    await writeFile(join(dir, 'ai-bdd.config.ts'), 'MY TS CONFIG');
    const h = await init('--yes', '--json');
    expect(h.code).toBe(0);
    expect(lines(h.stdout).slice(0, 2)).toEqual([
      'created  ai-bdd.config.json',
      'note     ai-bdd.config.ts takes precedence over ai-bdd.config.json when both exist',
    ]);
    expect(await read('ai-bdd.config.json')).toBe(CONFIG_JSON_TEMPLATE);
    expect(await read('ai-bdd.config.ts')).toBe('MY TS CONFIG');
  });

  it('--yes (TS) over an existing .mjs config writes the TS config next to it and notes the precedence', async () => {
    await writeFile(join(dir, 'ai-bdd.config.mjs'), 'export default {};');
    const h = await init('--yes');
    expect(lines(h.stdout)[0]).toBe('created  ai-bdd.config.ts');
    expect(lines(h.stdout)[1]).toBe('note     ai-bdd.config.mjs takes precedence over ai-bdd.config.ts when both exist');
    expect(await read('ai-bdd.config.ts')).toBe(CONFIG_TS_TEMPLATE);
    expect(await read('ai-bdd.config.mjs')).toBe('export default {};');
  });

  it('--yes over the same-named config overwrites it and prints no precedence note', async () => {
    await writeFile(join(dir, 'ai-bdd.config.json'), '{}');
    const h = await init('--yes', '--json');
    expect(lines(h.stdout)[0]).toBe('overwritten ai-bdd.config.json');
    expect(h.stdout).not.toContain('note ');
    expect(await read('ai-bdd.config.json')).toBe(CONFIG_JSON_TEMPLATE);
  });

  it.each(CONFIG_FILE_NAMES)('an existing %s blocks creating a config (both flavours) without --yes', async (name) => {
    await writeFile(join(dir, name), 'EXISTING');
    for (const args of [[], ['--json']]) {
      const h = await init(...args);
      expect(lines(h.stdout)[0]).toBe(`skipped  ${name} (already exists; use --yes to overwrite)`);
    }
    expect((await readdir(dir)).filter((f) => f.startsWith('ai-bdd.config.'))).toEqual([name]);
    expect(await read(name)).toBe('EXISTING');
  });

  it('with several configs present the first in lookup order is the one named', async () => {
    await writeFile(join(dir, 'ai-bdd.config.json'), '{}');
    await writeFile(join(dir, 'ai-bdd.config.mjs'), '');
    const h = await init();
    expect(lines(h.stdout)[0]).toBe('skipped  ai-bdd.config.mjs (already exists; use --yes to overwrite)');
  });
});

describe('init: .gitignore handling', () => {
  it('creates .gitignore with exactly the three entries when there is none', async () => {
    await init();
    expect(await read('.gitignore')).toBe(`${GITIGNORE_ENTRIES.join('\n')}\n`);
  });

  it('reports "ok" and leaves the file byte-identical when every entry is present, tolerating CRLF and surrounding spaces', async () => {
    const content = 'node_modules\r\n  .ai-bdd/runs/  \r\n.ai-bdd/cache/\r\n\t.ai-bdd/report/\r\n';
    await writeFile(join(dir, '.gitignore'), content);
    const h = await init();
    expect(await read('.gitignore')).toBe(content);
    expect(h.stdout).toContain('ok       .gitignore already ignores');
  });

  it('adds only the missing entries and reports which', async () => {
    await writeFile(join(dir, '.gitignore'), '.ai-bdd/cache/\n');
    const h = await init();
    expect(await read('.gitignore')).toBe('.ai-bdd/cache/\n.ai-bdd/runs/\n.ai-bdd/report/\n');
    expect(h.stdout).toContain('updated  .gitignore (+.ai-bdd/runs/, .ai-bdd/report/)');
  });

  it('inserts a newline before appending when the file does not end with one', async () => {
    await writeFile(join(dir, '.gitignore'), 'dist');
    await init();
    expect(await read('.gitignore')).toBe('dist\n.ai-bdd/runs/\n.ai-bdd/cache/\n.ai-bdd/report/\n');
  });

  it('does not treat a similar spelling (no trailing slash, commented out) as already ignored', async () => {
    await writeFile(join(dir, '.gitignore'), '.ai-bdd/runs\n# .ai-bdd/cache/\n');
    await init();
    expect(await read('.gitignore')).toBe('.ai-bdd/runs\n# .ai-bdd/cache/\n.ai-bdd/runs/\n.ai-bdd/cache/\n.ai-bdd/report/\n');
  });

  it('--yes never rewrites .gitignore content, only appends', async () => {
    await writeFile(join(dir, '.gitignore'), 'keep-me\n');
    await init('--yes');
    expect((await read('.gitignore')).startsWith('keep-me\n')).toBe(true);
  });
});

describe('init: plans directory and nested cwd', () => {
  it('reports an existing plans directory as ok and keeps its files', async () => {
    await mkdir(join(dir, '.ai-bdd/plans'), { recursive: true });
    await writeFile(join(dir, '.ai-bdd/plans/a.plan.json'), '{"keep":true}');
    const h = await init();
    expect(h.stdout).toContain('ok       .ai-bdd/plans/\n');
    expect(await read('.ai-bdd/plans/a.plan.json')).toBe('{"keep":true}');
  });

  it('writes into the injected cwd, creating docs/ as needed, and nothing outside it', async () => {
    const sub = join(dir, 'nested', 'project');
    await mkdir(sub, { recursive: true });
    const h = await runCli(['init'], { cwd: sub });
    expect(h.code).toBe(0);
    expect(await exists('nested/project/ai-bdd.config.ts')).toBe(true);
    expect(await exists('nested/project/docs/example.md')).toBe(true);
    expect(await exists('ai-bdd.config.ts')).toBe(false);
    expect(await exists('.gitignore')).toBe(false);
  });
});

describe('init: templates', () => {
  it('TS and JSON templates plug in the same driver and model packages', () => {
    const json = JSON.parse(CONFIG_JSON_TEMPLATE) as { drivers: { web: { use: string } }; models: { use: string }; docs: string[]; secrets: Record<string, unknown> };
    expect(CONFIG_TS_TEMPLATE).toContain(`from '${json.drivers.web.use}'`);
    expect(CONFIG_TS_TEMPLATE).toContain(`from '${json.models.use}'`);
    expect(json.docs).toEqual(['docs/**/*.md']);
    expect(CONFIG_TS_TEMPLATE).toContain("docs: ['docs/**/*.md']");
    expect(Object.keys(json.secrets)).toEqual(['adminPassword']);
    expect(CONFIG_TS_TEMPLATE).toContain("secrets: { adminPassword: { env: 'ADMIN_PASSWORD' } }");
  });

  it('the example doc is written verbatim and matches the configured docs glob (docs/*.md)', async () => {
    await init();
    expect(await read('docs/example.md')).toBe(EXAMPLE_DOC);
    expect(EXAMPLE_DOC).toMatch(/^# Example product requirements\n/);
    expect(EXAMPLE_DOC).toContain('## Signing in');
  });
});

describe('init: filesystem failures are not swallowed', () => {
  it('a directory where docs/example.md should be is skipped without --yes', async () => {
    await mkdir(join(dir, 'docs/example.md'), { recursive: true });
    const h = await init();
    expect(h.code).toBe(0);
    expect(h.stdout).toContain('skipped  docs/example.md (already exists; use --yes to overwrite)');
    expect((await stat(join(dir, 'docs/example.md'))).isDirectory()).toBe(true);
  });

  it('with --yes, a write that fails for a reason other than EEXIST propagates as an internal error (exit 3)', async () => {
    await mkdir(join(dir, 'docs/example.md'), { recursive: true });
    const h = await init('--yes');
    expect(h.code).toBe(3);
    expect(h.stderr).toMatch(/^ai-bdd: internal error: EISDIR/);
  });

  it('a file named docs makes creating docs/example.md fail loudly (exit 3), after the config was written', async () => {
    await writeFile(join(dir, 'docs'), 'i am a file');
    const h = await init();
    expect(h.code).toBe(3);
    expect(h.stderr).toContain('ai-bdd: internal error:');
    expect(await read('docs')).toBe('i am a file');
  });
});
