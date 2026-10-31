import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../server/app.ts';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { createDurableJobRuntime } from '../server/runtime/jobs.ts';
import { createStudioMcpServer } from '../server/mcp.ts';
import { RepositoryReader } from '../server/integrations/repository.ts';
import { resolveExistingPullRequest } from '../server/integrations/pull-request-head.ts';
import { client, githubSignIn, testSettings } from './helpers.ts';
import { ownedFreeGatewayMetadata } from './free-gateway-fixture.ts';
import { githubFixture } from './identity/github-fixture.ts';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});
const privateRepository = 'https://github.com/owned-audit/private';
const publicRepository = 'https://github.com/owned-audit/public';
const operatorToken = 'owned-operator-fixture-not-a-real-credential';
const privateMarker = 'OWNED_PRIVATE_REPOSITORY_CONTENT_MUST_NOT_ESCAPE';
const tip = 'a'.repeat(40);
type Adapter = 'sqlite' | 'postgres';

async function fixture(adapter: Adapter = 'sqlite', publicRevision = false) {
  vi.stubEnv('AI_GATEWAY_API_KEY', 'owned-model-fixture-not-a-provider-account');
  const directory = await mkdtemp(join(tmpdir(), 'repository-authority-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const schema = 'repository_authority_' + randomUUID().replaceAll('-', '');
  if (adapter === 'postgres') cleanup.push(async () => {
    const pool = new Pool({ connectionString: process.env.STUDIO_TEST_POSTGRES_URL });
    try { await pool.query('DROP SCHEMA "' + schema + '" CASCADE'); }
    finally { await pool.end(); }
  });
  const store = await Store.open(adapter === 'sqlite' ? ':memory:' : await openDatabase({
    adapter, url: process.env.STUDIO_TEST_POSTGRES_URL!, schema,
  }));
  const runtime = await createDurableJobRuntime({
    store, dispatcher: { provider: 'owned-manual-fixture', publish: async () => ({ provider: 'owned-manual-fixture' }) },
  });
  const prompts: any[] = [];
  const gateway = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    prompts.push(JSON.parse(raw));
    const call = prompts.length === 1;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      content: call ? [{ type: 'tool-call', toolCallId: 'owned-file', toolName: 'repository_file', input: JSON.stringify({ path: 'src/private.ts' }) }]
        : [{ type: 'text', text: raw.includes(privateMarker) ? privateMarker : 'Repository file is unavailable to this account.' }],
      finishReason: { unified: call ? 'tool-calls' : 'stop', raw: call ? 'tool_calls' : 'stop' },
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [],
    }));
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  cleanup.push(() => new Promise<void>(resolve => { gateway.closeAllConnections(); gateway.close(() => resolve()); }));
  const modelOrigin = 'http://127.0.0.1:' + (gateway.address() as any).port;
  const repositoryRequests: { path: string; authorization: string | null }[] = [];
  const request = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === modelOrigin) return request(input, init);
    expect(url.origin, 'The owned fixture forbids unowned network requests').toBe('https://api.github.com');
    const authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization');
    repositoryRequests.push({ path: url.pathname, authorization });
    const privateData = url.pathname.includes('/private/') || url.searchParams.get('q')?.includes('repo:owned-audit/private');
    const isRevision = url.pathname.endsWith('/commits');
    if (privateData && authorization !== 'Bearer ' + operatorToken && !(publicRevision && isRevision))
      return Response.json({ message: 'Owned private repository is not accessible anonymously' }, { status: 404 });
    if (isRevision) return Response.json([{ sha: tip, commit: { message: 'Owned commit', author: { name: 'Owned fixture', date: '2026-10-31T00:00:00Z' } } }]);
    if (url.pathname.includes('/contents/')) {
      const text = privateData ? privateMarker : 'Owned public source';
      return Response.json({ type: 'file', encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') });
    }
    if (url.pathname.includes('/git/trees/')) return Response.json({ tree: [{ path: 'README.md', type: 'blob', size: 20 }] });
    if (url.pathname === '/search/code') return Response.json({ total_count: 1, items: [{ path: 'README.md', sha: tip, repository: { full_name: 'owned-audit/public' }, text_matches: [{ fragment: 'Owned public source' }] }] });
    if (url.pathname.includes('/pulls/')) {
      const repository = privateData ? privateRepository : publicRepository;
      return Response.json({ state: 'closed', merged: true, title: 'Owned pull request', body: privateData ? privateMarker : 'Public description', head: { sha: tip, ref: 'owned/branch', repo: { html_url: repository } }, base: { sha: tip, repo: { html_url: repository } } });
    }
    throw new Error('Unexpected owned GitHub fixture path');
  });
  const settings = {
    ...testSettings(directory), githubToken: operatorToken,
    githubRepositories: ['owned-audit/private', 'owned-audit/public'],
    model: 'fixture/model', integrations: { gatewayBaseUrl: modelOrigin, gatewayMetadataFetch: ownedFreeGatewayMetadata() },
  };
  const studio = await createApp(settings, { store, runtime, startupDispatchLimit: 0 });
  cleanup.push(() => studio.app.close());
  expect((await store.one('SELECT COUNT(*) AS n FROM users')).n).toBe(0);
  const actor = await githubSignIn(studio.app, 'new-repository-actor@example.test');
  const api = client(studio.app, actor.cookie);
  const create = async (repository = privateRepository) => {
    const response = await api('POST', '/api/projects', { title: 'Own repository project', description: '', repository });
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  };
  const reader = (projectId: string, repository = privateRepository) => new RepositoryReader(repository, settings, () => store.role(projectId, actor.user.id), AbortSignal.timeout(10000));
  return { studio, store, runtime, settings, actor, api, create, reader, prompts, repositoryRequests };
}

