import { z } from 'zod';
import { HttpError, type Store } from '../store.ts';
import type { Settings } from '../auth.ts';
import type { User } from '../../shared/domain.ts';
import { RepositoryReader, type RepositoryReadPort } from './repository.ts';
const repository = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/?$/;
const canonical = (value: string) => value.replace(/\/$/, '').toLowerCase();
/** The branch and commit come from a fresh authenticated provider response, never the connector's proposed target. */
export async function resolveExistingPullRequest(
  options: {
    store: Store;
    settings: Settings;
    repositoryRead?: RepositoryReadPort;
  },
  user: User,
  repositoryUrl: string,
  url: string,
  signal: AbortSignal,
) {
  const repo = repositoryUrl.match(repository),
    pull = url.match(
      /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9][0-9]{0,8})$/,
    );
  if (
    !repo ||
    !pull ||
    canonical(`https://github.com/${pull[1]}/${pull[2]}`) !==
      canonical(repositoryUrl)
  )
    throw new HttpError(
      400,
      'Use an existing pull request on this project repository',
    );
  const admitted = await options.store.one(
    "SELECT p.id FROM projects p JOIN memberships m ON m.project_id=p.id WHERE m.user_id=? AND lower(rtrim(p.repository,'/'))=? LIMIT 1",
    user.id,
    canonical(repositoryUrl),
  );
  if (!admitted)
    throw new HttpError(
      403,
      'Join this repository-backed project before rebuilding its pull request',
    );
  const reader = new RepositoryReader(
    repositoryUrl,
    options.settings,
    () => options.store.role(admitted.id, user.id),
    signal,
    fetch,
    options.repositoryRead
      ? (input, signal) =>
          options.repositoryRead!(user, repositoryUrl, input, signal)
      : undefined,
  );
  const result = await reader.pullRequest(Number(pull[3]));
  const checked = z
    .object({
      state: z.enum(['open', 'closed', 'merged']),
      headSha: z.string().regex(/^[a-f0-9]{40}$/),
      headRef: z.string().min(1).max(200),
      headRepository: z.string().regex(repository),
      baseRepository: z.string().regex(repository),
    })
    .safeParse(result);
  if (
    !checked.success ||
    canonical(checked.data.headRepository) !== canonical(repositoryUrl) ||
    canonical(checked.data.baseRepository) !== canonical(repositoryUrl)
  )
    throw new HttpError(
      409,
      'The existing PR must have a verified head branch in the same repository; fork heads cannot be rebuilt',
    );
  return {
    url,
    repository: repositoryUrl,
    state: checked.data.state,
    branch: checked.data.headRef,
    commit: checked.data.headSha,
  };
}
