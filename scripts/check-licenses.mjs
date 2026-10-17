#!/usr/bin/env node
// Scans the installed packages (node_modules, in whatever layout the package manager chose) and reports licenses outside the allowlist.
// Optional exceptions live in scripts/license-exceptions.json as { "<name>" | "<name>@<version>": "<reason>" }.
import fs from 'node:fs';
import path from 'node:path';
import { finish, isMain, parseArgs } from './lib.mjs';

export const ALLOWED_LICENSES = [
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'Python-2.0',
  'CC0-1.0',
];
const ALLOWED = new Set(ALLOWED_LICENSES.map((l) => l.toLowerCase()));

/** Tokenizes an SPDX expression. */
function tokenize(expr) {
  return expr.match(/\(|\)|[^\s()]+/g) ?? [];
}

/**
 * Evaluates an SPDX expression: `OR` needs one allowed alternative, `AND` needs all of them.
 * Returns false for anything that does not parse.
 */
export function isAllowedExpression(expression, allowed = ALLOWED) {
  const tokens = tokenize(String(expression).trim());
  let pos = 0;
  let valid = true;
  const peek = () => tokens[pos];
  const parseOr = () => {
    let result = parseAnd();
    while (peek() && peek().toUpperCase() === 'OR') {
      pos++;
      const rhs = parseAnd();
      result = result || rhs;
    }
    return result;
  };
  const parseAnd = () => {
    let result = parseAtom();
    while (peek() && peek().toUpperCase() === 'AND') {
      pos++;
      const rhs = parseAtom();
      result = result && rhs;
    }
    return result;
  };
  const parseAtom = () => {
    const t = peek();
    if (t === undefined) {
      valid = false;
      return false;
    }
    pos++;
    if (t === '(') {
      const inner = parseOr();
      if (peek() === ')') pos++;
      else valid = false;
      return inner;
    }
    if (t === ')' || t.toUpperCase() === 'OR' || t.toUpperCase() === 'AND') {
      valid = false;
      return false;
    }
    let ok = allowed.has(t.replace(/\+$/, '').toLowerCase());
    if (peek() && peek().toUpperCase() === 'WITH') {
      pos += 2; // `WITH <exception>` keeps the base license verdict
    }
    return ok;
  };
  const result = parseOr();
  return valid && pos === tokens.length && result;
}

/** Normalizes the license metadata of a package.json to an SPDX-like expression (or undefined). */
export function licenseExpression(pkg) {
  const lic = pkg.license;
  if (typeof lic === 'string') return lic;
  if (lic && typeof lic === 'object' && typeof lic.type === 'string') return lic.type;
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean);
    if (types.length > 0) return types.length === 1 ? types[0] : `(${types.join(' OR ')})`;
  }
  return undefined;
}

/** Real path of `p`, or undefined when it does not resolve (a dangling symlink, a race with a deletion). */
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readDir(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Every installed package, whatever layout the package manager chose. The walk starts at the root `node_modules` and follows
 * nested `node_modules` directories and the targets of symlinks (workspace links, pnpm's `.pnpm` store, a hoisted or a nested
 * tree), and reads each real package directory once, however many links lead to it. A package's dependencies are looked for in
 * its own `node_modules` and in the `node_modules` that holds it (where pnpm puts them). Returns null when there is no
 * `node_modules` at all.
 */
function listInstalledPackages(root) {
  const top = path.join(root, 'node_modules');
  if (!isDirectory(top)) return null;
  const found = new Map();
  const scannedDirs = new Set();
  const visitedPackages = new Set();
  const queue = [top];

  const visitPackage = (dir) => {
    const target = real(dir);
    if (target === undefined || visitedPackages.has(target) || !isDirectory(target)) return;
    visitedPackages.add(target);
    const file = path.join(target, 'package.json');
    if (fs.existsSync(file)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (pkg && typeof pkg.name === 'string') found.set(`${pkg.name}@${pkg.version ?? '0.0.0'}`, pkg);
      } catch {
        /* unreadable package.json: skipped, nothing to attribute */
      }
    }
    queue.push(path.join(target, 'node_modules'));
    const holder = path.dirname(target);
    queue.push(path.basename(holder).startsWith('@') ? path.dirname(holder) : holder);
  };

  const scanNodeModules = (dir) => {
    if (path.basename(dir) !== 'node_modules') return;
    const target = real(dir);
    if (target === undefined || scannedDirs.has(target) || !isDirectory(target)) return;
    scannedDirs.add(target);
    for (const name of readDir(target)) {
      const entry = path.join(target, name);
      if (name === '.pnpm') {
        for (const stored of readDir(entry)) queue.push(path.join(entry, stored, 'node_modules'));
      } else if (name.startsWith('.')) {
        continue; // .bin, and the package managers' own state files
      } else if (name.startsWith('@')) {
        for (const scoped of readDir(entry)) visitPackage(path.join(entry, scoped));
      } else {
        visitPackage(entry);
      }
    }
  };

  while (queue.length > 0) scanNodeModules(queue.shift());
  return found;
}

export function checkLicenses(root) {
  const installed = listInstalledPackages(root);
  if (installed === null) {
    return { ok: false, problems: ['node_modules not found: install the dependencies first'] };
  }
  let exceptions = {};
  const exFile = path.join(root, 'scripts', 'license-exceptions.json');
  if (fs.existsSync(exFile)) exceptions = JSON.parse(fs.readFileSync(exFile, 'utf8'));
  const problems = [];
  const keys = [...installed.keys()].sort();
  for (const key of keys) {
    const pkg = installed.get(key);
    const name = pkg.name;
    if (exceptions[key] || exceptions[name]) continue;
    if (pkg.private === true && !pkg.license) continue;
    const expr = licenseExpression(pkg);
    if (expr === undefined) problems.push(`${key}: no license declared`);
    else if (!isAllowedExpression(expr)) problems.push(`${key}: license '${expr}' is not on the allowlist`);
  }
  return { ok: problems.length === 0, problems, summary: `${keys.length} packages scanned` };
}

if (isMain(import.meta.url)) {
  const { root } = parseArgs(process.argv.slice(2), import.meta.url);
  process.exit(finish('check-licenses', checkLicenses(root)));
}