for (const adapter of ['sqlite', 'postgres'] as const) {
  it.skipIf(adapter === 'postgres' && !process.env.STUDIO_TEST_POSTGRES_URL)(`a fresh GitHub account never inherits operator repository credentials or private PR state/heads (${adapter})`, async () => {
    const w = await fixture(adapter);
    const project = await w.create();
    expect(await w.store.role(project.id, w.actor.user.id)).toBe('owner');
    expect((await w.store.one('SELECT COUNT(*) AS n FROM repository_identities')).n).toBe(0);
    const reader = w.reader(project.id);
    for (const read of [() => reader.file('src/private.ts'), () => reader.tree(), () => reader.search('owned'), () => reader.history(), () => reader.pullRequest(1)])
      await expect(read()).rejects.toMatchObject({ statusCode: 502 });
    await expect(resolveExistingPullRequest({ store: w.store, settings: w.settings }, w.actor.user, privateRepository, privateRepository + '/pull/1', AbortSignal.timeout(10000))).rejects.toMatchObject({ statusCode: 502 });
    const blank = await w.create('');
    expect((await w.api('POST', `/api/artifacts/${blank.mainArtifactId}/links`, { label: 'Private PR', url: privateRepository + '/pull/1', kind: 'pull-request' })).statusCode).toBe(200);
    const link = await w.store.one('SELECT id FROM links WHERE artifact_id=?', blank.mainArtifactId);
    const refreshed = await w.api('POST', `/api/artifacts/${blank.mainArtifactId}/links/${link.id}/refresh`);
    expect(refreshed.statusCode).toBe(502);
    expect((await w.store.one('SELECT state FROM links WHERE id=?', link.id)).state).toBe('unknown');
    expect(refreshed.body).not.toContain('owned/branch');
    expect((await w.api('GET', '/api/capabilities')).json().githubAuthenticated).toBe(false);
    expect(w.repositoryRequests.length).toBeGreaterThanOrEqual(7);
    expect(w.repositoryRequests.every(entry => entry.authorization === null)).toBe(true);
    expect(JSON.stringify(await w.store.all('SELECT body FROM messages'))).not.toContain(privateMarker);
    const direct = await w.api('POST', '/api/identity/repository/read', { repository: privateRepository, request: { kind: 'file', path: 'src/private.ts', ref: tip } });
    expect(direct.statusCode).toBe(503);
  });
}

