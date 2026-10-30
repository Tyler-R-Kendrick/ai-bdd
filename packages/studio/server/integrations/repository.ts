import { Buffer } from 'node:buffer';
import type { Settings } from '../auth.ts';
import { HttpError } from '../store.ts';
import { boundedJson } from './http.ts';

export class RepositoryReader {
  readonly repository: string;
  private ref: string | undefined;
  constructor(
    repositoryUrl: string,
    readonly settings: Settings,
    readonly authorize: () => unknown | Promise<unknown>,
    readonly signal: AbortSignal,
    readonly request: typeof fetch = fetch,
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
  private async get(path: string) {
    await this.authorize();
    const authenticated =
      this.settings.githubToken &&
      this.settings.githubRepositories?.includes(
        this.repository.toLowerCase(),
      );
    const response = await this.request(
      `https://api.github.com/repos/${this.repository}${path}`,
      {
        redirect: 'error',
        signal: this.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ai-bdd-studio',
          ...(authenticated
            ? { Authorization: `Bearer ${this.settings.githubToken}` }
            : {}),
        },
      },
    );
    const data = await boundedJson(response, this.signal);
    await this.authorize();
    return data;
  }
  async revision() {
    if (!this.ref) {
      const data = await this.get('/commits?per_page=1');
      if (!Array.isArray(data) || !/^[0-9a-f]{40,64}$/.test(data[0]?.sha))
        throw new HttpError(
          502,
          'GitHub did not return a repository revision',
        );
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
    const data = await this.get(`/git/trees/${sha}?recursive=1`);
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
  async pullRequest(number: number) {
    if (!Number.isSafeInteger(number) || number < 1 || number > 100000000)
      throw new HttpError(400, 'Invalid pull request number');
    const data = await this.get(`/pulls/${number}`);
    return {
      repository: this.repository,
      number,
      title: String(data.title).slice(0, 500),
      body: String(data.body ?? '').slice(0, 20000),
      state: data.merged ? 'merged' : data.state,
      baseSha: data.base?.sha,
      headSha: data.head?.sha,
      url: `https://github.com/${this.repository}/pull/${number}`,
    };
  }
}
