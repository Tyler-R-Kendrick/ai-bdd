#!/usr/bin/env node
// Keeps the documentation honest (definition of done, item 10).
//   1. Every ```ts block tagged `ts check` is typechecked (tsc --noEmit, repository tsconfig.base.json settings,
//      `@ai-bdd/*` resolved to the workspace sources through the `source` condition).
//   2. Every ```sh block tagged `sh run` is executed with `bash -e -o pipefail` in a sandbox. Blocks of one file run in
//      document order and share the sandbox; every file gets a fresh sandbox.
//   3. Every relative link (and `#anchor` of a Markdown target) in the documentation resolves.
//
// Block tags (the info string after the language):
//   ```ts check                    a standalone module, typechecked with strict settings
//   ```sh run                      runs from the sandbox repository root (a mirror of this repository, see below)
//   ```sh run in=project           runs in a fresh copy of packages/testing/corpus with AI_BDD_FAKE=1,
//                                  AI_BDD_FAKE_RULES set, and an `ai-bdd` shim on PATH (blocks without `in=` get no shim)
//   ```sh run exit=N               expects exit status N instead of 0
//
// Sandbox: a temp directory (OS temp dir) that mirrors the repository layout: `node_modules` and every package except
// `packages/testing` are symlinks to the real ones, `packages/testing/corpus` is a real copy. Documented commands such
// as `cp -r packages/testing/corpus packages/testing/.quickstart` therefore run verbatim and never touch the work tree.
//
// Usage: node scripts/check-docs.mjs [--root <dir>] [--no-ts] [--no-run] [--no-links] [relative/file.md ...]
// Positional arguments restrict the check to those files.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMain, parseArgs, toPosix } from './lib.mjs';

const EXCLUDED_DOCS = new Set(['errors.md', 'verification-log.md', 'adversarial-findings.md']);
const RUN_TIMEOUT_MS = 240_000;
const TSC_TIMEOUT_MS = 180_000;

/** Fenced code blocks of a Markdown text: `{ lang, tags, code, line }` (line is the 1-based line of the opening fence). */
export function extractBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,}|~{3,})\s*(.*)$/.exec(lines[i]);
    if (!open) continue;
    const [, indent, fence, info] = open;
    if (fence.startsWith('`') && info.includes('`')) continue; // inline code that merely starts a line
    const tokens = info.trim().split(/\s+/).filter(Boolean);
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[j]);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) break;
      body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j].trimStart());
    }
    blocks.push({ lang: tokens[0] ?? '', tags: tokens.slice(1), code: body.join('\n'), line: i + 1 });
    i = j;
  }
  return blocks;
}

/** Interprets block tags. Returns `{ kind: 'ts-check' | 'sh-run' | null, in?, exit?, problem? }`. */
export function classifyBlock(block) {
  const { lang, tags } = block;
  const hasTag = tags.includes('check') || tags.includes('run');
  if (lang === 'ts' && tags.includes('check')) {
    const extra = tags.filter((t) => t !== 'check');
    return extra.length > 0 ? { kind: null, problem: `unknown tag(s) on ts check block: ${extra.join(' ')}` } : { kind: 'ts-check' };
  }
  if (lang === 'sh' && tags.includes('run')) {
    const out = { kind: 'sh-run', in: 'root', exit: 0 };
    for (const t of tags) {
      if (t === 'run') continue;
      let m;
      if (t === 'in=project') out.in = 'project';
      else if ((m = /^exit=(\d{1,3})$/.exec(t))) out.exit = Number(m[1]);
      else return { kind: null, problem: `unknown tag on sh run block: ${t}` };
    }
    return out;
  }
  if (hasTag) return { kind: null, problem: `tag "${tags.join(' ')}" is only valid on "ts check" and "sh run" blocks (language is "${lang}")` };
  return { kind: null };
}