it('keeps allowlisted and unlisted public source/PR reads anonymous, bounded and pinned', async () => {
  const w = await fixture();
  for (const listed of [true, false]) {
    w.settings.githubRepositories = listed ? ['owned-audit/public'] : [];
    const project = await w.create(publicRepository), reader = w.reader(project.id, publicRepository);
    expect((await reader.file('README.md')).text).toBe('Owned public source');
    expect((await reader.tree()).revision).toBe(tip);
    expect((await reader.search('owned')).matches[0]?.indexedSnippets).toEqual(['Owned public source']);
    expect((await reader.history()).commits[0]?.sha).toBe(tip);
    expect((await reader.pullRequest(1)).state).toBe('merged');
    expect(await resolveExistingPullRequest({ store: w.store, settings: w.settings }, w.actor.user, publicRepository, publicRepository + '/pull/1', AbortSignal.timeout(10000))).toMatchObject({ state: 'merged', branch: 'owned/branch', commit: tip });
    expect((await w.api('POST', `/api/artifacts/${project.mainArtifactId}/links`, { label: 'Public PR', url: publicRepository + '/pull/1', kind: 'pull-request' })).statusCode).toBe(200);
    const link = await w.store.one('SELECT id FROM links WHERE artifact_id=?', project.mainArtifactId);
    expect((await w.api('POST', `/api/artifacts/${project.mainArtifactId}/links/${link.id}/refresh`)).statusCode).toBe(200);
    expect((await w.store.one('SELECT state FROM links WHERE id=?', link.id)).state).toBe('merged');
  }
  expect(w.repositoryRequests.every(entry => entry.authorization === null)).toBe(true);
});

it('fences a missing personal transport and revoked local membership before any repository request', async () => {
  const w = await fixture(), project = await w.create();
  const reader = new RepositoryReader(privateRepository, { ...w.settings, repositoryIdentity: {} as any }, () => w.store.role(project.id, w.actor.user.id), AbortSignal.timeout(10000));
  await expect(reader.file('src/private.ts')).rejects.toMatchObject({ statusCode: 503 });
  await w.store.exec('DELETE FROM memberships WHERE project_id=? AND user_id=?', project.id, w.actor.user.id);
  await expect(w.reader(project.id).file('src/private.ts')).rejects.toMatchObject({ statusCode: 404 });
  expect(w.repositoryRequests).toHaveLength(0);
});

it('real MCP/API/SDK file-tool execution cannot send operator credentials or persist private source after a repository becomes private', async () => {
  // A public revision is observed before the file read loses public access.
  const w = await fixture('sqlite', true);
  const token = (await w.api('POST', '/api/tokens')).json().token;
  const server = createStudioMcpServer({ origin: w.settings.origin, token }, { fetch: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe(w.settings.origin);
    const response = await w.studio.app.inject({ method: (init?.method ?? 'GET') as any, url: url.pathname + url.search, headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.body ? { payload: String(init.body) } : {}) });
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  } });
  const [a, b] = InMemoryTransport.createLinkedPair(), mcp = new Client({ name: 'owned-repository-authority', version: '1' });
  cleanup.push(async () => { await mcp.close(); await server.close(); });
  await server.connect(a); await mcp.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp.callTool({ name, arguments: args });
    expect(result.isError).toBeUndefined();
    return JSON.parse((result.content as { text: string }[])[0]!.text);
  };
  const project = await call('studio_create_project', { title: 'MCP owned project', repository: privateRepository });
  const id = project.mainArtifactId, thread = (await w.store.threads(id))[0]!.id;
  expect((await w.api('PUT', `/api/artifacts/${id}/agent/profile`, { harness: 'vercel-fx', provider: 'ai-gateway', model: 'fixture/model' })).statusCode).toBe(200);
  await call('studio_comment', { artifactId: id, threadId: thread, body: 'Read src/private.ts from the selected repository.' });
  const job = await call('studio_request_agent', { artifactId: id, threadId: thread, intent: 'chat' });
  await w.runtime.executeJob(job.id, { messageId: 'owned-repository-authority', deliveryCount: 1 });
  expect((await w.runtime.get(job.id))?.status).toBe('completed');
  expect(w.prompts).toHaveLength(2);
  expect(w.repositoryRequests.some(entry => entry.path.endsWith('/contents/src/private.ts'))).toBe(true);
  expect(w.repositoryRequests.every(entry => entry.authorization === null)).toBe(true);
  expect(JSON.stringify(w.prompts)).not.toContain(privateMarker);
  expect(JSON.stringify(w.prompts[1])).toContain('tool-result');
  const messages = await w.store.all('SELECT body FROM messages WHERE artifact_id=?', id);
  expect(messages.some(row => row.body.includes('Repository file is unavailable'))).toBe(true);
  expect(JSON.stringify(messages)).not.toContain(privateMarker);
  expect((await w.store.one('SELECT COUNT(*) AS n FROM repository_identities')).n).toBe(0);
});

