#!/usr/bin/env node
// @ts-nocheck
// CRAP (Change Risk Anti-Patterns) score per function: complexity^2 * (1 - coverage)^3 + complexity.
//   complexity: cyclomatic complexity from the TypeScript AST (1 + branch points; nested functions are scored on their own),
//   coverage:   share of the function's own statements executed, from coverage/coverage-final.json (`pnpm coverage`).
// A fully covered function scores its complexity; an untested one scores complexity^2 + complexity.
//
//   node scripts/crap.mjs                    print the worst functions
//   node scripts/crap.mjs --check            fail when a function is over the limit and not in scripts/crap-baseline.json,
//                                            or when a baselined function got worse
//   node scripts/crap.mjs --update-baseline  rewrite scripts/crap-baseline.json (reviewable ratchet: it should only shrink)
//
// Plain Node ESM; needs the repository's `typescript` dev dependency.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { isMain, parseArgs } from './lib.mjs';

export const CRAP_LIMIT = 30;
/** Coverage differs by a statement or two between machines (installed browsers, desktop); a function may drift by this much. */
export const TOLERANCE = 1;

const BRANCH_OPERATORS = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken]);

function isFunctionLike(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

function nameOf(node, sf) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (node.name) return node.name.getText(sf);
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  const p = node.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && p.name) return p.name.getText(sf);
  if (p && ts.isPropertyDeclaration(p) && p.name) return p.name.getText(sf);
  return '(anonymous)';
}