/** GitHub-style heading slug. */
export function slugOf(heading) {
  const text = heading
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]+/g, (m) => (m.includes('_') ? m : ''))
    .toLowerCase();
  return text
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/** All heading anchors of a Markdown text (with GitHub's `-1`, `-2` suffixes for duplicates). */
export function anchorsOf(markdown) {
  const seen = new Map();
  const anchors = new Set();
  let fence = null;
  for (const line of markdown.split(/\r?\n/)) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const base = slugOf(h[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

/** Link targets outside code: `[text](target)`, images and `[ref]: target` definitions. */
export function extractLinks(markdown) {
  const links = [];
  let fence = null;
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const f = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const text = lines[i].replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
    const re = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
    let m;
    while ((m = re.exec(text))) links.push({ target: m[1], line: i + 1 });
    const def = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/.exec(text);
    if (def) links.push({ target: def[1], line: i + 1 });
  }
  return links;
}

/** Documentation files to scan: README.md and docs/*.md (generated and foreign-owned files excluded). */
export function docFiles(root) {
  const files = [];
  if (fs.existsSync(path.join(root, 'README.md'))) files.push('README.md');
  const docs = path.join(root, 'docs');
  if (fs.existsSync(docs)) {
    for (const name of fs.readdirSync(docs).sort()) {
      if (name.endsWith('.md') && !EXCLUDED_DOCS.has(name) && fs.statSync(path.join(docs, name)).isFile()) files.push(`docs/${name}`);
    }
  }
  return files;
}

export function checkLinks(root, files) {
  const problems = [];
  const anchorCache = new Map();
  const anchors = (abs) => {
    if (!anchorCache.has(abs)) anchorCache.set(abs, anchorsOf(fs.readFileSync(abs, 'utf8')));
    return anchorCache.get(abs);
  };
  for (const rel of files) {
    const abs = path.join(root, rel);
    for (const { target, line } of extractLinks(fs.readFileSync(abs, 'utf8'))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue; // external
      const [rawPath, rawHash] = splitHash(target);
      let decoded;
      try {
        decoded = decodeURIComponent(rawPath);
      } catch {
        problems.push(`${rel}:${line}: malformed link ${target}`);
        continue;
      }
      const dest = decoded === '' ? abs : path.resolve(path.dirname(abs), decoded);
      if (!toPosix(dest).startsWith(`${toPosix(root)}/`) && dest !== root) {
        problems.push(`${rel}:${line}: link leaves the repository: ${target}`);
        continue;
      }
      if (!fs.existsSync(dest)) {
        problems.push(`${rel}:${line}: broken link ${target}`);
        continue;
      }
      if (rawHash !== '' && fs.statSync(dest).isFile() && dest.endsWith('.md') && !anchors(dest).has(rawHash.toLowerCase())) {
        problems.push(`${rel}:${line}: no heading for anchor #${rawHash} in ${toPosix(path.relative(root, dest))}`);
      }
    }
  }
  return problems;
}

function splitHash(target) {
  const i = target.indexOf('#');
  return i === -1 ? [target, ''] : [target.slice(0, i), target.slice(i + 1)];
}

// ───────────────────────── sandbox

/** Env for spawned processes: the outer CI / AI_BDD_* / ACME_* variables must not leak into documented commands. */
function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === 'CI' || k.startsWith('AI_BDD_') || k.startsWith('ACME_')) continue;
    env[k] = v;
  }
  return { ...env, NO_COLOR: '1', NODE_NO_WARNINGS: '1', ...extra };
}

function symlink(target, link) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, 'dir');
}

/** Builds `<tmp>/repo` (a mirror of the repository) and `<tmp>/bin/ai-bdd`. */
export function createSandbox(root, tmp) {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const nm = path.join(root, 'node_modules');
  if (fs.existsSync(nm)) symlink(nm, path.join(repo, 'node_modules'));
  for (const f of ['package.json', 'tsconfig.base.json']) {
    if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(repo, f));
  }
  const pkgs = path.join(root, 'packages');
  if (fs.existsSync(pkgs)) {
    for (const name of fs.readdirSync(pkgs)) {
      if (name === 'testing' || name === 'node_modules' || name.startsWith('.')) continue;
      if (fs.statSync(path.join(pkgs, name)).isDirectory()) symlink(path.join(pkgs, name), path.join(repo, 'packages', name));
    }
  }
  const corpus = path.join(pkgs, 'testing', 'corpus');
  if (fs.existsSync(corpus)) {
    fs.cpSync(corpus, path.join(repo, 'packages', 'testing', 'corpus'), { recursive: true, filter: (src) => path.basename(src) !== 'node_modules' });
  }
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const cli = path.join(root, 'packages', 'cli', 'src', 'bin.ts');
  const shim = path.join(bin, 'ai-bdd');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" --conditions=source "${cli}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return { repo, bin };
}

function tail(text, n = 2000) {
  const t = text.trim();
  return t.length > n ? `...${t.slice(-n)}` : t;
}