it('reports only the current user personal repository connection, preserving independent OAuth and disconnect', async () => {
  const github = await githubFixture(); cleanup.push(() => github.close());
  const directory = await mkdtemp(join(tmpdir(), 'repository-capability-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const studio = await createApp({ ...testSettings(directory), githubToken: operatorToken, githubRepositories: ['acme/private'], repositoryIdentity: {
    clientId: github.clientId, clientSecret: github.clientSecret, encryptionKey: randomBytes(32).toString('base64url'), kind: 'oauth-app',
    authorizationUrl: github.origin + '/login/oauth/authorize', tokenUrl: github.origin + '/login/oauth/access_token', apiBaseUrl: github.origin, allowLoopback: true,
  } }, { db: ':memory:', startupDispatchLimit: 0 });
  cleanup.push(() => studio.app.close());
  const first = await githubSignIn(studio.app, 'first-repository-person@example.test'), second = await githubSignIn(studio.app, 'second-repository-person@example.test');
  const a = client(studio.app, first.cookie), b = client(studio.app, second.cookie);
  expect((await a('GET', '/api/capabilities')).json().githubAuthenticated).toBe(false);
  const start = await a('POST', '/api/identity/github/start', { returnTo: '/' });
  const authorization = await fetch(start.json().authorizationUrl, { redirect: 'manual' });
  const callback = new URL(authorization.headers.get('location')!);
  const binding = start.cookies.find(value => value.name === 'studio_repository_oauth')!.value;
  expect((await studio.app.inject({ url: callback.pathname + callback.search, headers: { cookie: 'studio_repository_oauth=' + binding } })).statusCode).toBe(302);
  expect((await a('GET', '/api/capabilities')).json().githubAuthenticated).toBe(true);
  expect((await b('GET', '/api/capabilities')).json().githubAuthenticated).toBe(false);
  github.permissions.set('101:acme/private', { pull: true, push: true });
  const project = await a('POST', '/api/projects', { title: 'Authorized personal repository', repository: 'https://github.com/acme/private' });
  expect(project.statusCode).toBe(201);
  const read = { repository: 'https://github.com/acme/private', request: { kind: 'file', path: 'README.md', ref: tip } };
  expect((await a('POST', '/api/identity/repository/read', read)).statusCode).toBe(200);
  expect((await b('POST', '/api/projects', { title: 'No personal grant', repository: 'https://github.com/acme/private' })).statusCode).toBe(403);
  expect(github.requests.filter(entry => entry.path.startsWith('/repos/')).every(entry => entry.authorization === 'Bearer ' + github.lastAccess)).toBe(true);
  expect((await a('DELETE', '/api/identity/github')).statusCode).toBe(200);
  expect((await a('GET', '/api/capabilities')).json().githubAuthenticated).toBe(false);
  const before = github.requests.length;
  expect((await a('POST', '/api/identity/repository/read', read)).statusCode).toBe(403);
  expect((await a('GET', `/api/artifacts/${project.json().mainArtifactId}`)).statusCode).toBe(403);
  expect(github.requests).toHaveLength(before);
});
