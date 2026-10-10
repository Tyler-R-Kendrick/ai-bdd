#!/usr/bin/env node
// @ts-nocheck
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
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { finish, isMain, listPackages, parseArgs, readJson, toPosix, walk } from './lib.mjs';

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const OPEN_SDK_MODULES = new Set(['contracts', 'util']);
const DIST = /(^|\/)dist(\/|$)/;

// Files that legitimately load a module chosen at run time. Each one imports the USER's packages (config files, driver
// and model packages named in the project's config), never an SDK internal. Literal specifiers in them are still checked.
const DYNAMIC_ALLOWED = new Map([['packages/sdk/src/config/load.ts', "loads the user's config, driver and model packages by resolved file URL"]]);

function scriptKindOf(fileName) {
  if (/\.tsx$/.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const unwrap = (n) => {
  let cur = n;
  while (cur && (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression(cur))) cur = cur.expression;
  return cur;
};

/** `const name = <foldable string>` declarations of a file; a name declared more than once is ambiguous and dropped. */
function collectConstants(sf) {
  const decls = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const isConst = (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0;
      const list = decls.get(node.name.text) ?? [];
      list.push(isConst && node.initializer ? node.initializer : null);
      decls.set(node.name.text, list);
    } else if ((ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) {
      const list = decls.get(node.name.text) ?? [];
      list.push(null);
      decls.set(node.name.text, list);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return decls;
}

/** Folds an expression to the string it always evaluates to (literals, `+`, templates, vetted consts), else null. */
function makeFolder(sf) {
  const decls = collectConstants(sf);
  const fold = (node, depth = 0) => {
    if (!node || depth > 12) return null;
    const n = unwrap(node);
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n)) {
      let out = n.head.text;
      for (const span of n.templateSpans) {
        const v = fold(span.expression, depth + 1);
        if (v === null) return null;
        out += v + span.literal.text;
      }
      return out;
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a = fold(n.left, depth + 1);
      const b = a === null ? null : fold(n.right, depth + 1);
      return a === null || b === null ? null : a + b;
    }
    if (ts.isIdentifier(n)) {
      const list = decls.get(n.text);
      return list && list.length === 1 && list[0] ? fold(list[0], depth + 1) : null;
    }
    return null;
  };
  return fold;
}

/**
 * Extracts every module reference of a TS/JS source on the TypeScript AST: import / export declarations, `import x =
 * require()`, `import()` expressions and types, `require()`, `createRequire()` and `import.meta.resolve()`. `spec` is the
 * statically known specifier (literals, concatenations, templates and vetted consts are folded; escapes are decoded) or
 * null when it cannot be determined.
 */
export function extractImports(source, fileName = 'source.ts') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
  const fold = makeFolder(sf);
  const found = [];
  const add = (node, exprNode, kind, typeOnly) => {
    found.push({
      spec: exprNode ? fold(exprNode) : null,
      expr: exprNode ? exprNode.getText(sf) : '',
      kind,
      typeOnly,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      add(node, node.moduleSpecifier, 'static', node.importClause?.isTypeOnly === true);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node, node.moduleSpecifier, 'static', node.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression, 'require', node.isTypeOnly);
    } else if (ts.isImportTypeNode(node)) {
      const arg = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument;
      add(node, arg, 'static', true);
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const arg = node.arguments[0];
      if (callee.kind === ts.SyntaxKind.ImportKeyword) add(node, arg, 'dynamic', false);
      else if (ts.isIdentifier(callee) && callee.text === 'require') add(node, arg, 'require', false);
      else if (ts.isIdentifier(callee) && callee.text === 'createRequire') add(node, undefined, 'createRequire', false);
      else if (ts.isCallExpression(callee) && ts.isIdentifier(unwrap(callee.expression)) && unwrap(callee.expression).text === 'createRequire') add(node, arg, 'require', false);
      else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve' && ts.isMetaProperty(callee.expression) && callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword) add(node, arg, 'resolve', false);
      else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'require' && ts.isIdentifier(callee.expression) && callee.expression.text === 'module') add(node, arg, 'require', false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found.sort((a, b) => a.line - b.line);
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
    const imports = extractImports(fs.readFileSync(abs, 'utf8'), abs);
    scanned++;
    for (const imp of imports) {
      const spec = imp.spec;
      const where = spec === null ? `${rel}:${imp.line} ${imp.kind} ${imp.expr}` : `${rel}:${imp.line} import '${spec}'`;
      if (spec === null) {
        // The specifier is computed: it cannot be vetted. Test files may do so; sources must use a static string.
        if (test || !pkg || DYNAMIC_ALLOWED.has(rel)) continue;
        problems.push(imp.kind === 'createRequire' ? `${where}: createRequire() can reach any module; load it with a static import()` : `${where}: the specifier is not a static string and cannot be checked (R-SDK2)`);
        continue;
      }
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
      let resolved;
      if (spec.startsWith('file:')) {
        try {
          resolved = fileURLToPath(spec);
        } catch {
          problems.push(`${where}: malformed file: URL`);
          continue;
        }
      } else if (path.isAbsolute(spec)) {
        resolved = spec;
      } else if (spec.startsWith('.')) {
        resolved = path.resolve(path.dirname(abs), spec);
      } else {
        continue; // node builtins and third-party packages
      }
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
