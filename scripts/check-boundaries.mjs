#!/usr/bin/env node
// Enforces the package import boundaries (R-SDK2):
//  - non-sdk packages import only '@ai-bdd/sdk' and '@ai-bdd/sdk/contracts' from the sdk, plus workspace
//    packages declared in their own package.json (dependencies, peerDependencies, optionalDependencies);
//  - packages/cli reaches '@ai-bdd/testing', '@ai-bdd/driver-playwright' and '@ai-bdd/models-ai-sdk' only through
//    dynamic import() (type-only static imports are erased and therefore allowed);
//  - sdk modules import sibling modules only through '../<module>/index.ts' (contracts and util are open);
//  - nothing imports from a 'dist' directory;
//  - relative imports never leave their package.
// Test files (packages/*/test, tests/, *.test.ts) may import more, but never from 'dist'.
import fs from 'node:fs';
import path from 'node:path';
import { finish, isMain, lineOf, listPackages, parseArgs, readJson, scanSource, toPosix, walk } from './lib.mjs';

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const OPEN_SDK_MODULES = new Set(['contracts', 'util']);
const DIST = /(^|\/)dist(\/|$)/;

/** Extracts import specifiers from TS/JS source. */
export function extractImports(source) {
  const { text, templates } = scanSource(source);
  const found = [];
  // Code inside a template literal (for example the `ai-bdd init` scaffold) is data, not an import.
  const inTemplate = (index) => templates.some(([a, b]) => index >= a && index < b);
  const add = (m, specIndex, kind, typeOnly) => {
    if (!inTemplate(m.index)) found.push({ spec: m[specIndex], kind, typeOnly, index: m.index });
  };
  let m;
  const staticRe = /(?<![\w$.])import\s+(type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?(['"])([^'"\n]+)\2/g;
  while ((m = staticRe.exec(text))) add(m, 3, 'static', Boolean(m[1]));
  const reexportRe = /(?<![\w$.])export\s+(type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+(['"])([^'"\n]+)\2/g;
  while ((m = reexportRe.exec(text))) add(m, 3, 'static', Boolean(m[1]));
  const dynamicRe = /(?<![\w$.])import\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g;
  while ((m = dynamicRe.exec(text))) add(m, 2, 'dynamic', false);
  const requireRe = /(?<![\w$.])require\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  while ((m = requireRe.exec(text))) add(m, 2, 'require', false);
  return found.map((f) => ({ ...f, line: lineOf(text, f.index) }));
}

function splitWorkspaceSpec(spec) {
  const parts = spec.split('/');
  return { pkg: parts[1], sub: parts.slice(2).join('/') };
}

function declaredWorkspaceDeps(pkgJson) {
  const names = new Set();
  for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkgJson?.[key] ?? {})) if (name.startsWith('@ai-bdd/')) names.add(name.split('/')[1]);
  }
  return names;
}

function isTestFile(rel) {
  return /(^|\/)test\//.test(rel) || rel.startsWith('tests/') || /\.test\.[cm]?[jt]sx?$/.test(rel);
}

function stripExt(p) {
  return p.replace(/\.[cm]?[jt]sx?$/, '');
}

export function checkBoundaries(root) {
  const problems = [];
  const packages = listPackages(root);
  const pkgJsons = new Map();
  for (const pkg of packages) {
    try {
      pkgJsons.set(pkg, readJson(path.join(root, 'packages', pkg, 'package.json')));
    } catch {
      pkgJsons.set(pkg, null);
    }
  }
  let scanned = 0;

  const scanFile = (abs, pkg) => {
    const rel = toPosix(path.relative(root, abs));
    const test = isTestFile(rel);
    const imports = extractImports(fs.readFileSync(abs, 'utf8'));
    scanned++;
    for (const imp of imports) {
      const where = `${rel}:${imp.line} import '${imp.spec}'`;
      const spec = imp.spec;
      if (DIST.test(spec)) {
        problems.push(`${where}: imports from dist/ are forbidden`);
        continue;
      }
      if (test || !pkg) continue;
      const pkgRoot = path.join(root, 'packages', pkg);
      if (spec.startsWith('@ai-bdd/')) {
        const { pkg: target, sub } = splitWorkspaceSpec(spec);
        if (target === pkg) {
          if (pkg === 'sdk' && sub !== '' && sub !== 'contracts') problems.push(`${where}: sdk must not deep-import itself`);
          continue;
        }
        if (pkg === 'sdk') {
          problems.push(`${where}: sdk must not import other workspace packages`);
        } else if (target === 'sdk') {
          if (sub !== '' && sub !== 'contracts') problems.push(`${where}: only '@ai-bdd/sdk' and '@ai-bdd/sdk/contracts' are public entry points`);
        } else if (!declaredWorkspaceDeps(pkgJsons.get(pkg)).has(target)) {
          problems.push(`${where}: @ai-bdd/${target} is not declared in packages/${pkg}/package.json`);
        } else if (sub !== '') {
          problems.push(`${where}: only the root entry point of @ai-bdd/${target} may be imported`);
        } else if (pkg === 'cli' && imp.kind === 'static' && !imp.typeOnly) {
          problems.push(`${where}: packages/cli must load @ai-bdd/${target} with a dynamic import() (R-SDK2)`);
        }
        continue;
      }
      if (!spec.startsWith('.')) continue; // node builtins and third-party packages
      const resolved = path.resolve(path.dirname(abs), spec);
      if (path.relative(pkgRoot, resolved).startsWith('..')) {
        problems.push(`${where}: relative import leaves packages/${pkg}`);
        continue;
      }
      if (pkg !== 'sdk') continue;
      const srcRoot = path.join(pkgRoot, 'src');
      const relSrc = toPosix(path.relative(srcRoot, resolved));
      if (relSrc.startsWith('..')) {
        problems.push(`${where}: sdk source imports outside packages/sdk/src`);
        continue;
      }
      const targetSegs = relSrc.split('/');
      const targetModule = targetSegs[0];
      const ownSegs = toPosix(path.relative(srcRoot, abs)).split('/');
      const ownModule = ownSegs.length > 1 ? ownSegs[0] : null;
      if (targetSegs.length === 1 && /\.[cm]?[jt]sx?$/.test(targetModule)) continue; // a file at the src root
      if (targetModule === ownModule || OPEN_SDK_MODULES.has(targetModule)) continue;
      const viaIndex = stripExt(relSrc);
      if (viaIndex === targetModule || viaIndex === `${targetModule}/index`) continue;
      problems.push(`${where}: sdk modules may import sibling module '${targetModule}' only via '../${targetModule}/index.ts'`);
    }
  };

  for (const pkg of packages) {
    const dirs = ['src', 'test'].map((d) => path.join(root, 'packages', pkg, d));
    for (const d of dirs) for (const f of walk(d, { filter: (x) => SOURCE_FILE.test(x) })) scanFile(f, pkg);
  }
  for (const f of walk(path.join(root, 'tests'), { filter: (x) => SOURCE_FILE.test(x) })) scanFile(f, null);
  return { ok: problems.length === 0, problems, summary: `${scanned} files scanned` };
}

if (isMain(import.meta.url)) {
  const { root } = parseArgs(process.argv.slice(2), import.meta.url);
  process.exit(finish('check-boundaries', checkBoundaries(root)));
}
