import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import Ajv from 'ajv';
import type { CodeProject } from '../shared/code-project.ts';
import { applyCodeEditProposal, codeEditProposalSchemaFor } from '../shared/code-edit.ts';

const project = (): CodeProject => ({ files: { 'src/page.html': '<p>Before</p>\n', 'notes.txt': 'Exact saved bytes.\r\n' }, entry: 'src/page.html' });
const proposal = (change: unknown) => ({ summary: 'A requested change.', changes: [change] });

describe('source-bound code edit output schema', () => {
  it('freezes existing-file choices and rejects foreign or absolute replace/delete paths without normalization', () => {
    const original = project();
    const schema = codeEditProposalSchemaFor(original);
    original.files = { ...original.files, 'later.txt': 'Not in the saved snapshot' };
    for (const op of ['replace', 'delete']) {
      for (const path of ['foreign.html', '/src/page.html', 'later.txt'])
        expect(schema.safeParse(proposal({ op, path, ...(op === 'replace' ? { find: 'Before', replacement: 'After' } : {}) })).success).toBe(false);
      expect(schema.safeParse(proposal({ op, path: 'src/page.html', ...(op === 'replace' ? { find: 'Before', replacement: 'After' } : {}) })).success).toBe(true);
    }
  });

  it('enforces explicit relative syntax in JSON Schema while retaining independent original-path and reserved-name validation', () => {
    const original = project(), schema = codeEditProposalSchemaFor(original);
    // SDK/JSON Schema sees the relative pattern. Zod/helper checks also reject
    // reserved/traversal names and existing create paths; native decoding does
    // not promise to enforce string patterns or those custom refinements.
    const json = z.toJSONSchema(schema, { target: 'draft-7' });
    const validate = new Ajv({ strict: false }).compile(json);
    for (const path of ['/tmp/new.js', 'src\\new.js', 'src//new.js', 'src/new.js/']) {
      const value = proposal({ op: 'create', path, content: '' });
      expect(validate(value)).toBe(false);
      expect(schema.safeParse(value).success).toBe(false);
    }
    for (const path of ['notes.txt', '../new.js', '.git/config', 'node_modules/new.js', '__proto__'])
      expect(schema.safeParse(proposal({ op: 'create', path, content: '' })).success).toBe(false);
    expect(schema.safeParse(proposal({ op: 'create', path: 'src/new.js', content: 'export default 1;' })).success).toBe(true);
  });

  it('retains byte-preserving literal reconstruction and newly created entry files', () => {
    const original = project();
    const value = {
      summary: 'A requested edit.',
      changes: [
        { op: 'replace', path: 'src/page.html', find: 'Before', replacement: 'After' },
        { op: 'create', path: 'new.js', content: 'export default 1;\n' },
      ],
      entry: 'new.js',
    };
    const parsed = codeEditProposalSchemaFor(original).parse(value);
    expect(applyCodeEditProposal(original, parsed).content).toEqual({
      files: { 'src/page.html': '<p>After</p>\n', 'notes.txt': 'Exact saved bytes.\r\n', 'new.js': 'export default 1;\n' }, entry: 'new.js',
    });
    expect(original).toEqual(project());
  });

  it('validates the trusted source before creating enums', () => {
    expect(() => codeEditProposalSchemaFor({ files: {}, entry: 'missing.html' })).toThrow();
    expect(() => codeEditProposalSchemaFor({ files: { '/host/file.html': '' }, entry: '/host/file.html' })).toThrow();
  });
});
