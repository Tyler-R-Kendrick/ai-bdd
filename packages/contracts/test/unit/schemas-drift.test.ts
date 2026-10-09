import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateSchemas, renderErrorsDoc } from '../../src/schemas-gen.js';
import { TOOL_DEFINITIONS } from '../../src/tools-table.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = join(here, '..', '..', 'schemas');
const docsDir = join(here, '..', '..', '..', '..', 'docs');

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

describe('checked-in schemas are in sync (WP-A1 acceptance)', () => {
  it('regenerating produces no diff', () => {
    const before = walk(schemasDir).map((file) => [file, readFileSync(join(schemasDir, file), 'utf8')] as const);
    expect(before.length).toBeGreaterThan(20);
    generateSchemas();
    const after = walk(schemasDir).map((file) => [file, readFileSync(join(schemasDir, file), 'utf8')] as const);
    expect(after).toEqual(before);
  });

  it('documents every error code', () => {
    const doc = readFileSync(join(docsDir, 'errors.md'), 'utf8');
    expect(doc).toBe(renderErrorsDoc());
  });

  it('generates one input and output schema per tool', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const input = JSON.parse(readFileSync(join(schemasDir, 'tools', `${tool.short}.input.schema.json`), 'utf8'));
      expect(input.$schema).toContain('2020-12');
      expect(tool.name).toMatch(/^aibdd_[a-z0-9_]+$/u);
      expect(tool.path).toBe(`/v1/${tool.short}`);
    }
  });

  it('keeps tool names portable across clients (F-M2)', () => {
    const names = JSON.parse(readFileSync(join(schemasDir, 'tool-names.json'), 'utf8')).names as string[];
    expect(names).toEqual(TOOL_DEFINITIONS.map((tool) => tool.name));
  });
});
