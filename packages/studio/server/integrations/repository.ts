import {
  repositoryReadSchema,
  repositoryPathSchema,
  repositorySearchQuerySchema,
  type RepositoryRead,
} from '../../shared/identity.ts';
import {
  repositoryRequestPath,
  checkedRepositorySearch,
} from './repository-query.ts';
import { Buffer } from 'node:buffer';
import type { Settings } from '../auth.ts';
import { HttpError } from '../store.ts';
import { boundedJson } from './http.ts';
import type { User } from '../../shared/domain.ts';

export type RepositoryReadRequest = RepositoryRead;
export type RepositoryReadPort = (
  user: User,
  repository: string,
  input: RepositoryReadRequest,
  signal: AbortSignal,
) => Promise<unknown>;

export class RepositoryReader {
  readonly repository: string;
  private ref: string | undefined;
  constructor(
    repositoryUrl: string,
    readonly settings: Settings,
    readonly authorize: () => unknown | Promise<unknown>,
    readonly signal: AbortSignal,
    readonly request: typeof fetch = fetch,
    readonly identityRead?: (
      input: RepositoryReadRequest,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {
    const match = repositoryUrl.match(
      /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/?$/,
    );
    if (!match)
      throw new HttpError(
        400,
        'Select a GitHub repository for repository tools',
      );
    this.repository = `${match[1]}/${match[2]}`;
  }
  private async get(_path: string, input: RepositoryReadRequest) {
    await this.authorize();
    this.signal.throwIfAborted();
    if (
      (this.settings as Settings & { repositoryIdentity?: unknown })
        .repositoryIdentity &&
      !this.identityRead
    )
      throw new HttpError(
        503,
        'The verified repository identity transport is not configured',
      );
    if (this.identityRead) {
      const data = await this.identityRead(input, this.signal);
      this.signal.throwIfAborted();
      await this.authorize();
      return data as any;
    }
    // A caller's project membership never delegates an operator credential.
    // Private reads must use the independently authorized personal adapter.
    const response = await this.request(
      `https://api.github.com${repositoryRequestPath(this.repository, input)}`,
      {
        redirect: 'error',
        signal: this.signal,
        headers: {
          Accept:
            input.kind === 'search'
              ? 'application/vnd.github.text-match+json'
              : 'application/vnd.github+json',
          'User-Agent': 'ai-bdd-studio',
        },
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(
        502,
        'GitHub could not return repository data. Use a public repository or authorize your personal GitHub repository connection.',
      );
    }
    const data = await boundedJson(response, this.signal);
    await this.authorize();
    return data;
  }
  async revision() {
    if (!this.ref) {
      const data = await this.get('/commits?per_page=1', {
        kind: 'commits',
        limit: 1,
      });
      if (!Array.isArray(data) || !/^[0-9a-f]{40,64}$/.test(data[0]?.sha))
        throw new HttpError(502, 'GitHub did not return a repository revision');
      this.ref = data[0].sha;
    }
    return this.ref!;
  }
  pin(revision: string) {
    if (!/^[0-9a-f]{40,64}$/.test(revision))
      throw new HttpError(400, 'Invalid pinned repository revision');
    this.ref = revision;
  }
  async tree() {
    const sha = await this.revision();
    const data = await this.get(`/git/trees/${sha}?recursive=1`, {
      kind: 'tree',
      ref: sha,
    });
    return {
      repository: this.repository,
      revision: sha,
      truncated: !!data.truncated || (data.tree?.length ?? 0) > 1000,
      entries: (data.tree ?? []).slice(0, 1000).map((entry: any) => ({
        path: entry.path,
        type: entry.type,
        size: entry.size,
      })),
    };
  }
  async file(path: string) {
    if (
      path.length > 500 ||
      path.startsWith('/') ||
      path.split('/').some((part) => part === '..' || part === '') ||
      path.includes('\\') ||
      Array.from(path).some((character) => character.charCodeAt(0) < 32)
    )
      throw new HttpError(400, 'Use a repository-relative file path');
    const sha = await this.revision();
    const data = await this.get(
      `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`,
      { kind: 'file', path, ref: sha },
    );
    if (
      data.type !== 'file' ||
      data.encoding !== 'base64' ||
      typeof data.content !== 'string' ||
      data.size > 120000
    )
      throw new HttpError(
        413,
        'Repository file is too large or is not readable text',
      );
    const bytes = Buffer.from(data.content, 'base64');
    if (bytes.length > 120000 || bytes.includes(0))
      throw new HttpError(
        413,
        'Repository file is too large or is not readable text',
      );
    return {
      repository: this.repository,
      revision: sha,
      path,
      text: bytes.toString('utf8'),
      url: `https://github.com/${this.repository}/blob/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`,
    };
  }
  async history(options: { path?: string; limit?: number } = {}) {
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new HttpError(400, 'History is limited to between 1 and 20 commits');
    const revision = await this.revision(),
      input = repositoryReadSchema.parse({
        kind: 'commits',
        limit,
        ref: revision,
        ...(options.path !== undefined
          ? { path: repositoryPathSchema.parse(options.path) }
          : {}),
      });
    if (input.kind !== 'commits') throw new Error('Expected commit history');
    const data = await this.get('', input);
    if (!Array.isArray(data))
      throw new HttpError(502, 'GitHub returned invalid commit history');
    const commits = data.slice(0, input.limit).map((entry: any) => {
      if (
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(entry?.sha) ||
        typeof entry?.commit?.message !== 'string'
      )
        throw new HttpError(502, 'GitHub returned an invalid history entry');
      return {
        sha: entry.sha.toLowerCase(),
        message: entry.commit.message.slice(0, 4000),
        messageTruncated: entry.commit.message.length > 4000,
        author: String(entry.commit.author?.name ?? '').slice(0, 200),
        date:
          typeof entry.commit.author?.date === 'string'
            ? entry.commit.author.date.slice(0, 100)
            : null,
        url: `https://github.com/${this.repository}/commit/${entry.sha.toLowerCase()}`,
      };
    });
    return {
      repository: this.repository,
      revision,
      path: options.path ?? null,
      limit: input.limit,
      limitReached: data.length >= input.limit,
      commits,
    };
  }
  async search(query: string, limit = 10) {
    const phrase = repositorySearchQuerySchema.parse(query),
      input = repositoryReadSchema.parse({
        kind: 'search',
        query: phrase,
        limit,
      }),
      revision = await this.revision();
    const raw = await this.get('', input),
      data = checkedRepositorySearch(raw, this.repository, limit);
    return {
      repository: this.repository,
      query: phrase,
      scope: 'github-indexed-default-branch' as const,
      pinnedRevision: revision,
      totalCount: data.total_count,
      incomplete: data.incomplete_results,
      limitReached: data.total_count > data.items.length,
      sourceNote:
        'Search snippets are indexed default-branch hints, not evidence at the pinned turn revision. Read the pinned file to verify exact source.',
      matches: data.items.map((item) => ({
        path: item.path,
        indexedBlobSha: item.sha,
        indexedSnippets: item.text_matches.map((match) => match.fragment),
        snippetsTruncated: item.snippet_truncated,
        pinnedFileUrl: `https://github.com/${this.repository}/blob/${revision}/${item.path.split('/').map(encodeURIComponent).join('/')}`,
      })),
    };
  }
  async pullRequest(number: number) {
    if (!Number.isSafeInteger(number) || number < 1 || number > 100000000)
      throw new HttpError(400, 'Invalid pull request number');
    const data = await this.get(`/pulls/${number}`, {
      kind: 'pull_request',
      number,
    });
    return {
      repository: this.repository,
      number,
      title: String(data.title).slice(0, 500),
      body: String(data.body ?? '').slice(0, 20000),
      state: data.merged ? 'merged' : data.state,
      baseSha: data.base?.sha,
      headSha: data.head?.sha,
      headRef: data.head?.ref,
      headRepository: data.head?.repo?.html_url,
      baseRepository: data.base?.repo?.html_url,
      url: `https://github.com/${this.repository}/pull/${number}`,
    };
  }
}
