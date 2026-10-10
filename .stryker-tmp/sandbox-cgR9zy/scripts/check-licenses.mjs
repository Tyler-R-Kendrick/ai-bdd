#!/usr/bin/env node
// @ts-nocheck
// Scans installed packages (node_modules/.pnpm) and reports licenses outside the allowlist.
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

function listInstalledPackages(root) {
  const store = path.join(root, 'node_modules', '.pnpm');
  const found = new Map();
  let dirs;
  try {
    dirs = fs.readdirSync(store, { withFileTypes: true });
  } catch {
    return null;
  }
  const consider = (dir) => {
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch {
      return;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return; // symlinks are other packages' dependencies
    const file = path.join(dir, 'package.json');
    if (!fs.existsSync(file)) return;
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (pkg && typeof pkg.name === 'string') found.set(`${pkg.name}@${pkg.version ?? '0.0.0'}`, pkg);
    } catch {
      /* unreadable package.json: skipped, nothing to attribute */
    }
  };
  for (const d of dirs) {
    if (!d.isDirectory() || d.name === 'node_modules') continue;
    const nm = path.join(store, d.name, 'node_modules');
    let entries;
    try {
      entries = fs.readdirSync(nm, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.name.startsWith('@')) {
        let scoped = [];
        try {
          scoped = fs.readdirSync(path.join(nm, e.name));
        } catch {
          /* not a directory */
        }
        for (const s of scoped) consider(path.join(nm, e.name, s));
      } else {
        consider(path.join(nm, e.name));
      }
    }
  }
  return found;
}

export function checkLicenses(root) {
  const installed = listInstalledPackages(root);
  if (installed === null) {
    return { ok: false, problems: ['node_modules/.pnpm not found: run pnpm install first'] };
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
