#!/usr/bin/env node
// Builds every workspace package in dependency order, with no package manager. The workspace is the `packages` list of
// pnpm-workspace.yaml (globs, `!` exclusions), or packages/* when there is no such file. Each package's own `build` script
// runs the way a package manager's `run` runs it, through the shell, in the package's directory, with the `node_modules/.bin`
// directories from the package up to the repository root first on PATH. The first failure stops the build and names the package.
//
//   node scripts/build-packages.mjs [--root <dir>]
//
// A package without a `build` script is skipped. A dependency on another workspace package (in any dependency field, whatever the
// version range says) orders that package first; packages that do not depend on each other build in path order.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isMain, parseArgs } from './lib.mjs';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** The workspace when there is no pnpm-workspace.yaml. */
const DEFAULT_PATTERNS = ['packages/*'];

/** A YAML scalar written as a list item: a single- or double-quoted string, or plain text up to a comment. */
function scalar(raw) {
  const s = raw.trim();
  const single = /^'((?:[^']|'')*)'/.exec(s);
  if (single) return single[1].replaceAll("''", "'");
  const double = /^"(?:[^"\\]|\\.)*"/.exec(s);
  if (double) return JSON.parse(double[0]);
  return s.replace(/(^|\s)#.*$/, '').trim();
}

/**
 * The `packages` list of a pnpm-workspace.yaml, as a block list (`  - 'packages/*'`) or a flow list (`['packages/*']`); undefined
 * when the file has no such key. Nothing else in the file is read.
 */
export function workspacePatterns(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^packages\s*:/.test(l));
  if (at === -1) return undefined;
  const rest = lines[at].replace(/^packages\s*:\s*/, '').replace(/^#.*$/, '').trim();
  if (rest.startsWith('[')) {
    const body = /^\[(.*)\]/.exec(rest)?.[1] ?? '';
    return body.split(',').map(scalar).filter((x) => x !== '');
  }
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item === null) break;
    out.push(scalar(item[1]));
  }
  return out;
}

/** Directories below `dir` (relative to `root`, POSIX separators), node_modules and dot directories left out, as `*` does. */
function subdirs(root, dir) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')).map((e) => (dir === '' ? e.name : `${dir}/${e.name}`));
}

/** The directories a workspace pattern names: `*` and `?` within one segment, `**` for any depth, anything else literally. */
function expandPattern(root, pattern) {
  let dirs = [''];
  for (const seg of pattern.replace(/^\.\//, '').replace(/\/+$/, '').split('/').filter((x) => x !== '' && x !== '.')) {
    const next = [];
    for (const d of dirs) {
      if (seg === '**') {
        const stack = [d];
        while (stack.length > 0) {
          const cur = stack.pop();
          next.push(cur);
          stack.push(...subdirs(root, cur));
        }
      } else if (/[*?]/.test(seg)) {
        const re = new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]')}$`);
        next.push(...subdirs(root, d).filter((x) => re.test(x.slice(x.lastIndexOf('/') + 1))));
      } else if (fs.existsSync(path.join(root, d, seg))) {
        next.push(d === '' ? seg : `${d}/${seg}`);
      }
    }
    dirs = [...new Set(next)];
  }
  return dirs;
}

/** The workspace patterns: pnpm-workspace.yaml's `packages` list, or `packages/*` when there is no such file. */
function patternsOf(root) {
  const file = path.join(root, 'pnpm-workspace.yaml');
  if (!fs.existsSync(file)) return DEFAULT_PATTERNS;
  const patterns = workspacePatterns(fs.readFileSync(file, 'utf8'));
  if (patterns === undefined || patterns.length === 0) throw new Error('pnpm-workspace.yaml has no packages list');
  return patterns;
}

/**
 * The workspace packages: each directory with a package.json that the workspace patterns name, `!` patterns taken out, sorted
 * by path. The repository root is never one of them (its own `build` is this script).
 */
