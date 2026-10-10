// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', '.ai-bdd', '.work']);

/** Every `*.received.*` file under `root`. */
export function findReceived(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(p);
      } else if (/\.received\.[^.]+$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out.sort();
}

export const verifiedPathOf = (received: string): string => received.replace(/\.received\.([^.]+)$/, '.verified.$1');

/** Approve received files: each replaces its `.verified.` sibling. Returns the approved verified paths. */
export function acceptReceived(received: readonly string[]): string[] {
  return received.map((r) => {
    const v = verifiedPathOf(r);
    fs.renameSync(r, v);
    return v;
  });
}
