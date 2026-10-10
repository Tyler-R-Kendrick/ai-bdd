// @ts-nocheck
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeTestConfig } from '@ai-bdd/testing';
import { CORPUS_DIR, RULES_BASE_DIR, VARIANTS_DIR, WORK_ROOT } from './paths.ts';

/** Keys of `.corpus-options.json`; the corpus config spreads them into the user config (CLI path) and the SDK harness applies them to the resolved config. */
export interface ConfigOverrides {
  /** false: the corpus config registers no fixtures (M14 "no fixture configured"). */
  fixtures?: boolean;
  baseURL?: string;
  extract?: Record<string, number>;
  characterize?: Record<string, number>;
  judge?: Record<string, number | boolean>;
  agent?: Record<string, number>;
  checks?: Record<string, number | boolean>;
  settle?: Record<string, number | boolean>;
  concurrency?: { scenarios?: number };
  policy?: Record<string, unknown>;
  context?: string;
}

/** A rule layer: the base set, a corpus variant directory, or inline rules written by the test itself. */
export type RuleLayer = 'base' | (string & {}) | { inline: Record<string, unknown>[]; name?: string };

/** Real-clock presets: short quiet windows so CLI and browser runs stay fast. */
export const FAST_REAL: ConfigOverrides = {
  characterize: { probeMs: 100 },
  settle: { quietMs: 100, intervalMs: 30, timeoutMs: 5000 },
};

export const ALL_DOCS = ['billing', 'todos', 'checkout', 'login', 'reports', 'release-notes'] as const;

export class Project {
  readonly dir: string;
  options: ConfigOverrides;

  constructor(dir: string, options: ConfigOverrides) {
    this.dir = dir;
    this.options = options;
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }
  get plansDir(): string {
    return this.path('.ai-bdd', 'plans');
  }
  get recordingsDir(): string {
    return this.path('.ai-bdd', 'recordings');
  }
  get runsDir(): string {
    return this.path('.ai-bdd', 'runs');
  }
  get cacheDir(): string {
    return this.path('.ai-bdd', 'cache');
  }
  get aiBddDir(): string {
    return this.path('.ai-bdd');
  }
  get rulesDir(): string {
    return this.path('.rules');
  }
  /** JSONL fake-call log: the `logPath` the generated test config hands to `createFakeModels`. */
  get logPath(): string {
    return this.path('fake-calls.jsonl');
  }

  readDoc(name: string): string {
    return readFileSync(this.path('docs', `${name}.md`), 'utf8');
  }
  writeDoc(name: string, text: string): void {
    writeFileSync(this.path('docs', `${name}.md`), text);
  }
  /** Replace `from` by `to` exactly once; throws when the text is not found (keeps edits honest). */
  editDoc(name: string, from: string, to: string): void {
    const text = this.readDoc(name);
    if (!text.includes(from)) throw new Error(`editDoc(${name}): text not found: ${from}`);
    this.writeDoc(name, text.replace(from, to));
  }
  removeDoc(name: string): void {
    rmSync(this.path('docs', `${name}.md`), { force: true });
  }

  /** (Re)write `.corpus-options.json`. Only meaningful before the first config import in this process (CLI spawns read it fresh). */
  setOptions(options: ConfigOverrides): void {
    this.options = options;
    writeFileSync(this.path('.corpus-options.json'), `${JSON.stringify(options, null, 2)}\n`);
  }

  /** Compose the rule directory the fake models read: layers are written in order; earlier layers win (file-name order, first match wins). */
  setRules(layers: readonly RuleLayer[]): string {
    rmSync(this.rulesDir, { recursive: true, force: true });
    mkdirSync(this.rulesDir, { recursive: true });
    layers.forEach((layer, i) => {
      const prefix = String(i).padStart(2, '0');
      if (typeof layer === 'object') {
        writeFileSync(join(this.rulesDir, `${prefix}-inline-${layer.name ?? 'rules'}.json`), `${JSON.stringify({ rules: layer.inline }, null, 2)}\n`);
        return;
      }
      const dir = layer === 'base' ? RULES_BASE_DIR : join(VARIANTS_DIR, layer);
      if (!existsSync(dir)) throw new Error(`unknown rule layer "${layer}" (${dir})`);
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
        cpSync(join(dir, file), join(this.rulesDir, `${prefix}-${layer.replace(/[^a-z0-9-]/gi, '_')}-${file}`));
      }
    });
    return this.rulesDir;
  }

  /**
   * Write a generated test config into the project (`writeTestConfig` from `@ai-bdd/testing`): it extends the project's real
   * config and registers the fake models (this project's rule directory and call log) and the fake driver through the ordinary
   * `models` / `drivers` keys. Returns its absolute path, to be passed as `ai-bdd -c <file>` or `loadConfig({ configPath })`.
   * Every call may use another `fileName` (an ES module is imported once per file name in a process).
   */
  writeTestConfig(opts: { flags?: readonly string[]; overrides?: Record<string, unknown>; fileName?: string } = {}): string {
    return writeTestConfig({
      projectDir: this.dir,
      rulesDir: this.rulesDir,
      logPath: this.logPath,
      flags: opts.flags ?? [],
      ...(opts.overrides === undefined ? {} : { overrides: opts.overrides }),
      ...(opts.fileName === undefined ? {} : { fileName: opts.fileName }),
    });
  }

  cleanup(): void {
    if (process.env['AI_BDD_KEEP_WORK'] === '1') return;
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export interface CreateProjectOptions {
  /** doc names without extension; default: all six corpus docs */
  docs?: readonly string[];
  options?: ConfigOverrides;
  layers?: readonly RuleLayer[];
}

/** A throw-away project: a copy of the corpus (docs + config) inside the repo so workspace imports resolve. */
export function createProject(opts: CreateProjectOptions = {}): Project {
  mkdirSync(WORK_ROOT, { recursive: true });
  const dir = mkdtempSync(join(WORK_ROOT, 'p-'));
  mkdirSync(join(dir, 'docs'), { recursive: true });
  cpSync(join(CORPUS_DIR, 'ai-bdd.config.mjs'), join(dir, 'ai-bdd.config.mjs'));
  for (const name of opts.docs ?? ALL_DOCS) cpSync(join(CORPUS_DIR, 'docs', `${name}.md`), join(dir, 'docs', `${name}.md`));
  const project = new Project(dir, opts.options ?? {});
  project.setOptions(project.options);
  project.setRules(opts.layers ?? ['base']);
  return project;
}