function runShellBlocks(root, rel, blocks, log) {
  const problems = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-bdd-docs-'));
  try {
    const { repo, bin } = createSandbox(root, tmp);
    let projectReady = false;
    const projectDir = path.join(repo, 'packages', 'testing', '.docs-project');
    for (const b of blocks) {
      let cwd = repo;
      const extra = {};
      if (b.in === 'project') {
        if (!projectReady) {
          fs.cpSync(path.join(repo, 'packages', 'testing', 'corpus'), projectDir, { recursive: true });
          projectReady = true;
        }
        cwd = projectDir;
        Object.assign(extra, { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, AI_BDD_FAKE: '1', AI_BDD_FAKE_RULES: path.join(projectDir, 'fake-model'), ACME_ADMIN_PASSWORD: 'correct-horse-battery' });
      }
      log(`  run ${rel}:${b.line} (${b.in})`);
      const r = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', b.code], { cwd, env: cleanEnv(extra), encoding: 'utf8', timeout: RUN_TIMEOUT_MS });
      const status = r.status ?? (r.error ? `error: ${r.error.message}` : `signal ${r.signal}`);
      if (status !== b.exit) {
        problems.push(`${rel}:${b.line}: sh run block exited ${status}, expected ${b.exit}\n${indent(tail(`${r.stdout ?? ''}${r.stderr ?? ''}`))}`);
        break; // later blocks of the file depend on this one
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return problems;
}

function indent(text) {
  return text
    .split('\n')
    .map((l) => `    | ${l}`)
    .join('\n');
}

// ───────────────────────── typecheck

function checkTypeScript(root, entries, log) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-bdd-docs-ts-'));
  try {
    const { repo } = createSandbox(root, tmp);
    const dir = path.join(repo, 'docs-ts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n'); // blocks are ES modules whatever the root says
    const origin = new Map();
    entries.forEach((e, i) => {
      const name = `block-${String(i + 1).padStart(3, '0')}.ts`;
      origin.set(name, `${e.file}:${e.line}`);
      // `export {}` keeps blocks without imports from sharing one global scope.
      const code = /^\s*(import|export)\b/m.test(e.code) ? e.code : `${e.code}\nexport {};`;
      fs.writeFileSync(path.join(dir, name), `${code}\n`);
    });
    const pwTest = path.join(root, 'packages', 'playwright-test', 'node_modules', '@playwright', 'test');
    const tsconfig = {
      extends: '../tsconfig.base.json',
      compilerOptions: {
        noEmit: true,
        declaration: false,
        sourceMap: false,
        ...(fs.existsSync(pwTest) ? { paths: { '@playwright/test': [path.join(pwTest, 'index.d.ts')] } } : {}),
      },
      include: ['./*.ts'],
    };
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
    const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!fs.existsSync(tsc)) return ['typescript is not installed (node_modules/typescript); run pnpm install'];
    log(`  tsc ${entries.length} block(s)`);
    const r = spawnSync(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json'), '--pretty', 'false'], { cwd: repo, env: cleanEnv({}), encoding: 'utf8', timeout: TSC_TIMEOUT_MS });
    if (r.status === 0) return [];
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const problems = [];
    for (const line of out.split('\n')) {
      const m = /^(?:.*[\\/])?(block-\d+\.ts)\((\d+),(\d+)\): (.*)$/.exec(line.trim());
      if (m) {
        const [, name, ln, , msg] = m;
        const [file, fenceLine] = (origin.get(name) ?? name).split(':');
        problems.push(`${file}:${Number(fenceLine) + Number(ln)}: ${msg}`);
      } else if (line.trim() !== '') {
        problems.push(line.trim());
      }
    }
    return problems.length > 0 ? problems : [`tsc failed: ${tail(out)}`];
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ───────────────────────── main

export function checkDocs(root, { ts = true, run = true, links = true, only = [], log = () => {} } = {}) {
  const problems = [];
  const stats = { files: 0, tsBlocks: 0, shBlocks: 0, links: 0 };
  let files = docFiles(root);
  if (only.length > 0) files = files.filter((f) => only.includes(f));
  stats.files = files.length;

  const tsEntries = [];
  const shByFile = new Map();
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const block of extractBlocks(text)) {
      const c = classifyBlock(block);
      if (c.problem) problems.push(`${rel}:${block.line}: ${c.problem}`);
      else if (c.kind === 'ts-check') tsEntries.push({ file: rel, line: block.line, code: block.code });
      else if (c.kind === 'sh-run') {
        if (!shByFile.has(rel)) shByFile.set(rel, []);
        shByFile.get(rel).push({ line: block.line, code: block.code, in: c.in, exit: c.exit });
      }
    }
    if (links) stats.links += extractLinks(text).length;
  }
  stats.tsBlocks = tsEntries.length;
  stats.shBlocks = [...shByFile.values()].reduce((n, b) => n + b.length, 0);

  if (links) problems.push(...checkLinks(root, files));
  if (ts && tsEntries.length > 0) problems.push(...checkTypeScript(root, tsEntries, log));
  if (run) {
    const cli = path.join(root, 'packages', 'cli', 'src', 'bin.ts');
    if (shByFile.size > 0 && !fs.existsSync(cli)) problems.push('packages/cli/src/bin.ts is missing; cannot run sh blocks');
    else for (const [rel, blocks] of shByFile) problems.push(...runShellBlocks(root, rel, blocks, log));
  }
  return { ok: problems.length === 0, problems, stats };
}

if (isMain(import.meta.url)) {
  const { root, flags, rest } = parseArgs(process.argv.slice(2), import.meta.url);
  const result = checkDocs(root, { ts: !flags.has('--no-ts'), run: !flags.has('--no-run'), links: !flags.has('--no-links'), only: rest, log: (m) => console.log(m) });
  const { stats } = result;
  const summary = `${stats.files} file(s), ${stats.tsBlocks} ts block(s), ${stats.shBlocks} sh block(s), ${stats.links} link(s)`;
  if (!result.ok) {
    console.error(`check-docs: FAILED (${summary})`);
    for (const p of result.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`check-docs: ok (${summary})`);
}
