import { spawn } from 'node:child_process';
import { ACME_DEFAULT_ADMIN_PASSWORD, CLI_BIN, REPO_ROOT } from './paths.ts';
import type { Project, RuleLayer } from './project.ts';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  /** extra environment; `undefined` deletes a variable */
  env?: Record<string, string | undefined>;
  /** AI_BDD_FAKE=1 (default true) */
  fake?: boolean;
  /** Acme flags for the fake driver (AI_BDD_FAKE_FLAGS) */
  flags?: string[];
  /** recompose the rule directory first */
  layers?: readonly RuleLayer[];
  timeoutMs?: number;
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // CI and AI_BDD_* from the outer environment must not leak into the spawned CLI (R-RN4 tests set them explicitly).
    if (k === 'CI' || k.startsWith('AI_BDD_') || k === 'ACME_ADMIN_PASSWORD' || k === 'ACME_URL') continue;
    env[k] = v;
  }
  return env;
}

/** `node --conditions=source packages/cli/src/bin.ts <args>` in the project directory with AI_BDD_FAKE=1 against the project's rule directory. */
export function runCli(project: Project, args: string[], opts: CliOptions = {}): Promise<CliResult> {
  if (opts.layers !== undefined) project.setRules(opts.layers);
  const env = baseEnv();
  env['NODE_NO_WARNINGS'] = '1';
  env['ACME_ADMIN_PASSWORD'] = ACME_DEFAULT_ADMIN_PASSWORD;
  if (opts.fake !== false) {
    env['AI_BDD_FAKE'] = '1';
    env['AI_BDD_FAKE_RULES'] = project.rulesDir;
    env['AI_BDD_FAKE_LOG'] = project.logPath;
    env['AI_BDD_FAKE_FLAGS'] = (opts.flags ?? []).join(',');
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--conditions=source', CLI_BIN, ...args], { cwd: project.dir, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ai-bdd ${args.join(' ')} timed out after ${opts.timeoutMs ?? 120_000} ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, opts.timeoutMs ?? 120_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export const cliOutput = (r: CliResult): string => `exit ${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;

export { REPO_ROOT };
