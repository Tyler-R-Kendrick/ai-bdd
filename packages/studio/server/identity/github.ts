import {
  repositoryRequestPath,
  checkedRepositorySearch,
} from '../integrations/repository-query.ts';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError, hash } from '../store.ts';
import type { User, Project } from '../../shared/domain.ts';
import {
  repositoryKey,
  repositoryReadSchema,
  type RepositoryAction,
  type RepositoryIdentityStatus,
  type RepositoryRead,
} from '../../shared/identity.ts';
import { DurableChallenges } from './challenges.ts';
import { CredentialVault } from './vault.ts';
import type {
  IdentityStore,
  IdentityAuth,
  IdentitySettings,
  RepositoryIdentitySettings,
} from './ports.ts';

const tokenSchema = z.object({
  access_token: z.string().min(1).max(4096),
  token_type: z.string().refine((s) => s.toLowerCase() === 'bearer'),
  refresh_token: z.string().min(1).max(4096).optional(),
  expires_in: z.coerce.number().int().min(1).max(31_536_000).optional(),
  refresh_token_expires_in: z.coerce
    .number()
    .int()
    .min(1)
    .max(31_536_000)
    .optional(),
  scope: z.string().max(2000).optional(),
});
type IdentityRow = {
  user_id: string;
  github_id: string;
  login: string;
  access_cipher: string;
  refresh_cipher: string | null;
  access_expires: number | string;
  refresh_expires: number | string;
  version: number;
  generation: string;
  permission_version: number;
  refresh_owner: string | null;
  refresh_until: number | string;
  updated_at: number | string;
};
class GithubError extends HttpError {
  constructor(readonly upstreamStatus: number) {
    super(
      upstreamStatus === 401
        ? 401
        : upstreamStatus === 403 || upstreamStatus === 404
          ? 403
          : 503,
      upstreamStatus === 401
        ? 'Your GitHub authorization expired or was revoked. Reconnect your account.'
        : upstreamStatus === 403 || upstreamStatus === 404
          ? 'Your GitHub account does not have the required repository permission.'
          : 'GitHub could not verify repository permissions. Try again shortly.',
    );
  }
}
async function boundedJson(
  response: Response,
  limit = 1_048_576,
): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new HttpError(
        502,
        'GitHub returned more data than this bounded operation permits',
      );
    }
    chunks.push(value);
  }
  if (!total) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(502, 'GitHub returned an invalid response');
  }
}
function endpoint(
  value: string,
  production: boolean,
  allowLoopback: boolean,
): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      'GitHub endpoint URLs cannot include credentials, queries, or fragments',
    );
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      !production &&
      allowLoopback &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    )
  )
    throw new Error(
      'GitHub endpoints require HTTPS; explicit development fixtures may use loopback HTTP',
    );
  return url.href.replace(/\/$/, '');
}
const numericId = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === 'string' && /^\d{1,30}$/.test(value)
      ? value
      : null;