export function readPackages(root) {
  const include = new Set();
  const exclude = new Set();
  for (const p of patternsOf(root)) for (const d of expandPattern(root, p.replace(/^!/, ''))) (p.startsWith('!') ? exclude : include).add(d);
  const out = [];
  for (const where of [...include].filter((d) => d !== '' && !exclude.has(d)).sort()) {
    const dir = path.join(root, ...where.split('/'));
    const file = path.join(dir, 'package.json');
    if (!fs.existsSync(file)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`${where}/package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    out.push({ name: typeof manifest.name === 'string' ? manifest.name : path.basename(dir), dir, where, manifest });
  }
  return out;
}

/** Names of the workspace packages a manifest depends on. */
function workspaceDeps(manifest, names) {
  const deps = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    for (const dep of Object.keys(manifest[field] ?? {})) if (names.has(dep) && dep !== manifest.name) deps.add(dep);
  }
  return deps;
}

/**
 * Orders packages so that each one comes after the workspace packages it depends on. Throws on a cycle, naming its members, and on
 * two packages with one name, naming both (dependencies are matched by name, so either could be built before what it needs).
 */
export function buildOrder(packages) {
  const byName = new Map();
  for (const p of packages) {
    const other = byName.get(p.name);
    if (other !== undefined) throw new Error(`two workspace packages are named ${p.name}: ${other.where ?? other.dir} and ${p.where ?? p.dir}`);
    byName.set(p.name, p);
  }
  const names = new Set(byName.keys());
  const pending = new Map(packages.map((p) => [p.name, workspaceDeps(p.manifest, names)]));
  const order = [];
  while (pending.size > 0) {
    const ready = packages.filter((p) => pending.has(p.name) && [...pending.get(p.name)].every((d) => !pending.has(d)));
    if (ready.length === 0) throw new Error(`dependency cycle among ${[...pending.keys()].sort().join(', ')}`);
    for (const p of ready) {
      order.push(p);
      pending.delete(p.name);
    }
  }
  return order;
}

/** The environment a package script runs in: PATH starts with each `node_modules/.bin` from `dir` up to `root`. */
export function scriptEnv(root, dir, env = process.env, platform = process.platform) {
  const bins = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    bins.push(path.join(d, 'node_modules', '.bin'));
    if (d === path.resolve(root) || path.dirname(d) === d) break;
  }
  // Windows spells the variable Path as often as PATH; keep whichever exists so there is only one
  const key = platform === 'win32' ? (Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path') : 'PATH';
  const delimiter = platform === 'win32' ? ';' : ':';
  const rest = env[key] ? [env[key]] : [];
  return { ...env, [key]: [...bins, ...rest].join(delimiter) };
}

export function main(argv, { log = console, run = spawnSync, env = process.env, platform = process.platform } = {}) {
  const { root } = parseArgs(argv, import.meta.url);
  let order;
  try {
    order = buildOrder(readPackages(root));
  } catch (err) {
    log.error(`build-packages: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  let built = 0;
  for (const pkg of order) {
    const script = pkg.manifest.scripts?.build;
    const where = path.relative(root, pkg.dir).split(path.sep).join('/');
    if (typeof script !== 'string' || script.trim() === '') {
      log.log(`build-packages: ${pkg.name} (${where}) has no build script, skipped`);
      continue;
    }
    log.log(`\n> ${pkg.name} build (${where})\n> ${script}`);
    const r = run(script, { cwd: pkg.dir, shell: true, stdio: 'inherit', env: scriptEnv(root, pkg.dir, env, platform) });
    if (r.error !== undefined || r.status !== 0) {
      const why = r.error !== undefined ? r.error.message : r.signal ? `signal ${r.signal}` : `exit code ${r.status}`;
      log.error(`build-packages: ${pkg.name} (${where}) failed: ${why}`);
      return 1;
    }
    built += 1;
  }
  log.log(`build-packages: ${built} package(s) built`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
