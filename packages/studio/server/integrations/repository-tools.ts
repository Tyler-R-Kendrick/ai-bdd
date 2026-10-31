import { tool } from 'ai';
import { z } from 'zod';
import { repositoryPathSchema } from '../../shared/identity.ts';

export const repositoryFileDescription =
  'Read a bounded repository file at this frozen turn revision using a repository-relative POSIX path (for example lib/helpers.ts). Absolute paths, native working-directory prefixes, dot segments, backslashes and control characters are not repository paths. The native working directory is not the repository root.';
// Native JSON grammar carries supported bounds and this description. The SDK
// enforces the existing Zod path refinement; Reader keeps its own IO guards.
export const repositoryFileInputSchema = z.object({
  path: repositoryPathSchema.describe(
    'Repository-relative POSIX path of 1 to 500 characters, for example lib/helpers.ts. Do not prepend /, a drive letter, /tmp, or the native working directory; do not use . or .. segments, backslashes, empty segments or control characters.',
  ),
}).strict();

/** The callback captures the authorized actor, repository and pinned revision server-side. */
export function repositoryFileTool(read: (path: string) => Promise<unknown>) {
  return tool({
    description: repositoryFileDescription,
    inputSchema: repositoryFileInputSchema,
    execute: ({ path }) => read(path),
  });
}
