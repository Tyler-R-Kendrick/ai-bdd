import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../server/store.ts';
import { resolveExistingPullRequest } from '../server/integrations/pull-request-head.ts';
import { testSettings } from './helpers.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const store = await Store.open(':memory:');
  cleanup.push(() => store.close());
  const user = await store.createUser('head-owner@example.test', 'Owner', null),
    repository = 'https://github.com/example/living',
    project = await store.createProject(user, 'Living source', '', repository),
    requests: any[] = [];
  let fork = false,
    beforeReply: (() => Promise<void>) | undefined;
  const server = createServer(async (req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    await beforeReply?.();
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        state: 'open',
        head: {
          ref: 'feature/existing',
          sha: 'b'.repeat(40),
          repo: {
            html_url: fork ? 'https://github.com/other/fork' : repository,
          },
        },
        base: { sha: 'a'.repeat(40), repo: { html_url: repository } },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const options = {
    store,
    settings: {
      ...testSettings('/tmp/studio-existing-pr'),
      githubToken: 'operator-must-not-be-used',
      repositoryIdentity: {} as any,
    },
    repositoryRead: async (
      _user: any,
      _repository: string,
      input: any,
      signal: AbortSignal,
    ) => {
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as any).port}/repos/example/living/pulls/${input.number}`,
        { headers: { Authorization: 'Bearer selected-user-fixture' }, signal },
      );
      return response.json();
    },
  };
  return {
    store,
    user,
    repository,
    project,
    requests,
    options,
    setFork: () => {
      fork = true;
    },
    beforeReply: (callback: () => Promise<void>) => {
      beforeReply = callback;
    },
  };
}
describe('existing pull request rebuild target resolution', () => {
  it('uses the selected user reader and actual provider head instead of any connector branch assertion', async () => {
    const w = await fixture(),
      result = await resolveExistingPullRequest(
        w.options,
        w.user,
        w.repository,
        w.repository + '/pull/7',
        AbortSignal.timeout(3000),
      );
    expect(result).toEqual({
      url: w.repository + '/pull/7',
      repository: w.repository,
      state: 'open',
      branch: 'feature/existing',
      commit: 'b'.repeat(40),
    });
    expect(w.requests).toEqual([
      {
        url: '/repos/example/living/pulls/7',
        authorization: 'Bearer selected-user-fixture',
      },
    ]);
  });
  it('rejects a fork head and another repository URL before exposing a rebuild target', async () => {
    const w = await fixture();
    w.setFork();
    await expect(
      resolveExistingPullRequest(
        w.options,
        w.user,
        w.repository,
        w.repository + '/pull/7',
        AbortSignal.timeout(3000),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      resolveExistingPullRequest(
        w.options,
        w.user,
        w.repository,
        'https://github.com/other/fork/pull/7',
        AbortSignal.timeout(3000),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(w.requests).toHaveLength(1);
  });
  it('fences repository membership revoked during the actual provider read', async () => {
    const w = await fixture();
    w.beforeReply(() =>
      w.store.tx(async () => {
        await w.store.lock('project:' + w.project.id);
        await w.store.exec(
          'DELETE FROM memberships WHERE project_id=? AND user_id=?',
          w.project.id,
          w.user.id,
        );
      }),
    );
    await expect(
      resolveExistingPullRequest(
        w.options,
        w.user,
        w.repository,
        w.repository + '/pull/7',
        AbortSignal.timeout(3000),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  it('fails closed when verified identity is configured without its reader, even with an operator token', async () => {
    const w = await fixture();
    await expect(
      resolveExistingPullRequest(
        { ...w.options, repositoryRead: undefined },
        w.user,
        w.repository,
        w.repository + '/pull/7',
        AbortSignal.timeout(3000),
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(w.requests).toHaveLength(0);
  });
});
