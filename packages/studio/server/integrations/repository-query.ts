import { z } from 'zod';
import {
  repositoryCommitRefSchema,
  repositoryPathSchema,
  repositoryReadSchema,
  type RepositoryRead,
} from '../../shared/identity.ts';
import { HttpError } from '../http-error.ts';
/** Only server-selected repository qualifiers are used; search text is one quoted literal phrase. */
export function repositoryRequestPath(
  key: string,
  input: RepositoryRead,
): string {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(key) ||
    key.split('/').some((part) => part === '.' || part === '..')
  )
    throw new HttpError(400, 'Use an exact repository identity');
  const read = repositoryReadSchema.parse(input),
    base = '/repos/' + key;
  switch (read.kind) {
    case 'tree':
      return `${base}/git/trees/${read.ref}?recursive=1`;
    case 'pull_request':
      return `${base}/pulls/${read.number}`;
    case 'issue':
      return `${base}/issues/${read.number}`;
    case 'file':
      return `${base}/contents/${read.path.split('/').map(encodeURIComponent).join('/')}?${new URLSearchParams(read.ref ? { ref: read.ref } : {})}`;
    case 'commits': {
      const query = new URLSearchParams({
        per_page: String(read.limit),
        ...(read.ref ? { sha: read.ref } : {}),
        ...(read.path ? { path: read.path } : {}),
      });
      return base + '/commits?' + query;
    }
    case 'search':
      return (
        '/search/code?' +
        new URLSearchParams({
          q: JSON.stringify(read.query) + ' repo:' + key + ' in:file',
          per_page: String(read.limit),
          page: '1',
        })
      );
  }
}
const indexedResult = z.object({
  total_count: z.number().int().nonnegative(),
  incomplete_results: z.boolean().optional(),
  items: z.array(
    z.object({
      path: repositoryPathSchema,
      sha: repositoryCommitRefSchema,
      repository: z.object({ full_name: z.string() }),
      text_matches: z.array(z.object({ fragment: z.string() })).optional(),
      snippet_truncated: z.boolean().optional(),
    }),
  ),
});
/** An upstream qualifier failure must never expose another repository's paths or code to a project. */
export function checkedRepositorySearch(
  value: unknown,
  key: string,
  limit: number,
) {
  const parsed = indexedResult.safeParse(value);
  if (!parsed.success)
    throw new HttpError(
      502,
      'GitHub returned an invalid repository code-search response',
    );
  if (
    parsed.data.items.some(
      (item) => item.repository.full_name.toLowerCase() !== key.toLowerCase(),
    )
  )
    throw new HttpError(
      502,
      'GitHub code-search results escaped the selected repository',
    );
  return {
    total_count: parsed.data.total_count,
    incomplete_results: !!parsed.data.incomplete_results,
    items: parsed.data.items.slice(0, limit).map((item) => ({
      path: item.path,
      sha: item.sha,
      repository: { full_name: key },
      text_matches: (item.text_matches ?? [])
        .slice(0, 4)
        .map((match) => ({ fragment: match.fragment.slice(0, 500) })),
      snippet_truncated:
        item.snippet_truncated === true ||
        (item.text_matches?.length ?? 0) > 4 ||
        (item.text_matches ?? []).some((match) => match.fragment.length > 500),
    })),
  };
}
