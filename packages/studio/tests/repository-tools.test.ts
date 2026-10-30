import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { identityHarness } from './identity/harness.ts';
import { githubFixture } from './identity/github-fixture.ts';
import { RepositoryReader } from '../server/integrations/repository.ts';
import { repositoryReadSchema } from '../shared/identity.ts';
import { createApp } from '../server/app.ts';
import { Store, HttpError } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { createDurableJobRuntime } from '../server/runtime/jobs.ts';
import { client, setup, testSettings } from './helpers.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
const repository = 'https://github.com/acme/private',
  tip = 'a'.repeat(40);
async function workspace() {
  const h = await identityHarness();
  cleanup.push(() => h.close());
  h.fixture.permissions.set('101:acme/private', { pull: true, push: true });
  await h.connect();
  const user = h.users[0]!,
    projectId = await h.project(user);
  await h.identity.assertRepository(user, repository, 'read');
  const controller = new AbortController(),
    reader = new RepositoryReader(
      repository,
      {
        ...testSettings('/tmp/studio-read-tools'),
        repositoryIdentity: {} as any,
        githubToken: 'operator-token-must-not-be-used',
        githubRepositories: ['acme/private'],
      },
      async () => {
        if (
          !(await h.store.one(
            'SELECT role FROM memberships WHERE project_id=? AND user_id=?',
            projectId,
            user.id,
          ))
        )
          throw new HttpError(403, 'Membership revoked');
      },
      controller.signal,
      fetch,
      (input, signal) =>
        h.identity.readRepository(user, repository, input, signal),
    );
  reader.pin(tip);
  return { h, user, projectId, controller, reader };
}
describe('selected-user repository search and pinned history over actual HTTP', () => {
  it('quotes a literal search phrase, confines results to the selected repository, and labels index versus pinned source', async () => {
    const w = await workspace(),
      query = 'queue "durable" OR repo:other/private';
    const result = await w.reader.search(query, 2);
    expect(w.h.fixture.searchQueries).toHaveLength(1);
    expect(w.h.fixture.searchQueries[0]).toMatchObject({
      query: JSON.stringify(query) + ' repo:acme/private in:file',
      limit: '2',
      accept: 'application/vnd.github.text-match+json',
    });
    expect(
      w.h.fixture.requests.findLast(
        (request) => request.path === '/search/code',
      )?.authorization,
    ).toBe('Bearer ' + w.h.fixture.lastAccess);
    expect(result).toMatchObject({
      repository: 'acme/private',
      scope: 'github-indexed-default-branch',
      pinnedRevision: tip,
      matches: [
        {
          path: 'src/api.ts',
          indexedBlobSha: 'b'.repeat(40),
          indexedSnippets: ['export const queue = durable();'],
          pinnedFileUrl: `https://github.com/acme/private/blob/${tip}/src/api.ts`,
        },
      ],
    });
    expect(result.sourceNote).toContain('not evidence at the pinned');
  });
  it('reads bounded history against the frozen SHA and an encoded safe path rather than the moving default branch', async () => {
    const w = await workspace(),
      result = await w.reader.history({ path: 'src/api.ts', limit: 2 }),
      query = w.h.fixture.historyQueries.at(-1)!;
    expect(query.get('sha')).toBe(tip);
    expect(query.get('path')).toBe('src/api.ts');
    expect(query.get('per_page')).toBe('2');
    expect(result).toMatchObject({
      revision: tip,
      path: 'src/api.ts',
      commits: [
        {
          sha: tip,
          message: 'Protected fixture commit',
          author: 'Fixture author',
        },
      ],
    });
    const before = w.h.fixture.requests.length;
    await expect(
      w.reader.history({ path: '../private', limit: 2 }),
    ).rejects.toThrow();
    await expect(w.reader.history({ limit: 21 })).rejects.toThrow();
    expect(w.h.fixture.requests).toHaveLength(before);
  });
  it('bounds snippets and retains truthful truncation after the selected identity adapter projection', async () => {
    const w = await workspace();
    w.h.fixture.setSearch({
      total_count: 50,
      items: Array.from({ length: 25 }, (_, index) => ({
        path: `src/${index}.ts`,
        sha: 'b'.repeat(40),
        repository: { full_name: 'acme/private' },
        text_matches: Array.from({ length: 6 }, () => ({
          fragment: 'q'.repeat(1000),
        })),
      })),
    });
    const result = await w.reader.search('queue', 2);
    expect(result.limitReached).toBe(true);
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]!.indexedSnippets).toHaveLength(4);
    expect(result.matches[0]!.indexedSnippets[0]).toHaveLength(500);
    expect(result.matches[0]!.snippetsTruncated).toBe(true);
  });
  it('rejects cross-repository and traversal provider results before any project receives them', async () => {
    const w = await workspace();
    for (const item of [
      { path: 'src/private.ts', repository: { full_name: 'other/private' } },
      { path: '../outside', repository: { full_name: 'acme/private' } },
    ]) {
      w.h.fixture.setSearch({
        total_count: 1,
        items: [{ ...item, sha: 'b'.repeat(40) }],
      });
      await expect(w.reader.search('queue')).rejects.toMatchObject({
        statusCode: 502,
      });
    }
    expect(
      repositoryReadSchema.safeParse({ kind: 'commits', ref: 'main', limit: 2 })
        .success,
    ).toBe(false);
  });
  it('rechecks membership after the provider call and propagates a caller abort', async () => {
    const w = await workspace();
    w.h.fixture.gateSearch(async () => {
      await w.h.store.exec(
        'DELETE FROM memberships WHERE project_id=? AND user_id=?',
        w.projectId,
        w.user.id,
      );
    });
    await expect(w.reader.search('queue')).rejects.toMatchObject({
      statusCode: 403,
    });
    const second = await workspace();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    second.h.fixture.gateSearch(() => held);
    const pending = second.reader.search('queue');
    await vi.waitFor(() =>
      expect(second.h.fixture.searchQueries).toHaveLength(1),
    );
    second.controller.abort(new Error('Explicit repository caller abort'));
    await expect(pending).rejects.toThrow('Explicit repository caller abort');
    release();
  });
});
for (const adapter of ['sqlite', 'postgres'] as const)
  it.skipIf(adapter === 'postgres' && !process.env.STUDIO_TEST_POSTGRES_URL)(
    `actual SDK tool calls use the selected user search/history transport (${adapter})`,
    async () => {
      vi.stubEnv('AI_GATEWAY_API_KEY', 'explicit-repository-sdk-fixture');
      const github = await githubFixture();
      cleanup.push(() => github.close());
      github.permissions.set('101:acme/private', { pull: true, push: true });
      const prompts: any[] = [];
      let calls = 0;
      const gateway = createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        prompts.push(JSON.parse(raw));
        const tool =
          calls++ === 0
            ? 'repository_history'
            : calls === 2
              ? 'repository_search'
              : null;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            content: tool
              ? [
                  {
                    type: 'tool-call',
                    toolCallId: 'tool-' + calls,
                    toolName: tool,
                    input: JSON.stringify(
                      tool === 'repository_history'
                        ? { path: 'src/api.ts', limit: 2 }
                        : { query: 'queue', limit: 2 },
                    ),
                  },
                ]
              : [
                  {
                    type: 'text',
                    text: 'Read the pinned history and indexed search as scoped context.',
                  },
                ],
            finishReason: {
              unified: tool ? 'tool-calls' : 'stop',
              raw: tool ? 'tool_calls' : 'stop',
            },
            usage: {
              inputTokens: {
                total: 10,
                noCache: 10,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 10, text: 10, reasoning: 0 },
            },
            warnings: [],
          }),
        );
      });
      gateway.listen(0, '127.0.0.1');
      await once(gateway, 'listening');
      cleanup.push(
        () =>
          new Promise<void>((resolve) => {
            gateway.closeAllConnections();
            gateway.close(() => resolve());
          }),
      );
      const schema = 'repository_sdk_' + randomUUID().replaceAll('-', ''),
        store = await Store.open(
          adapter === 'sqlite'
            ? ':memory:'
            : await openDatabase({
                adapter: 'postgres',
                url: process.env.STUDIO_TEST_POSTGRES_URL!,
                schema,
              }),
        ),
        runtime = await createDurableJobRuntime({
          store,
          dispatcher: {
            provider: 'explicit-manual-fixture',
            publish: async () => ({ provider: 'explicit-manual-fixture' }),
          },
        });
      const studio = await createApp(
        {
          ...testSettings('/tmp/studio-repository-sdk'),
          model: 'fixture/model',
          githubToken: 'operator-must-not-be-used',
          githubRepositories: ['acme/private'],
          integrations: {
            gatewayBaseUrl: `http://127.0.0.1:${(gateway.address() as any).port}`,
          },
          repositoryIdentity: {
            clientId: github.clientId,
            clientSecret: github.clientSecret,
            encryptionKey: randomBytes(32).toString('base64url'),
            kind: 'oauth-app',
            authorizationUrl: github.origin + '/login/oauth/authorize',
            tokenUrl: github.origin + '/login/oauth/access_token',
            apiBaseUrl: github.origin,
            allowLoopback: true,
          },
        },
        { store, runtime },
      );
      cleanup.push(async () => {
        await studio.app.close();
        if (adapter === 'postgres') {
          const pool = new Pool({
            connectionString: process.env.STUDIO_TEST_POSTGRES_URL!,
          });
          try {
            await pool.query('DROP SCHEMA "' + schema + '" CASCADE');
          } finally {
            await pool.end();
          }
        }
      });
      const { user, cookie } = await setup(studio.app),
        request = client(studio.app, cookie),
        start = await request('POST', '/api/identity/github/start', {
          returnTo: '/',
        }),
        authorization = await fetch(start.json().authorizationUrl, {
          redirect: 'manual',
        }),
        callback = new URL(authorization.headers.get('location')!),
        binding = start.cookies.find(
          (cookie) => cookie.name === 'studio_repository_oauth',
        )!.value;
      expect(
        (
          await studio.app.inject({
            url: callback.pathname + callback.search,
            headers: { cookie: 'studio_repository_oauth=' + binding },
          })
        ).statusCode,
      ).toBe(302);
      await studio.identity.assertRepository(user, repository, 'write');
      const project = await studio.store.createProject(
          user,
          'Repository scoped tools',
          '',
          repository,
        ),
        id = project.mainArtifactId,
        thread = (await store.threads(id))[0]!;
      await studio.agent.profiles.view(user, id, {
        harness: 'vercel-fx',
        provider: 'ai-gateway',
        model: 'fixture/model',
      });
      await store.message(
        user,
        id,
        thread.id,
        'Read the selected repository history and code search.',
      );
      const job = await studio.agent.respond(user, id, thread.id, 'chat');
      await runtime.executeJob(job.id, {
        messageId: 'actual-sdk-tools',
        deliveryCount: 1,
      });
      expect((await runtime.get(job.id))?.status).toBe('completed');
      expect(calls).toBe(3);
      expect(
        github.historyQueries.some(
          (query) =>
            query.get('sha') === tip && query.get('path') === 'src/api.ts',
        ),
      ).toBe(true);
      expect(github.searchQueries).toHaveLength(1);
      expect(
        github.requests
          .filter(
            (request) =>
              request.path.startsWith('/repos/') ||
              request.path === '/search/code',
          )
          .every(
            (request) =>
              request.authorization === 'Bearer ' + github.lastAccess,
          ),
      ).toBe(true);
      expect(JSON.stringify(prompts[2])).toContain(
        'github-indexed-default-branch',
      );
    },
  );
