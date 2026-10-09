import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const SPEC_SUFFIXES = ['*.spec.md', '*.spec', '*.feature'];

/** Expands spec globs (directory arguments included) to absolute file paths. */
export function normalizeSpecGlobs(projectRoot: string, patterns: string[]): string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    if (/[*?{]/u.test(pattern)) {
      out.push(...expand(projectRoot, pattern));
      continue;
    }
    const absolute = pattern.startsWith('/') ? pattern : join(projectRoot, pattern);
    if (existsSync(absolute) && statSync(absolute).isDirectory()) {
      const relative = absolute.startsWith(projectRoot) ? absolute.slice(projectRoot.length + 1) : pattern;
      for (const suffix of SPEC_SUFFIXES) out.push(...expand(projectRoot, `${relative}/**/${suffix}`));
      continue;
    }
    out.push(absolute);
  }
  return [...new Set(out)].sort();
}

function expand(projectRoot: string, pattern: string): string[] {
  const regexp = globToRegExp(pattern);
  const matches: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (regexp.test(full.slice(projectRoot.length + 1).split(sep).join('/'))) matches.push(full);
    }
  };
  walk(projectRoot);
  return matches;
}

function globToRegExp(pattern: string): RegExp {
  const variants: string[] = [];
  const brace = /\{([^{}]*)\}/u.exec(pattern);
  if (brace) for (const option of (brace[1] ?? '').split(',')) variants.push(...[pattern.replace(brace[0], option)]);
  else variants.push(pattern);
  const parts = variants.map((variant) => {
    let out = '';
    for (let index = 0; index < variant.length; index += 1) {
      const char = variant[index]!;
      if (char === '*') {
        if (variant[index + 1] === '*') {
          const slash = variant[index + 2] === '/';
          out += slash ? '(?:.*/)?' : '.*';
          index += slash ? 2 : 1;
          continue;
        }
        out += '[^/]*';
        continue;
      }
      out += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
    }
    return out;
  });
  return new RegExp(`^(?:${parts.join('|')})$`, 'u');
}
