import { mkdir, readFile, writeFile, appendFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExitCode } from '@ai-bdd/sdk/contracts';
import type { Ctx } from '../context.ts';
import {
  CONFIG_FILE_NAMES,
  CONFIG_JSON_TEMPLATE,
  CONFIG_TS_TEMPLATE,
  EXAMPLE_DOC,
  GITIGNORE_ENTRIES,
} from '../templates.ts';

export interface InitOptions { yes?: boolean | undefined; json?: boolean | undefined }

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Writes `content` to `path`. Without `overwrite`, an existing file is never touched (exclusive create). */
async function writeGuarded(path: string, content: string, overwrite: boolean): Promise<'created' | 'overwritten' | 'skipped'> {
  await mkdir(dirname(path), { recursive: true });
  const existed = await exists(path);
  if (existed && !overwrite) return 'skipped';
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'skipped';
    throw e;
  }
  return existed ? 'overwritten' : 'created';
}

async function ensureGitignore(path: string): Promise<string[]> {
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch {
    current = '';
  }
  const present = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_ENTRIES.filter((e) => !present.has(e));
  if (missing.length === 0) return [];
  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  await appendFile(path, `${prefix}${missing.join('\n')}\n`, 'utf8');
  return missing;
}

export async function runInit(ctx: Ctx, opts: InitOptions): Promise<ExitCode> {
  const root = ctx.io.cwd;
  const overwrite = opts.yes === true;
  const configName = opts.json === true ? 'ai-bdd.config.json' : 'ai-bdd.config.ts';
  const configContent = opts.json === true ? CONFIG_JSON_TEMPLATE : CONFIG_TS_TEMPLATE;

  // Any existing config would shadow or be shadowed by the new one, so it counts as "exists".
  let existingConfig: string | undefined;
  for (const name of CONFIG_FILE_NAMES) {
    if (await exists(join(root, name))) {
      existingConfig = name;
      break;
    }
  }

  const lines: string[] = [];
  if (existingConfig !== undefined && !overwrite) {
    lines.push(`skipped  ${existingConfig} (already exists; use --yes to overwrite)`);
  } else {
    const r = await writeGuarded(join(root, configName), configContent, overwrite);
    lines.push(`${r.padEnd(8)} ${configName}`);
    if (existingConfig !== undefined && existingConfig !== configName) {
      lines.push(`note     ${existingConfig} takes precedence over ${configName} when both exist`);
    }
  }

  const doc = await writeGuarded(join(root, 'docs', 'example.md'), EXAMPLE_DOC, overwrite);
  lines.push(doc === 'skipped' ? 'skipped  docs/example.md (already exists; use --yes to overwrite)' : `${doc.padEnd(8)} docs/example.md`);

  const added = await ensureGitignore(join(root, '.gitignore'));
  lines.push(added.length > 0 ? `updated  .gitignore (+${added.join(', ')})` : 'ok       .gitignore already ignores .ai-bdd/runs/, .ai-bdd/cache/ and .ai-bdd/report/');

  const plansDir = join(root, '.ai-bdd', 'plans');
  const plansExisted = await exists(plansDir);
  await mkdir(plansDir, { recursive: true });
  lines.push(plansExisted ? 'ok       .ai-bdd/plans/' : 'created  .ai-bdd/plans/');

  for (const l of lines) ctx.out(l);
  ctx.out();
  ctx.out('Next: edit the config, then run `ai-bdd compile` and `ai-bdd show`.');
  return 0;
}
