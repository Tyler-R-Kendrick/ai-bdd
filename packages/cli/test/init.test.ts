import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './helpers.ts';
import { CONFIG_JSON_TEMPLATE, CONFIG_TS_TEMPLATE } from '../src/templates.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ai-bdd-init-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = (p: string) => readFile(join(dir, p), 'utf8');
const exists = (p: string) => stat(join(dir, p)).then(() => true, () => false);
const init = (...args: string[]) => runCli(['init', ...args], { cwd: dir });

describe('init (G8)', () => {
  it('writes the TS config, example doc, gitignore entries and an empty plans dir', async () => {
    const h = await init();
    expect(h.code).toBe(0);
    expect(await read('ai-bdd.config.ts')).toBe(CONFIG_TS_TEMPLATE);
    expect(await read('ai-bdd.config.ts')).toContain("import { defineConfig } from '@ai-bdd/sdk';");
    expect(await read('docs/example.md')).toContain('# Example product requirements');
    const gi = await read('.gitignore');
    expect(gi).toContain('.ai-bdd/runs/');
    expect(gi).toContain('.ai-bdd/cache/');
    expect(gi).toContain('.ai-bdd/report/');
    expect(await readdir(join(dir, '.ai-bdd', 'plans'))).toEqual([]);
    expect(h.createEngine).not.toHaveBeenCalled();
    expect(h.loadConfig).not.toHaveBeenCalled();
  });

  it('--json writes ai-bdd.config.json (valid JSON using the `use` form) instead of the TS config', async () => {
    const h = await init('--json');
    expect(h.code).toBe(0);
    expect(await exists('ai-bdd.config.ts')).toBe(false);
    const text = await read('ai-bdd.config.json');
    expect(text).toBe(CONFIG_JSON_TEMPLATE);
    const cfg = JSON.parse(text);
    expect(cfg.drivers.web.use).toBe('@ai-bdd/driver-playwright');
    expect(cfg.models.use).toBe('@ai-bdd/models-ai-sdk');
    expect(Object.keys(cfg).sort()).toEqual(['baseURL', 'context', 'defaultDriver', 'docs', 'drivers', 'models', 'secrets']);
  });

  it('never overwrites existing files without --yes, and exits 0', async () => {
    await writeFile(join(dir, 'ai-bdd.config.ts'), 'MY CONFIG');
    await mkdir(join(dir, 'docs'));
    await writeFile(join(dir, 'docs/example.md'), 'MY DOC');
    const h = await init();
    expect(h.code).toBe(0);
    expect(await read('ai-bdd.config.ts')).toBe('MY CONFIG');
    expect(await read('docs/example.md')).toBe('MY DOC');
    expect(h.stdout).toContain('skipped  ai-bdd.config.ts (already exists; use --yes to overwrite)');
    expect(h.stdout).toContain('skipped  docs/example.md');
  });

  it('does not write a second config when a different config format already exists', async () => {
    await writeFile(join(dir, 'ai-bdd.config.mjs'), 'export default {};');
    const h = await init('--json');
    expect(await exists('ai-bdd.config.json')).toBe(false);
    expect(h.stdout).toContain('skipped  ai-bdd.config.mjs');
  });

  it('--yes overwrites existing files', async () => {
    await writeFile(join(dir, 'ai-bdd.config.ts'), 'MY CONFIG');
    await mkdir(join(dir, 'docs'));
    await writeFile(join(dir, 'docs/example.md'), 'MY DOC');
    const h = await init('--yes');
    expect(h.code).toBe(0);
    expect(await read('ai-bdd.config.ts')).toBe(CONFIG_TS_TEMPLATE);
    expect(await read('docs/example.md')).toContain('Signing in');
    expect(h.stdout).toContain('overwritten ai-bdd.config.ts');
  });

  it('keeps existing .gitignore content, appends only missing entries, and is idempotent', async () => {
    await writeFile(join(dir, '.gitignore'), 'node_modules\n.ai-bdd/runs/');
    await init();
    const once = await read('.gitignore');
    expect(once).toBe('node_modules\n.ai-bdd/runs/\n.ai-bdd/cache/\n.ai-bdd/report/\n');
    await init();
    expect(await read('.gitignore')).toBe(once);
  });

  it('is idempotent: a second init changes nothing', async () => {
    await init();
    const first = await Promise.all(['ai-bdd.config.ts', 'docs/example.md', '.gitignore'].map(read));
    const h = await init();
    expect(await Promise.all(['ai-bdd.config.ts', 'docs/example.md', '.gitignore'].map(read))).toEqual(first);
    expect(h.stdout).toContain('skipped  ai-bdd.config.ts');
  });

  it('does not touch an existing plans directory content', async () => {
    await mkdir(join(dir, '.ai-bdd/plans'), { recursive: true });
    await writeFile(join(dir, '.ai-bdd/plans/x.plan.json'), '{}');
    await init('--yes');
    expect(await read('.ai-bdd/plans/x.plan.json')).toBe('{}');
  });
});
