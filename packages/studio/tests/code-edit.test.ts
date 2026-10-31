import { describe, expect, it } from 'vitest';
import { applyCodeEditProposal } from '../shared/code-edit.ts';
import type { CodeProject } from '../shared/code-project.ts';

const base = (): CodeProject => ({ files: { 'page.html': '<button aria-label="Start">Start</button>\n', 'notes.txt': 'Keep every byte.\r\n🌿\n', 'other.js': 'export default 1;\n' }, entry: 'page.html' });
const patch = (changes: unknown[], extra = {}) => ({ summary: 'Requested edit', changes, ...extra });
const replace = (path = 'page.html', find = 'Start', replacement = 'Launch') => ({ op: 'replace', path, find, replacement });

describe('literal artifact code edits', () => {
  it('changes all exact occurrences, preserves every other byte and never mutates frozen input', () => {
    const original = base(); const frozen = structuredClone(original);
    Object.freeze(original.files); Object.freeze(original);
    const result = applyCodeEditProposal(original, patch([replace()]));
    expect(result.content).toEqual({ ...frozen, files: { ...frozen.files, 'page.html': '<button aria-label="Launch">Launch</button>\n' } });
    expect(original).toEqual(frozen); expect(result.content.files).not.toBe(original.files);
  });
  it('treats $, $&, $`, quotes, backslashes and regex metacharacters literally', () => {
    const original = { files: { 'page.html': 'A[$.*]B[$.*]C\n', 'notes.txt': 'unchanged\n' }, entry: 'page.html' };
    const replacement = '$&$`$\'\\"\n';
    expect(applyCodeEditProposal(original, patch([replace('page.html', '[$.*]', replacement)])).content.files['page.html']).toBe('A' + replacement + 'B' + replacement + 'C\n');
  });
  it('supports ordered replacements, literal deletion, creation/deletion and an explicit entry update', () => {
    const original = base();
    const result = applyCodeEditProposal(original, patch([
      replace('page.html', 'Start', 'Launch'), replace('page.html', 'Launch', 'Go'),
      replace('notes.txt', 'Keep every byte.', ''),
      { op: 'create', path: 'main.ts', content: 'export default "new entry";\n' },
      { op: 'delete', path: 'other.js' },
    ], { entry: 'main.ts' }));
    expect(result.content.files['page.html']).toBe('<button aria-label="Go">Go</button>\n');
    expect(result.content.files['notes.txt']).toBe('\r\n🌿\n'); expect(result.content.files['other.js']).toBeUndefined();
    expect(result.content.entry).toBe('main.ts'); expect(original).toEqual(base());
  });
  it('supports changing only the entry without altering any file bytes', () => {
    const original = base(); const result = applyCodeEditProposal(original, patch([], { entry: 'other.js' }));
    expect(result.content.files).toEqual(original.files); expect(result.content.entry).toBe('other.js');
  });
  it.each(['../secret.js', '/tmp/page.html', 'a\\b.js', 'node_modules/pkg.js', '.git/config', '__proto__', 'a//b.js', 'tail/'])('refuses unsafe path %s', path => {
    const original = base(); expect(() => applyCodeEditProposal(original, patch([{ op: 'create', path, content: '' }]))).toThrow(); expect(original).toEqual(base());
  });
  it.each([
    [replace('missing.html')], [replace('page.html', 'absent')], [replace('page.html', '')],
    [{ op: 'create', path: 'page.html', content: 'conflict' }], [{ op: 'delete', path: 'missing.js' }],
    [{ op: 'create', path: 'new.js', content: '' }, { op: 'replace', path: 'new.js', find: 'x', replacement: 'y' }],
    [{ op: 'delete', path: 'other.js' }, { op: 'delete', path: 'other.js' }],
    [replace(), { op: 'delete', path: 'page.html' }],
    [{ op: 'delete', path: 'page.html' }, replace()],
    [{ op: 'create', path: 'new.js', content: '' }, { op: 'create', path: 'new.js', content: '' }],
    [{ op: 'delete', path: 'other.js' }, { op: 'create', path: 'other.js', content: 'regenerated' }],
    [{ ...replace(), actor: 'choose-authority' }], [{ op: 'unknown', path: 'page.html' }],
  ].map(changes => ({ changes })))('refuses malformed/missing/conflicting operations %# without modifying input', ({ changes }) => {
    const original = base(); expect(() => applyCodeEditProposal(original, patch(changes))).toThrow(); expect(original).toEqual(base());
  });
  it('refuses missing or deleted entry, no-op edits and extra authority fields', () => {
    const original = base();
    for (const value of [patch([replace()], { entry: 'absent.html' }), patch([{ op: 'delete', path: 'page.html' }]), patch([]), patch([replace('page.html', 'Start', 'Start')]), patch([replace()], { actor: 'other', root: '/tmp' })])
      expect(() => applyCodeEditProposal(original, value)).toThrow();
    expect(original).toEqual(base());
  });
  it('refuses inherited file names and safely handles own non-prototype file names', () => {
    expect(() => applyCodeEditProposal(base(), patch([replace('toString', 'x', 'y')]))).toThrow('original');
    const original = { files: { ...base().files, toString: 'actual virtual file\n' }, entry: 'page.html' };
    expect(applyCodeEditProposal(original, patch([replace('toString', 'actual', 'changed')])).content.files.toString).toBe('changed virtual file\n');
  });
  it('bounds operation count, aggregate text, UTF-8 file bytes and replacement expansion', () => {
    expect(() => applyCodeEditProposal(base(), patch(Array.from({ length: 101 }, () => replace())))).toThrow();
    expect(() => applyCodeEditProposal(base(), patch(Array.from({ length: 5 }, (_, i) => ({ op: 'create', path: `large${i}.txt`, content: 'x'.repeat(450_000) }))))).toThrow('2 MB');
    expect(() => applyCodeEditProposal(base(), patch([{ op: 'create', path: 'unicode.txt', content: '🌿'.repeat(130_000) }]))).toThrow('500 KB');
    const original = { files: { 'page.html': 'x'.repeat(500_000) }, entry: 'page.html' };
    expect(() => applyCodeEditProposal(original, patch([replace('page.html', 'x', 'xx')]))).toThrow('500 KB');
    expect(original.files['page.html']).toHaveLength(500_000);
  });
  it('bounds final file count and aggregate project bytes', () => {
    const full = { files: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [i ? `file${i}.txt` : 'page.html', 'x'])), entry: 'page.html' };
    expect(() => applyCodeEditProposal(full, patch([{ op: 'create', path: 'extra.txt', content: '' }]))).toThrow('50 file');
    const large = { files: { 'page.html': 'x'.repeat(500_000), 'a.txt': 'x'.repeat(500_000), 'b.txt': 'x'.repeat(500_000), 'c.txt': 'x'.repeat(500_000) }, entry: 'page.html' };
    expect(() => applyCodeEditProposal(large, patch([{ op: 'create', path: 'extra.txt', content: 'x' }]))).toThrow('2 MB project');
  });
});
