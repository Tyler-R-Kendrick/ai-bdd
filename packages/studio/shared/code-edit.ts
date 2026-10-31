import { z } from 'zod';
import {
  checkCodeProject,
  validCodePath,
  CODE_FILE_LIMIT,
  CODE_SOURCE_LIMIT,
  type CodeProject,
  entryFile,
} from './code-project.ts';

const fileSourceLimit = 500_000;
const path = z.string().min(1).max(200)
  .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/)
  .refine(validCodePath)
  .describe('Relative path in this code artifact; no absolute paths, traversal, or reserved directories.');
function proposalSchema(existingPath: z.ZodType<string>, createPath: z.ZodType<string>) {
  return z.object({
    summary: z.string().max(10_000),
    changes: z.array(z.discriminatedUnion('op', [
      z.object({
        op: z.literal('replace'),
        path: existingPath,
        find: z.string().min(1).max(fileSourceLimit).describe('Exact nonempty existing text, not a regular expression.'),
        replacement: z.string().max(fileSourceLimit).describe('Literal replacement for ALL non-overlapping matches; may be empty. Preserve unrelated text.'),
      }).strict(),
      z.object({
        op: z.literal('create'),
        path: createPath,
        content: z.string().max(fileSourceLimit),
      }).strict(),
      z.object({ op: z.literal('delete'), path: existingPath }).strict(),
    ])).max(100).describe('Use the smallest change set required by the request; preservation constraints are not edit operations. Omit replacements that leave text unchanged. Apply in order. Replace/delete only original files; create only originally missing files. Create/delete cannot share a path with another operation. Empty only for an entry update.'),
    entry: path.optional().describe('Omit to preserve the current entry; otherwise select an existing final HTML/JavaScript/JSX/TypeScript file.'),
  }).strict();
}
export const codeEditProposalSchema = proposalSchema(path, path);
export type CodeEditProposal = z.infer<typeof codeEditProposalSchema>;
export class CodeEditProposalError extends Error {}
export class CodeEditValidationError extends CodeEditProposalError {
  readonly feedback: Readonly<{ reason: 'missing-literal' | 'conflicting-operations'; operationIndex: number; path?: string }>;
  constructor(reason: 'missing-literal' | 'conflicting-operations', operationIndex: number, scopedPath?: string) {
    super(reason === 'missing-literal' ? 'Literal find text is absent from the selected artifact file' : 'Conflicting code edit operations for the same path');
    this.name = 'CodeEditValidationError';
    this.feedback = Object.freeze({ reason, operationIndex, ...(scopedPath === undefined ? {} : { path: scopedPath }) });
  }
}

/** Bind the model's existing-file choices to this trusted saved artifact only. */
export function codeEditProposalSchemaFor(original: CodeProject) {
  const names = Object.keys(checkCodeProject(original).files);
  const existing = new Set(names);
  return proposalSchema(
    z.enum(names).describe('Choose an exact existing filename from this saved artifact.'),
    path.refine(name => !existing.has(name), 'Create requires an originally missing artifact file')
      .describe('Choose a new relative artifact filename; never recreate an existing file.'),
  );
}

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
  for (const [index, change] of proposal.changes.entries()) {
    const exists = Object.hasOwn(original.files, change.path);
    if (change.op === 'create' ? exists : !exists)
      throw new CodeEditProposalError(change.op === 'create' ? 'Create requires an originally missing artifact file' : 'Replace/delete requires an original artifact file');
    if (previous.has(change.path) && (previous.get(change.path) !== 'replace' || change.op !== 'replace'))
      throw new CodeEditValidationError('conflicting-operations', index, exists ? change.path : undefined);
    previous.set(change.path, change.op === 'replace' ? 'replace' : 'exclusive');
    for (const text of change.op === 'replace' ? [change.find, change.replacement] : change.op === 'create' ? [change.content] : []) {
      operationBytes += encoder.encode(text).length;
      if (operationBytes > CODE_SOURCE_LIMIT) throw new CodeEditProposalError('Code edit operations exceed the 2 MB text limit');
    }
  }
  function setFile(name: string, source: string) {
    const bytes = encoder.encode(source).length;
    if (bytes > fileSourceLimit) throw new CodeEditProposalError('Code edit exceeds the 500 KB file limit');
    const existed = Object.hasOwn(files, name);
    const total = sourceBytes - (existed ? encoder.encode(files[name]!).length : 0) + bytes;
    if (total > CODE_SOURCE_LIMIT) throw new CodeEditProposalError('Code edit exceeds the 2 MB project limit');
    if (!existed && fileCount >= CODE_FILE_LIMIT) throw new CodeEditProposalError('Code edit exceeds the 50 file limit');
    files[name] = source;
    sourceBytes = total;
    if (!existed) fileCount++;
  }
  for (const [index, change] of proposal.changes.entries()) {
    if (change.op === 'create') setFile(change.path, change.content);
    else if (change.op === 'delete') {
      sourceBytes -= encoder.encode(files[change.path]!).length;
      delete files[change.path]; fileCount--;
    } else {
      // All operations have already passed schema, scope, conflict and text
      // bounds validation. Replacing text with itself is the identity function,
      // whether or not that literal occurs; it cannot change any source byte.
      if (change.find === change.replacement) continue;
      const source = files[change.path]!;
      let matches = 0, offset = 0;
      while (true) {
        const found = source.indexOf(change.find, offset);
        if (found < 0) break;
        matches++; offset = found + change.find.length;
      }
      if (!matches) throw new CodeEditValidationError('missing-literal', index, change.path);
      // Bound the allocation before split/join. UTF-8 bounds are checked next.
      if (source.length + matches * (change.replacement.length - change.find.length) > fileSourceLimit)
        throw new CodeEditProposalError('Code edit exceeds the 500 KB file limit');
      setFile(change.path, source.split(change.find).join(change.replacement));
    }
  }
  const entry = proposal.entry ?? original.entry;
  if (!entryFile(entry) || !Object.hasOwn(files, entry))
    throw new CodeEditProposalError('Choose an existing HTML, JavaScript, JSX, or TypeScript entry file');
  const content = checkCodeProject({ files, entry });
  if (content.entry === original.entry && fileCount === Object.keys(original.files).length &&
    Object.entries(original.files).every(([name, source]) => Object.hasOwn(files, name) && files[name] === source))
    throw new CodeEditProposalError('A code edit must change a file or the entry');
  return { summary: proposal.summary, content };
}
