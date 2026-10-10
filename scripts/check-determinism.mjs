#!/usr/bin/env node
// Compiles the testing corpus with the fake model twice and byte-compares the resulting plans:
//   1. compile into a fresh copy of the corpus, snapshot `.ai-bdd/plans`;
//   2. compile again in the same copy (incremental), the snapshot must not change;
//   3. compile into a second fresh copy, the snapshot must equal the first.
// Prints `PLAN-DIGEST sha256:<hex>` so CI can compare the digest across operating systems.
// When the CLI is not functional yet, prints `SKIP: cli not ready` and exits 0 only if CHECK_ALLOW_SKIP=1.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMain, parseArgs, toPosix, walk } from './lib.mjs';

const PLANS = path.join('.ai-bdd', 'plans');

/** Reads every file below `dir` into a Map keyed by posix relative path. */
export function snapshot(dir) {
  const map = new Map();
  for (const f of walk(dir, { skipDirs: new Set() })) map.set(toPosix(path.relative(dir, f)), fs.readFileSync(f));
  return map;
}

export function diffSnapshots(a, b) {
  const diffs = [];
  for (const k of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (!a.has(k)) diffs.push(`${k}: only in second snapshot`);
    else if (!b.has(k)) diffs.push(`${k}: only in first snapshot`);
    else if (!a.get(k).equals(b.get(k))) diffs.push(`${k}: bytes differ`);
  }
  return diffs;
}

export function digestOf(snap) {
  const h = crypto.createHash('sha256');
  for (const k of [...snap.keys()].sort()) {
    h.update(k).update('\0').update(snap.get(k)).update('\0');
  }
  return h.digest('hex');
}

function compileOnce(root, cwd, timeoutMs) {
  const bin = path.join(root, 'packages', 'cli', 'src', 'bin.ts');
  const env = { ...process.env, AI_BDD_FAKE: '1', NO_COLOR: '1' };
  delete env.CI;
  delete env.AI_BDD_RECORDINGS;
  const r = spawnSync(process.execPath, ['--conditions=source', bin, 'compile'], { cwd, env, encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error };
}

export function checkDeterminism(root, { allowSkip = false, timeoutMs = 120_000 } = {}) {
  const skip = (reason) => ({
    ok: allowSkip,
    skipped: reason,
    problems: allowSkip ? [] : [`${reason} (set CHECK_ALLOW_SKIP=1 to tolerate during development)`],
  });
  const corpus = path.join(root, 'packages', 'testing', 'corpus');
  const bin = path.join(root, 'packages', 'cli', 'src', 'bin.ts');
  if (!fs.existsSync(corpus)) return skip('corpus not ready');
  if (!fs.existsSync(bin)) return skip('cli not ready');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-bdd-determinism-'));
  try {
    const dirs = ['a', 'b'].map((n) => path.join(tmp, n));
    for (const d of dirs) fs.cpSync(corpus, d, { recursive: true, filter: (src) => path.basename(src) !== 'node_modules' });
    const fail = (msg) => ({ ok: false, problems: [msg] });

    const first = compileOnce(root, dirs[0], timeoutMs);
    if (first.status !== 0) {
      if (/NOT_IMPLEMENTED/.test(first.output)) return skip('cli not ready');
      return fail(`compile failed (exit ${first.status ?? first.error?.message}): ${first.output.trim().slice(-800)}`);
    }
    const snap1 = snapshot(path.join(dirs[0], PLANS));
    if (snap1.size === 0) return fail(`compile produced no files under ${toPosix(PLANS)}`);

    const second = compileOnce(root, dirs[0], timeoutMs);
    if (second.status !== 0) return fail(`second compile failed (exit ${second.status}): ${second.output.trim().slice(-800)}`);
    const snap2 = snapshot(path.join(dirs[0], PLANS));

    const fresh = compileOnce(root, dirs[1], timeoutMs);
    if (fresh.status !== 0) return fail(`compile in a fresh copy failed (exit ${fresh.status}): ${fresh.output.trim().slice(-800)}`);
    const snap3 = snapshot(path.join(dirs[1], PLANS));

    const problems = [
      ...diffSnapshots(snap1, snap2).map((d) => `incremental recompile: ${d}`),
      ...diffSnapshots(snap1, snap3).map((d) => `fresh copy: ${d}`),
    ];
    return { ok: problems.length === 0, problems, digest: digestOf(snap1), summary: `${snap1.size} plan files identical` };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const { root, rest } = parseArgs(process.argv.slice(2), import.meta.url);
  const allowSkip = process.env.CHECK_ALLOW_SKIP === '1';
  const result = checkDeterminism(root, { allowSkip });
  if (result.skipped) {
    console.log(`SKIP: ${result.skipped}`);
    for (const p of result.problems) console.error(`  - ${p}`);
    process.exit(result.ok ? 0 : 1);
  }
  if (!result.ok) {
    console.error('check-determinism: FAILED');
    for (const p of result.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`check-determinism: ok (${result.summary})`);
  console.log(`PLAN-DIGEST sha256:${result.digest}`);
  if (rest[0]) fs.writeFileSync(rest[0], `${result.digest}\n`);
}
