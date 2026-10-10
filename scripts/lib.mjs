// Shared helpers for the repository check scripts. Plain Node ESM, no third-party dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.ai-bdd', 'test-results', 'playwright-report']);

/** Repository root derived from a script's `import.meta.url` (scripts live in `<root>/scripts`). */
export function defaultRoot(metaUrl) {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), '..');
}

/** Parses `--root <dir>` / `--root=<dir>` and returns `{ root, flags, rest }`. */
export function parseArgs(argv, metaUrl) {
  let root = defaultRoot(metaUrl);
  const flags = new Set();
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') root = path.resolve(argv[++i] ?? '');
    else if (a.startsWith('--root=')) root = path.resolve(a.slice('--root='.length));
    else if (a.startsWith('--')) flags.add(a);
    else rest.push(a);
  }
  return { root, flags, rest };
}

/** True when the module is the process entry point. */
export function isMain(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(fs.realpathSync(entry)).href === metaUrl;
  } catch {
    return false;
  }
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** Recursively lists files (absolute paths, sorted) below `dir`; returns [] when `dir` is missing. */
export function walk(dir, { skipDirs = DEFAULT_SKIP_DIRS, filter = () => true } = {}) {
  const out = [];
  const visit = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) visit(full);
      } else if (e.isFile() && filter(full)) {
        out.push(full);
      }
    }
  };
  visit(dir);
  return out;
}

/** Lists the package directories under `<root>/packages`. */
export function listPackages(root) {
  const base = path.join(root, 'packages');
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== 'node_modules')
    .map((e) => e.name)
    .sort();
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Replaces comments with spaces (newlines kept) so that offsets and line numbers survive.
 * String and template literals are skipped so that `'**\/*.md'` is not mistaken for a comment.
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i++) out += src[i] === '\n' ? '\n' : ' ';
    } else if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < n) {
          out += src[i] + src[i + 1];
          i += 2;
        } else {
          out += src[i++];
        }
      }
      if (i < n && src[i] === c) out += src[i++];
    } else if (c === '`') {
      out += c;
      i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\' && i + 1 < n) {
          out += src[i] + src[i + 1];
          i += 2;
        } else {
          out += src[i++];
        }
      }
      if (i < n) out += src[i++];
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Prints a standard report and returns the exit code. */
export function finish(name, result, log = console) {
  if (result.skipped) {
    log.log(`${name}: SKIP: ${result.skipped}`);
    return result.ok ? 0 : 1;
  }
  if (result.ok) {
    log.log(`${name}: ok${result.summary ? ` (${result.summary})` : ''}`);
    return 0;
  }
  log.error(`${name}: FAILED${result.summary ? ` (${result.summary})` : ''}`);
  for (const p of result.problems) log.error(`  - ${p}`);
  return 1;
}