export class RepositoryIdentity {
  readonly challenges: DurableChallenges;
  readonly config?: RepositoryIdentitySettings;
  readonly vault?: CredentialVault;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly apiBaseUrl: string;
  readonly leaseSeconds: number;
  private refreshing = new Map<string, Promise<IdentityRow>>();
  constructor(
    readonly store: IdentityStore,
    readonly auth: IdentityAuth,
    readonly settings: IdentitySettings,
  ) {
    this.config = settings.repositoryIdentity;
    this.challenges = new DurableChallenges(store);
    this.leaseSeconds = this.config?.leaseSeconds ?? 30;
    if (
      !Number.isInteger(this.leaseSeconds) ||
      this.leaseSeconds < 5 ||
      this.leaseSeconds > 300
    )
      throw new Error(
        'Repository permission leases must be between 5 and 300 seconds',
      );
    if (this.config) {
      if (!this.config.clientId || !this.config.clientSecret)
        throw new Error('GitHub identity requires a client ID and secret');
      this.vault = new CredentialVault(this.config.encryptionKey);
      if (settings.production && this.config.allowLoopback)
        throw new Error(
          'Loopback GitHub endpoints are restricted to development',
        );
      if (this.config.webhookSecret && this.config.webhookSecret.length < 32)
        throw new Error(
          'GitHub webhook secrets must have at least 32 characters',
        );
    }
    this.authorizationUrl = endpoint(
      this.config?.authorizationUrl ??
        'https://github.com/login/oauth/authorize',
      settings.production,
      !!this.config?.allowLoopback,
    );
    this.tokenUrl = endpoint(
      this.config?.tokenUrl ?? 'https://github.com/login/oauth/access_token',
      settings.production,
      !!this.config?.allowLoopback,
    );
    this.apiBaseUrl = endpoint(
      this.config?.apiBaseUrl ?? 'https://api.github.com',
      settings.production,
      !!this.config?.allowLoopback,
    );
  }
  async initialize() {
    await this.store.tx(async () => {
      await this.store.lock('schema:studio.identity');
      await this.initializeTables();
    });
  }
  private async initializeTables() {
    await this.challenges.initialize();
    await this.store.exec(
      'CREATE TABLE IF NOT EXISTS repository_identities(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,github_id TEXT UNIQUE NOT NULL,login TEXT NOT NULL,access_cipher TEXT NOT NULL,refresh_cipher TEXT,access_expires BIGINT NOT NULL DEFAULT 0,refresh_expires BIGINT NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,generation TEXT NOT NULL,permission_version INTEGER NOT NULL DEFAULT 1,refresh_owner TEXT,refresh_until BIGINT NOT NULL DEFAULT 0,updated_at BIGINT NOT NULL)',
    );
    const additions = [
      ['refresh_owner', 'TEXT'],
      ['refresh_until', 'BIGINT NOT NULL DEFAULT 0'],
      ['permission_version', 'INTEGER NOT NULL DEFAULT 1'],
    ];
    if (this.store.db?.dialect === 'postgres') {
      for (const [name, definition] of additions)
        await this.store.exec(
          `ALTER TABLE repository_identities ADD COLUMN IF NOT EXISTS ${name} ${definition}`,
        );
    } else {
      const names = new Set(
        (await this.store.all('PRAGMA table_info(repository_identities)')).map(
          (column) => column.name,
        ),
      );
      for (const [name, definition] of additions)
        if (!names.has(name))
          await this.store.exec(
            `ALTER TABLE repository_identities ADD COLUMN ${name} ${definition}`,
          );
    }

    await this.store.exec(
      "CREATE TABLE IF NOT EXISTS repository_identity_leases(user_id TEXT NOT NULL REFERENCES repository_identities(user_id) ON DELETE CASCADE,repository TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('read','write')),identity_version INTEGER NOT NULL,identity_generation TEXT NOT NULL,permission_version INTEGER NOT NULL DEFAULT 1,expires_at BIGINT NOT NULL,PRIMARY KEY(user_id,repository,action))",
    );
    if (this.store.db?.dialect === 'postgres')
      await this.store.exec(
        'ALTER TABLE repository_identity_leases ADD COLUMN IF NOT EXISTS permission_version INTEGER NOT NULL DEFAULT 1',
      );
    else if (
      !(
        await this.store.all('PRAGMA table_info(repository_identity_leases)')
      ).some((column) => column.name === 'permission_version')
    )
      await this.store.exec(
        'ALTER TABLE repository_identity_leases ADD COLUMN permission_version INTEGER NOT NULL DEFAULT 1',
      );
    await this.store.exec(
      'CREATE TABLE IF NOT EXISTS repository_identity_epochs(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,epoch TEXT NOT NULL)',
    );
    await this.store.exec(
      'CREATE INDEX IF NOT EXISTS repository_identity_lease_expiry ON repository_identity_leases(expires_at)',
    );
  }
  private requireConfigured() {
    if (!this.config || !this.vault)
      throw new HttpError(
        503,
        'The workspace owner has not configured GitHub account connections',
      );
    return { config: this.config, vault: this.vault };
  }
  private async identity(userId: string): Promise<IdentityRow | null> {
    return (
      (await this.store.one(
        'SELECT * FROM repository_identities WHERE user_id=?',
        userId,
      )) ?? null
    );
  }
  private async provider(url: string, options: RequestInit, limit?: number) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.any([
          AbortSignal.timeout(12000),
          ...(options.signal ? [options.signal] : []),
        ]),
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ai-bdd-studio',
          'X-GitHub-Api-Version': '2022-11-28',
          ...options.headers,
        },
      });
    } catch {
      options.signal?.throwIfAborted();
      throw new HttpError(
        503,
        'GitHub could not be reached. Try again shortly.',
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new GithubError(response.status);
    }
    return boundedJson(response, limit);
  }
  private async profile(accessToken: string) {
    const value = await this.provider(
        this.apiBaseUrl + '/user',
        { headers: { Authorization: 'Bearer ' + accessToken } },
        65536,
      ),
      id = numericId(value?.id);
    if (
      !id ||
      typeof value.login !== 'string' ||
      !/^[A-Za-z0-9-]{1,39}$/.test(value.login)
    )
      throw new HttpError(502, 'GitHub returned an invalid account identity');
    return { id, login: value.login as string };
  }
  private async exchange(parameters: Record<string, string>) {
    const { config } = this.requireConfigured();
    const response = await this.provider(
      this.tokenUrl,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          ...parameters,
        }),
      },
      65536,
    );
    if (response?.error)
      throw new HttpError(
        401,
        'GitHub could not complete this authorization. Start the connection again.',
      );
    const result = tokenSchema.safeParse(response);
    if (!result.success)
      throw new HttpError(
        502,
        'GitHub returned an invalid authorization response',
      );
    return result.data;
  }
  async status(user: User): Promise<RepositoryIdentityStatus> {
    const row = await this.identity(user.id),
      now = Date.now(),
      expires = Number(row?.access_expires ?? 0),
      refresh = Number(row?.refresh_expires ?? 0);
    return {
      configured: !!this.config,
      connected:
        !!row &&
        (expires === 0 ||
          expires > now ||
          (!!row.refresh_cipher && (refresh === 0 || refresh > now))),
      login: row?.login ?? null,
      expiresAt: expires || null,
      refreshAvailable:
        !!row?.refresh_cipher && (refresh === 0 || refresh > now),
      leaseSeconds: this.leaseSeconds,
    };
  }
  private async active(userId: string): Promise<IdentityRow> {
    const row = await this.identity(userId);
    if (!row)
      throw new HttpError(
        403,
        'Connect your GitHub account to access repository-backed projects',
      );
    this.requireConfigured().vault.open(row.access_cipher, userId, 'access');
    const expires = Number(row.access_expires);
    if (!expires || expires > Date.now() + 15000) return row;
    let pending = this.refreshing.get(userId);
    if (!pending) {
      pending = this.refresh(row).finally(() => this.refreshing.delete(userId));
      this.refreshing.set(userId, pending);
    }
    return pending;
  }
  private async refresh(row: IdentityRow): Promise<IdentityRow> {
    const owner = randomUUID(),
      now = Date.now(),
      claimed = await this.store.tx(async () => {
        await this.store.lock('repository-identity:' + row.user_id);
        return this.store.one(
          'UPDATE repository_identities SET refresh_owner=?,refresh_until=? WHERE user_id=? AND generation=? AND version=? AND (refresh_owner IS NULL OR refresh_until<=?) RETURNING user_id',
          owner,
          now + 35000,
          row.user_id,
          row.generation,
          row.version,
          now,
        );
      });
    if (!claimed) {
      for (let attempt = 0; attempt < 350; attempt++) {
        const current = await this.identity(row.user_id);
        if (!current)
          throw new HttpError(403, 'Your GitHub connection was revoked');
        if (
          current.generation !== row.generation ||
          Number(current.version) !== Number(row.version)
        )
          return current;
        if (
          !current.refresh_owner ||
          Number(current.refresh_until) <= Date.now()
        )
          throw new HttpError(
            503,
            'GitHub credentials could not be refreshed. Retry the request.',
          );
        await delay(100);
      }
      throw new HttpError(
        503,
        'GitHub credentials are being refreshed. Retry shortly.',
      );
    }
    try {
      return await this.refreshUnlocked(row, owner);
    } finally {
      await this.store.tx(async () => {
        await this.store.lock('repository-identity:' + row.user_id);
        await this.store.exec(
          'UPDATE repository_identities SET refresh_owner=NULL,refresh_until=0 WHERE user_id=? AND generation=? AND refresh_owner=?',
          row.user_id,
          row.generation,
          owner,
        );
      });
    }
  }
  private async refreshUnlocked(
    row: IdentityRow,
    owner: string,
  ): Promise<IdentityRow> {
    const { vault } = this.requireConfigured();
    if (
      !row.refresh_cipher ||
      (Number(row.refresh_expires) > 0 &&
        Number(row.refresh_expires) <= Date.now())
    )
      throw new HttpError(
        403,
        'Your GitHub connection expired. Connect your account again.',
      );
    let tokens: z.infer<typeof tokenSchema>;
    try {
      tokens = await this.exchange({
        grant_type: 'refresh_token',
        refresh_token: vault.open(row.refresh_cipher, row.user_id, 'refresh'),
      });
    } catch (error) {
      const current = await this.identity(row.user_id);
      if (
        current &&
        (current.generation !== row.generation ||
          Number(current.version) !== Number(row.version))
      )
        return current;
      if (current && current.refresh_owner !== owner)
        throw new HttpError(
          503,
          'GitHub credentials are being refreshed. Retry shortly.',
        );
      if (error instanceof HttpError && error.statusCode === 401)
        await this.revoke(row.user_id, false, row.generation);
      throw error;
    }
    const profile = await this.profile(tokens.access_token);
    if (profile.id !== row.github_id) {
      await this.revoke(row.user_id, false, row.generation);
      throw new HttpError(
        403,
        'The refreshed GitHub authorization belongs to another account. Reconnect.',
      );
    }
    const now = Date.now();
    return await this.store.tx(async () => {
      await this.store.lock('repository-identity:' + row.user_id);
      const updated = await this.store.one(
        'UPDATE repository_identities SET login=?,access_cipher=?,refresh_cipher=?,access_expires=?,refresh_expires=?,version=version+1,refresh_owner=NULL,refresh_until=0,updated_at=? WHERE user_id=? AND version=? AND generation=? AND refresh_owner=? RETURNING user_id',
        profile.login,
        vault.seal(tokens.access_token, row.user_id, 'access'),
        tokens.refresh_token
          ? vault.seal(tokens.refresh_token, row.user_id, 'refresh')
          : row.refresh_cipher,
        tokens.expires_in ? now + tokens.expires_in * 1000 : 0,
        tokens.refresh_token_expires_in
          ? now + tokens.refresh_token_expires_in * 1000
          : Number(row.refresh_expires),
        now,
        row.user_id,
        row.version,
        row.generation,
        owner,
      );
      if (updated)
        await this.store.exec(
          'DELETE FROM repository_identity_leases WHERE user_id=?',
          row.user_id,
        );
      const current = await this.identity(row.user_id);
      if (!current)
        throw new HttpError(403, 'Your GitHub connection was revoked');
      return current;
    });
  }
  async checkLease(
    userId: string,
    repository: string,
    action: RepositoryAction,
  ): Promise<boolean> {
    if (!repository) return true;
    let key: string;
    try {
      key = repositoryKey(repository);
    } catch {
      return false;
    }
    if (!this.vault) return false;
    const now = Date.now(),
      row = await this.store.one(
        'SELECT l.expires_at,i.access_expires,i.access_cipher FROM repository_identity_leases l JOIN repository_identities i ON i.user_id=l.user_id AND i.version=l.identity_version AND i.generation=l.identity_generation AND i.permission_version=l.permission_version WHERE l.user_id=? AND l.repository=? AND l.action=? AND l.expires_at>?',
        userId,
        key,
        action,
        now,
      );
    if (
      !row ||
      (Number(row.access_expires) && Number(row.access_expires) <= now)
    )
      return false;
    try {
      this.vault.open(row.access_cipher, userId, 'access');
      return true;
    } catch {
      return false;
    }
  }
  async assertRepository(
    user: User,
    repository: string,
    action: RepositoryAction,
    options: { fresh?: boolean } = {},
  ): Promise<void> {
    if (!repository) return;
    let key: string;
    try {
      key = repositoryKey(repository);
    } catch {
      throw new HttpError(400, 'Use an exact github.com repository URL');
    }
    this.requireConfigured();
    const row = await this.active(user.id);
    if (!options.fresh && (await this.checkLease(user.id, repository, action)))
      return;
    const { vault } = this.requireConfigured();
    let result: any;
    try {
      result = await this.provider(
        this.apiBaseUrl + '/repos/' + key,
        {
          headers: {
            Authorization:
              'Bearer ' + vault.open(row.access_cipher, user.id, 'access'),
          },
        },
        262144,
      );
    } catch (error) {
      if (error instanceof GithubError && error.upstreamStatus === 401)
        await this.revoke(user.id, false, row.generation);
      else await this.invalidateUserPermissions(user.id, row.generation);
      throw error;
    }
    if (
      typeof result?.full_name !== 'string' ||
      result.full_name.toLowerCase() !== key ||
      (action === 'read'
        ? result?.permissions?.pull
        : result?.permissions?.push) !== true
    ) {
      await this.invalidateUserPermissions(user.id, row.generation);
      throw new HttpError(
        403,
        action === 'read'
          ? 'Your GitHub account needs pull access to this repository.'
          : 'Your GitHub account needs push access to this repository.',
      );
    }
    const now = Date.now(),
      expires = Math.min(
        now + this.leaseSeconds * 1000,
        Number(row.access_expires) || Number.MAX_SAFE_INTEGER,
      );
    // A disconnect/refresh racing the provider response must prevent the grant.
    await this.store.tx(async () => {
      await this.store.lock('repository-identity:' + user.id);
      if (
        !(await this.store.one(
          'SELECT user_id FROM repository_identities WHERE user_id=? AND version=? AND generation=? AND permission_version=?',
          user.id,
          row.version,
          row.generation,
          row.permission_version,
        ))
      )
        throw new HttpError(
          403,
          'Your GitHub connection changed. Retry the request.',
        );
      // A provider response is authoritative for BOTH capabilities, including
      // removal of a previously cached push grant after a pull-only response.
      await this.store.exec(
        'DELETE FROM repository_identity_leases WHERE user_id=? AND repository=?',
        user.id,
        key,
      );
      for (const capability of ['read', 'write'] as const) {
        if (
          (capability === 'read'
            ? result.permissions.pull
            : result.permissions.push) !== true
        )
          continue;
        await this.store.one(
          'INSERT INTO repository_identity_leases(user_id,repository,action,identity_version,identity_generation,permission_version,expires_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM repository_identities WHERE user_id=? AND version=? AND generation=? AND permission_version=?) ON CONFLICT(user_id,repository,action) DO UPDATE SET identity_version=excluded.identity_version,identity_generation=excluded.identity_generation,permission_version=excluded.permission_version,expires_at=excluded.expires_at RETURNING user_id',
          user.id,
          key,
          capability,
          row.version,
          row.generation,
          row.permission_version,
          expires,
          user.id,
          row.version,
          row.generation,
          row.permission_version,
        );
      }
      if (!(await this.checkLease(user.id, repository, action)))
        throw new HttpError(
          403,
          'Your GitHub connection changed. Retry the request.',
        );
    });
  }
  async filteredProjects(user: User, projects?: Project[]): Promise<Project[]> {
    const candidates = projects ?? (await this.store.projects(user.id)),
      result: Project[] = [];
    const admitted = new Set(
      (
        await this.store.all(
          'SELECT project_id FROM memberships WHERE user_id=?',
          user.id,
        )
      ).map((row) => row.project_id),
    );
    for (const project of candidates) {
      if (!admitted.has(project.id)) continue;
      try {
        await this.assertRepository(user, project.repository, 'read');
        result.push(project);
      } catch (error) {
        if (
          !(error instanceof HttpError) ||
          ![401, 403].includes(error.statusCode)
        )
          throw error;
      }
    }
    const current = new Set(
      (
        await this.store.all(
          'SELECT project_id FROM memberships WHERE user_id=?',
          user.id,
        )
      ).map((row) => row.project_id),
    );
    return result.filter((project) => current.has(project.id));
  }
  async readRepository(
    user: User,
    repository: string,
    input: RepositoryRead,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const read = repositoryReadSchema.parse(input),
      key = repositoryKey(repository);
    const admitted = await this.store.one(
      "SELECT p.id FROM projects p JOIN memberships m ON m.project_id=p.id WHERE m.user_id=? AND lower(rtrim(p.repository,'/'))=? LIMIT 1",
      user.id,
      'https://github.com/' + key,
    );
    if (!admitted)
      throw new HttpError(
        403,
        'Join a repository-backed project before reading its repository data',
      );
    await this.assertRepository(user, repository, 'read');
    const row = await this.active(user.id),
      { vault } = this.requireConfigured();
    signal?.throwIfAborted();
    const path = repositoryRequestPath(key, read);
    let result: any;
    try {
      result = await this.provider(this.apiBaseUrl + path, {
        signal,
        headers: {
          ...(read.kind === 'search'
            ? { Accept: 'application/vnd.github.text-match+json' }
            : {}),
          Authorization:
            'Bearer ' + vault.open(row.access_cipher, user.id, 'access'),
        },
      });
    } catch (error) {
      if (error instanceof GithubError && error.upstreamStatus === 401)
        await this.revoke(user.id, false, row.generation);
      throw error;
    }
    signal?.throwIfAborted();
    if (
      !(await this.checkLease(user.id, repository, 'read')) ||
      !(await this.store.one(
        'SELECT project_id FROM memberships WHERE user_id=? AND project_id=?',
        user.id,
        admitted.id,
      ))
    )
      throw new HttpError(
        403,
        'Your GitHub access changed while reading repository data',
      );
    if (
      read.kind === 'file' &&
      typeof result?.size === 'number' &&
      result.size > 512000
    )
      throw new HttpError(413, 'Repository file reads are limited to 500 KB');
    if (read.kind === 'search')
      return checkedRepositorySearch(result, key, read.limit);
    if (read.kind === 'tree') {
      const schema = z
        .object({
          sha: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/),
          truncated: z.boolean().optional(),
          tree: z.array(
            z.object({
              path: z
                .string()
                .min(1)
                .max(500)
                .refine(
                  (path) =>
                    !path.startsWith('/') &&
                    !path
                      .split('/')
                      .some((part) => !part || part === '.' || part === '..') &&
                    !path.includes('\\') &&
                    !Array.from(path).some(
                      (character) =>
                        character.charCodeAt(0) < 32 ||
                        character.charCodeAt(0) === 127,
                    ),
                ),
              type: z.enum(['blob', 'tree', 'commit']),
              sha: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/),
              mode: z
                .string()
                .regex(/^[0-7]{6}$/)
                .optional(),
              size: z.number().int().nonnegative().safe().optional(),
            }),
          ),
        })
        .safeParse(result);
      if (!schema.success)
        throw new HttpError(502, 'GitHub returned an invalid repository tree');
      return {
        sha: schema.data.sha,
        truncated:
          schema.data.truncated === true || schema.data.tree.length > 1000,
        tree: schema.data.tree.slice(0, 1000),
      };
    }
    if (read.kind === 'commits') {
      if (!Array.isArray(result))
        throw new HttpError(502, 'GitHub returned invalid repository commits');
      return result.slice(0, read.limit);
    }
    return result;
  }
  private async revokeProvider(access: string) {
    const { config } = this.requireConfigured();
    await this.provider(
      this.apiBaseUrl +
        '/applications/' +
        encodeURIComponent(config.clientId) +
        '/token',
      {
        method: 'DELETE',
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(config.clientId + ':' + config.clientSecret).toString(
              'base64',
            ),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ access_token: access }),
      },
      65536,
    );
  }
  async revoke(
    userId: string,
    remote = true,
    expectedGeneration?: string,
  ): Promise<void> {
    const row = await this.store.tx(async () => {
      await this.store.lock('repository-identity:' + userId);
      const current = await this.identity(userId);
      if (expectedGeneration && current?.generation !== expectedGeneration)
        return null;
      await this.store.exec(
        'INSERT INTO repository_identity_epochs(user_id,epoch) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET epoch=excluded.epoch',
        userId,
        randomUUID(),
      );
      await this.store.exec(
        'DELETE FROM repository_identities WHERE user_id=?',
        userId,
      );
      await this.store.exec(
        'DELETE FROM identity_challenges WHERE namespace=? AND user_id=?',
        'github',
        userId,
      );
      return current;
    });
    if (remote && row && this.vault && this.config) {
      try {
        await this.revokeProvider(
          this.vault.open(row.access_cipher, userId, 'access'),
        );
      } catch {
        /* Local revocation is immediate even if the upstream is unavailable. */
      }
    }
  }

  private async invalidateUserPermissions(
    userId: string,
    expectedGeneration?: string,
  ) {
    await this.store.tx(async () => {
      await this.store.lock('repository-identity:' + userId);
      const current = await this.identity(userId);
      if (
        !current ||
        (expectedGeneration && current.generation !== expectedGeneration)
      )
        return;
      await this.store.exec(
        'UPDATE repository_identities SET permission_version=permission_version+1 WHERE user_id=?',
        userId,
      );
      await this.store.exec(
        'DELETE FROM repository_identity_leases WHERE user_id=?',
        userId,
      );
    });
  }
  private async invalidatePermissions() {
    let cursor = '';
    for (;;) {
      const users = await this.store.all(
        'SELECT user_id FROM repository_identities WHERE user_id>? ORDER BY user_id LIMIT 200',
        cursor,
      );
      if (!users.length) break;
      for (const user of users)
        await this.invalidateUserPermissions(user.user_id);
      cursor = users.at(-1)!.user_id;
    }
  }
  async routes(app: FastifyInstance) {
    app.get('/api/identity/repository', async (req) =>
      this.status(await this.auth.user(req)),
    );
    app.post('/api/identity/repository/read', async (req) => {
      await this.auth.assertOrigin(req);
      const user = await this.auth.user(req),
        body = z
          .object({
            repository: z.string().max(300),
            request: repositoryReadSchema,
          })
          .strict()
          .parse(req.body);
      return this.readRepository(user, body.repository, body.request);
    });
    app.post(
      '/api/identity/github/start',
      { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
      async (req, reply) => {
        await this.auth.assertOrigin(req);
        const user = await this.auth.user(req),
          { config, vault } = this.requireConfigured(),
          body = z
            .object({ returnTo: z.string().max(2000).default('/') })
            .strict()
            .parse(req.body ?? {});
        const target = new URL(body.returnTo, this.settings.origin);
        if (
          !body.returnTo.startsWith('/') ||
          body.returnTo.startsWith('//') ||
          target.origin !== this.settings.origin
        )
          throw new HttpError(400, 'Return to a page in this workspace');
        const session =
          req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1] ??
          req.cookies.studio_session;
        if (!session)
          throw new HttpError(401, 'Sign in before connecting GitHub');
        const state = randomBytes(32).toString('base64url'),
          binding = randomBytes(32).toString('base64url'),
          verifier = randomBytes(32).toString('base64url');
        const epoch = await this.store.one(
          'INSERT INTO repository_identity_epochs(user_id,epoch) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET epoch=repository_identity_epochs.epoch RETURNING epoch',
          user.id,
          randomUUID(),
        );
        await this.challenges.put(
          'github',
          state,
          binding,
          vault.seal(
            JSON.stringify({
              verifier,
              epoch: epoch.epoch,
              returnTo: target.pathname + target.search,
            }),
            user.id,
            'challenge:' + hash(state),
          ),
          Date.now() + 300000,
          { userId: user.id, sessionHash: hash(session) },
        );
        reply.setCookie('studio_repository_oauth', binding, {
          path: '/api/identity/github/callback',
          httpOnly: true,
          sameSite: 'lax',
          secure: this.settings.production,
          maxAge: 300,
        });
        const url = new URL(this.authorizationUrl);
        url.searchParams.set('client_id', config.clientId);
        url.searchParams.set(
          'redirect_uri',
          this.settings.origin + '/api/identity/github/callback',
        );
        url.searchParams.set('state', state);
        url.searchParams.set(
          'code_challenge',
          createHash('sha256').update(verifier).digest('base64url'),
        );
        url.searchParams.set('code_challenge_method', 'S256');
        if (config.kind === 'oauth-app')
          url.searchParams.set('scope', 'read:user repo');
        return { authorizationUrl: url.href };
      },
    );
    app.get('/api/identity/github/callback', async (req, reply) => {
      const query = z
          .object({
            state: z.string().min(20).max(512),
            code: z.string().min(1).max(4096).optional(),
            error: z.string().max(200).optional(),
          })
          .passthrough()
          .parse(req.query),
        challenge = await this.challenges.consume<string>(
          'github',
          query.state,
          req.cookies.studio_repository_oauth ?? '',
        );
      reply.clearCookie('studio_repository_oauth', {
        path: '/api/identity/github/callback',
      });
      if (!challenge?.userId || !challenge.sessionHash)
        throw new HttpError(401, 'GitHub connection expired. Start it again.');
      const userId = challenge.userId,
        sessionHash = challenge.sessionHash;
      const session = await this.store.one(
        'SELECT user_id FROM sessions WHERE token=? AND user_id=? AND expires>?',
        sessionHash,
        userId,
        Date.now(),
      );
      if (!session)
        throw new HttpError(
          401,
          'Your Studio sign-in expired before GitHub could be connected',
        );
      if (query.error || !query.code)
        throw new HttpError(403, 'GitHub authorization was not granted');
      const { vault } = this.requireConfigured(),
        payload = JSON.parse(
          vault.open(
            challenge.payload,
            userId,
            'challenge:' + hash(query.state),
          ),
        ) as { verifier: string; epoch: string; returnTo: string },
        tokens = await this.exchange({
          code: query.code,
          redirect_uri: this.settings.origin + '/api/identity/github/callback',
          code_verifier: payload.verifier,
        }),
        profile = await this.profile(tokens.access_token),
        existing = await this.identity(userId);
      if (existing && existing.github_id !== profile.id)
        throw new HttpError(
          409,
          'Disconnect the current GitHub account before connecting another',
        );
      const now = Date.now();
      try {
        await this.store.tx(async () => {
          await this.store.lock('repository-identity:' + userId);
          const currentEpoch = await this.store.one(
            'UPDATE repository_identity_epochs SET epoch=epoch WHERE user_id=? AND epoch=? RETURNING epoch',
            userId,
            payload.epoch,
          );
          const currentSession = await this.store.one(
            'UPDATE sessions SET expires=expires WHERE token=? AND user_id=? AND expires>? RETURNING user_id',
            sessionHash,
            userId,
            Date.now(),
          );
          if (!currentEpoch || !currentSession)
            throw new HttpError(
              401,
              'The connection was cancelled or your Studio session expired',
            );
          await this.store.exec(
            'INSERT INTO repository_identities(user_id,github_id,login,access_cipher,refresh_cipher,access_expires,refresh_expires,version,generation,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?) ON CONFLICT(user_id) DO UPDATE SET github_id=excluded.github_id,login=excluded.login,access_cipher=excluded.access_cipher,refresh_cipher=excluded.refresh_cipher,access_expires=excluded.access_expires,refresh_expires=excluded.refresh_expires,version=repository_identities.version+1,generation=excluded.generation,updated_at=excluded.updated_at',
            userId,
            profile.id,
            profile.login,
            vault.seal(tokens.access_token, userId, 'access'),
            tokens.refresh_token
              ? vault.seal(tokens.refresh_token, userId, 'refresh')
              : null,
            tokens.expires_in ? now + tokens.expires_in * 1000 : 0,
            tokens.refresh_token_expires_in
              ? now + tokens.refresh_token_expires_in * 1000
              : 0,
            randomUUID(),
            now,
          );
          await this.store.exec(
            'DELETE FROM repository_identity_leases WHERE user_id=?',
            userId,
          );
        });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          409,
          'This GitHub account could not be connected to this Studio account',
        );
      }

      return reply.redirect(
        new URL(payload.returnTo, this.settings.origin).href,
      );
    });
    app.delete('/api/identity/github', async (req) => {
      await this.auth.assertOrigin(req);
      const user = await this.auth.user(req);
      await this.revoke(user.id);
      return { ok: true };
    });
    await app.register(async (hook) => {
      hook.removeContentTypeParser('application/json');
      hook.addContentTypeParser(
        'application/json',
        { parseAs: 'buffer' },
        (_req, body, done) => done(null, body),
      );
      hook.post(
        '/api/auth/repository/github/webhook',
        { bodyLimit: 1_048_576 },
        async (req, reply) => {
          const secret = this.config?.webhookSecret,
            signature = req.headers['x-hub-signature-256'];
          if (
            !secret ||
            typeof signature !== 'string' ||
            !/^sha256=[a-f0-9]{64}$/.test(signature) ||
            !Buffer.isBuffer(req.body)
          )
            throw new HttpError(401, 'GitHub webhook signature is required');
          const expected = createHmac('sha256', secret)
              .update(req.body)
              .digest(),
            actual = Buffer.from(signature.slice(7), 'hex');
          if (
            actual.length !== expected.length ||
            !timingSafeEqual(actual, expected)
          )
            throw new HttpError(401, 'GitHub webhook signature is invalid');
          let payload: any;
          try {
            payload = JSON.parse(req.body.toString('utf8'));
          } catch {
            throw new HttpError(400, 'Invalid GitHub webhook');
          }
          const event = req.headers['x-github-event'];
          if (
            event === 'github_app_authorization' &&
            payload.action === 'revoked'
          ) {
            const id = numericId(payload.sender?.id);
            if (id) {
              const rows = await this.store.all(
                'SELECT user_id FROM repository_identities WHERE github_id=?',
                id,
              );
              for (const row of rows) await this.revoke(row.user_id, false);
            }
          } else if (
            [
              'member',
              'membership',
              'team',
              'repository',
              'installation',
              'installation_repositories',
              'organization',
            ].includes(String(event))
          ) {
            await this.invalidatePermissions();
          }
          return reply.code(202).send({ accepted: true });
        },
      );
    });
  }
}
export async function registerRepositoryIdentity(
  app: FastifyInstance,
  options: {
    store: IdentityStore;
    auth: IdentityAuth;
    settings: IdentitySettings;
  },
): Promise<RepositoryIdentity> {
  const service = new RepositoryIdentity(
    options.store,
    options.auth,
    options.settings,
  );
  await service.initialize();
  await service.routes(app);
  return service;
}
