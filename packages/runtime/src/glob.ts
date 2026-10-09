import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Translates a glob (supporting `**`, `*`, `?` and `{a,b}`) into a RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const expanded = expandBraces(pattern);
  const parts = expanded.map((variant) => {
    let out = '';
    for (let index = 0; index < variant.length; index += 1) {
      const char = variant[index]!;
      if (char === '*') {
        if (variant[index + 1] === '*') {
          const slashAfter = variant[index + 2] === '/';
          out += slashAfter ? '(?:.*/)?' : '.*';
          index += slashAfter ? 2 : 1;
          continue;
        }
        out += '[^/]*';
        continue;
      }
      if (char === '?') {
        out += '[^/]';
        continue;
      }
      out += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
    }
    return out;
  });
  return new RegExp(`^(?:${parts.join('|')})$`, 'u');
}

function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/u.exec(pattern);
  if (!match) return [pattern];
  const [whole, body] = match;
  const variants: string[] = [];
  for (const option of (body ?? '').split(',')) {
    variants.push(...expandBraces(pattern.replace(whole, option)));
  }
  return variants;
}

/** Walks a directory tree, returning POSIX-style paths relative to `base`. */
export function walkFiles(base: string, options: { ignore?: string[] } = {}): string[] {
  const ignore = new Set(options.ignore ?? ['node_modules', '.git', 'dist']);
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ignore.has(entry)) continue;
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) visit(full);
      else out.push(relative(base, full).split(sep).join('/'));
    }
  };
  visit(base);
  return out.sort();
}

/** Expands globs against a project root, returning absolute paths. */
export function expandGlobs(projectRoot: string, patterns: string[]): string[] {
  const files = walkFiles(projectRoot);
  const regexps = patterns.map((pattern) => globToRegExp(pattern));
  const matches = files.filter((file) => regexps.some((regexp) => regexp.test(file)));
  return matches.map((file) => join(projectRoot, file));
}
