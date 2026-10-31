import { z } from 'zod';
import {
  checkCodeProject,
  validCodePath,
  CODE_FILE_LIMIT,
  CODE_SOURCE_LIMIT,
  type CodeProject,
} from './code-project.ts';

const fileSourceLimit = 500_000;
const path = z.string().min(1).max(200).refine(validCodePath)
  .describe('Relative path in this code artifact; no absolute paths, traversal, or reserved directories.');
export const codeEditProposalSchema = z.object({
  summary: z.string().max(10_000),
  changes: z.array(z.discriminatedUnion('op', [
    z.object({
      op: z.literal('replace'),
      path,
      find: z.string().min(1).max(fileSourceLimit).describe('Exact nonempty existing text, not a regular expression.'),
      replacement: z.string().max(fileSourceLimit).describe('Literal replacement for ALL non-overlapping matches; may be empty. Preserve unrelated text.'),
    }).strict(),
    z.object({
      op: z.literal('create'),
      path,
      content: z.string().max(fileSourceLimit),
    }).strict(),
    z.object({ op: z.literal('delete'), path }).strict(),
  ])).max(100).describe('Apply in order. Replace/delete only original files; create only originally missing files. Create/delete cannot share a path with another operation. Empty only for an entry update.'),
  entry: path.optional().describe('Omit to preserve the current entry; otherwise select an existing final HTML/JavaScript/JSX/TypeScript file.'),
}).strict();

/** Pure artifact-scoped reconstruction; never reads or writes a host file. */
export function applyCodeEditProposal(original: CodeProject, value: unknown) {
  checkCodeProject(original);
  const proposal = codeEditProposalSchema.parse(value);
  const files = { ...original.files };
  const encoder = new TextEncoder();
  let sourceBytes = Object.values(files).reduce((sum, text) => sum + encoder.encode(text).length, 0);
  let fileCount = Object.keys(files).length;
  let operationBytes = 0;
  const previous = new Map<string, 'replace' | 'exclusive'>();
  for (const change of proposal.changes) {
    const exists = Object.hasOwn(original.files, change.path);
    if (change.op === 'create' ? exists : !exists)
      throw new Error(change.op === 'create' ? 'Create requires an originally missing artifact file' : 'Replace/delete requires an original artifact file');
    if (previous.has(change.path) && (previous.get(change.path) !== 'replace' || change.op !== 'replace'))
      throw new Error('Conflicting code edit operations for the same path');
    previous.set(change.path, change.op === 'replace' ? 'replace' : 'exclusive');
    for (const text of change.op === 'replace' ? [change.find, change.replacement] : change.op === 'create' ? [change.content] : []) {
      operationBytes += encoder.encode(text).length;
      if (operationBytes > CODE_SOURCE_LIMIT) throw new Error('Code edit operations exceed the 2 MB text limit');
    }
  }
  function setFile(name: string, source: string) {
    const bytes = encoder.encode(source).length;
    if (bytes > fileSourceLimit) throw new Error('Code edit exceeds the 500 KB file limit');
    const existed = Object.hasOwn(files, name);
    const total = sourceBytes - (existed ? encoder.encode(files[name]!).length : 0) + bytes;
    if (total > CODE_SOURCE_LIMIT) throw new Error('Code edit exceeds the 2 MB project limit');
    if (!existed && fileCount >= CODE_FILE_LIMIT) throw new Error('Code edit exceeds the 50 file limit');
    files[name] = source;
    sourceBytes = total;
    if (!existed) fileCount++;
  }
  for (const change of proposal.changes) {
    if (change.op === 'create') setFile(change.path, change.content);
    else if (change.op === 'delete') {
      sourceBytes -= encoder.encode(files[change.path]!).length;
      delete files[change.path]; fileCount--;
    } else {
      const source = files[change.path]!;
      let matches = 0, offset = 0;
      while (true) {
        const found = source.indexOf(change.find, offset);
        if (found < 0) break;
        matches++; offset = found + change.find.length;
      }
      if (!matches) throw new Error('Literal find text is absent from the selected artifact file');
      // Bound the allocation before split/join. UTF-8 bounds are checked next.
      if (source.length + matches * (change.replacement.length - change.find.length) > fileSourceLimit)
        throw new Error('Code edit exceeds the 500 KB file limit');
      setFile(change.path, source.split(change.find).join(change.replacement));
    }
  }
  const content = checkCodeProject({ files, entry: proposal.entry ?? original.entry });
  if (content.entry === original.entry && fileCount === Object.keys(original.files).length &&
    Object.entries(original.files).every(([name, source]) => Object.hasOwn(files, name) && files[name] === source))
    throw new Error('A code edit must change a file or the entry');
  return { summary: proposal.summary, content };
}