/** Cyclomatic complexity of one function body, not descending into nested functions. */
function complexityOfBody(fn) {
  let c = 1;
  const visit = (node) => {
    if (node !== fn && isFunctionLike(node)) return;
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.CaseClause:
        c += 1;
        break;
      case ts.SyntaxKind.BinaryExpression:
        if (BRANCH_OPERATORS.has(node.operatorToken.kind)) c += 1;
        break;
      default:
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return c;
}

/** Every function in a source text: name, position (1-based line, 0-based column as in istanbul) and complexity. */
export function functionsOf(sourceText, fileName = 'file.ts') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const visit = (node) => {
    if (isFunctionLike(node) && node.body) {
      const s = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const e = sf.getLineAndCharacterOfPosition(node.getEnd());
      out.push({
        name: nameOf(node, sf),
        start: { line: s.line + 1, column: s.character },
        end: { line: e.line + 1, column: e.character },
        complexity: complexityOfBody(node),
        // spans of nested functions: their statements belong to them, not to this function
        nested: [],
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // attach nested spans (a function is nested in the smallest enclosing other function)
  for (const inner of out) {
    let parent = null;
    for (const outer of out) {
      if (outer === inner) continue;
      if (before(outer.start, inner.start) && !before(outer.end, inner.end) && (!parent || before(parent.start, outer.start))) parent = outer;
    }
    if (parent) parent.nested.push({ start: inner.start, end: inner.end });
  }
  return out;
}

const before = (a, b) => a.line < b.line || (a.line === b.line && a.column <= b.column);
const within = (p, span) => before(span.start, p) && before(p, span.end);

/** Share of a function's own statements that ran, from an istanbul file entry. A function without statements counts as covered. */
export function coverageOf(entry, fn) {
  if (!entry) return 0;
  let total = 0;
  let hit = 0;
  for (const [id, loc] of Object.entries(entry.statementMap)) {
    if (!within(loc.start, fn) || fn.nested.some((n) => within(loc.start, n))) continue;
    total += 1;
    if ((entry.s[id] ?? 0) > 0) hit += 1;
  }
  return total === 0 ? 1 : hit / total;
}

export function crap(complexity, coverage) {
  return complexity * complexity * (1 - coverage) ** 3 + complexity;
}

export function listSources(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'dist') walk(p);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  const pk = path.join(root, 'packages');
  for (const pkg of fs.readdirSync(pk)) {
    const src = path.join(pk, pkg, 'src');
    if (fs.existsSync(src)) walk(src);
  }
  return out;
}

/** Score every function under each package's src directory. `final` is coverage-final.json (istanbul). */
export function analyze(root, final) {
  const rows = [];
  for (const file of listSources(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const entry = final[file] ?? final[rel];
    for (const fn of functionsOf(fs.readFileSync(file, 'utf8'), file)) {
      const coverage = coverageOf(entry, fn);
      rows.push({ id: `${rel}#${fn.name}`, file: rel, name: fn.name, line: fn.start.line, complexity: fn.complexity, coverage, crap: crap(fn.complexity, coverage) });
    }
  }
  return rows.sort((a, b) => b.crap - a.crap);
}

/** Disambiguate repeated ids (overloads, several anonymous functions) with their order of appearance. */
export function withUniqueIds(rows) {
  const seen = new Map();
  return rows.map((r) => {
    const n = (seen.get(r.id) ?? 0) + 1;
    seen.set(r.id, n);
    return n === 1 ? r : { ...r, id: `${r.id}~${n}` };
  });
}

/** Offenders: over the limit and not baselined, or baselined but worse than recorded. */
export function violations(rows, baseline, limit = CRAP_LIMIT) {
  const out = [];
  for (const r of rows) {
    const allowed = baseline[r.id];
    if (r.crap <= limit) continue;
    if (allowed === undefined) out.push({ ...r, reason: `CRAP ${r.crap.toFixed(1)} is over ${limit}` });
    else if (r.crap > allowed + TOLERANCE) out.push({ ...r, reason: `CRAP ${r.crap.toFixed(1)} got worse than its baseline ${allowed.toFixed(1)}` });
  }
  return out;
}

export function renderRows(rows, n = 20) {
  const head = 'crap    cc  cov%  function';
  return [head, ...rows.slice(0, n).map((r) => `${r.crap.toFixed(1).padStart(6)}  ${String(r.complexity).padStart(3)}  ${(100 * r.coverage).toFixed(0).padStart(3)}  ${r.id} (line ${r.line})`)].join('\n');
}

export function main(argv, { log = console } = {}) {
  const { root, flags, rest } = parseArgs(argv, import.meta.url);
  const finalFile = path.resolve(root, rest[0] ?? 'coverage/coverage-final.json');
  if (!fs.existsSync(finalFile)) {
    log.error(`crap: ${finalFile} not found (run "pnpm coverage" first)`);
    return 2;
  }
  const rows = withUniqueIds(analyze(root, JSON.parse(fs.readFileSync(finalFile, 'utf8'))));
  const baselineFile = path.join(root, 'scripts', 'crap-baseline.json');
  if (flags.has('--update-baseline')) {
    const next = Object.fromEntries(rows.filter((r) => r.crap > CRAP_LIMIT).map((r) => [r.id, Math.round(r.crap * 10) / 10]));
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, `${JSON.stringify(next, null, 2)}\n`);
    log.log(`crap: baseline written with ${Object.keys(next).length} function(s) over ${CRAP_LIMIT}`);
    return 0;
  }
  log.log(renderRows(rows));
  const over = rows.filter((r) => r.crap > CRAP_LIMIT).length;
  log.log(`\n${rows.length} functions, ${over} over CRAP ${CRAP_LIMIT}`);
  if (!flags.has('--check')) return 0;
  const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : {};
  const bad = violations(rows, baseline);
  for (const v of bad) log.error(`crap: ${v.id} (line ${v.line}): ${v.reason} (complexity ${v.complexity}, coverage ${(100 * v.coverage).toFixed(0)}%)`);
  const stale = Object.keys(baseline).filter((id) => !rows.some((r) => r.id === id && r.crap > CRAP_LIMIT));
  for (const id of stale) log.log(`crap: ${id} is no longer over the limit; remove it from the baseline (--update-baseline)`);
  return bad.length === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
