import { join, sep } from 'node:path';
import { readdirSync } from 'node:fs';
import type { ResolvedConfig } from '@ai-bdd/contracts';
import { globToRegExp } from './glob.js';

/** Expands `config.bindings` globs against the project root. */
export function expandBindingGlobs(config: ResolvedConfig): string[] {
  const root = config.projectRoot;
  const out: string[] = [];
  const patterns = config.bindings.map((pattern) => globToRegExp(pattern));
  const walk = (dir: string): void => {
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = Array.from(readdirSync(dir, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.isDirectory(),
      }));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const relative = full.slice(root.length + 1).split(sep).join('/');
      if (patterns.some((regexp) => regexp.test(relative))) out.push(full);
    }
  };
  walk(root);
  return out;
}
