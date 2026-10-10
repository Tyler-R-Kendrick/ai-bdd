// Test helper: builds throwaway repository trees under the OS temp dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeRepo(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-bdd-scripts-'));
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  return root;
}

export function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return file;
}

export function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/** A minimal workspace package.json. */
export function pkg(name, deps = {}, peers = {}) {
  return { name: `@ai-bdd/${name}`, version: '0.0.0', dependencies: deps, peerDependencies: peers };
}
