#!/usr/bin/env node
// Builds every workspace package (packages/*) in dependency order, with no package manager: each package's own `build` script
// runs the way a package manager's `run` runs it, through the shell, in the package's directory, with the `node_modules/.bin`
// directories from the package up to the repository root first on PATH. The first failure stops the build and names the package.
//
//   node scripts/build-packages.mjs [--root <dir>]
//
// A package without a `build` script is skipped. A dependency on another workspace package (in any dependency field, whatever the
// version range says) orders that package first; packages that do not depend on each other build in directory-name order.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isMain, parseArgs } from './lib.mjs';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** The workspace packages: every `packages/<dir>/package.json`, sorted by directory name. */
export function readPackages(root) {
  const base = path.join(root, 'packages');
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const file = path.join(base, e.name, 'package.json');
    if (!fs.existsSync(file)) continue;
    const dir = path.join(base, e.name);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`${path.relative(root, file).split(path.sep).join('/')} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    out.push({ name: typeof manifest.name === 'string' ? manifest.name : e.name, dir, where: path.relative(root, dir).split(path.sep).join('/'), manifest });
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
