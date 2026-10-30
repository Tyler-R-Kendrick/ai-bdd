import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../server/store.ts';
import { type Settings } from '../server/auth.ts';
import { Collaboration } from '../server/collaboration.ts';
import { Agent } from '../server/agent.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import { researchSources } from '../server/integrations/research.ts';
import { RepositoryReader } from '../server/integrations/repository.ts';
import { integrationSettingsFromEnv } from '../server/integrations/settings.ts';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  handler: (url: string, body: any, headers: any, reply: any) => void,
) {
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let source = '';
    for await (const part of request) source += part;
    const body = source ? JSON.parse(source) : undefined;
    requests.push({ url: request.url, body, headers: request.headers });
    response.setHeader('Content-Type', 'application/json');
    handler(request.url!, body, request.headers, response);
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
  return {
    base: `http://127.0.0.1:${(server.address() as any).port}`,
    requests,
    server,
  };
}
// Model transport, research publication and restart acceptance live in agent-durable.test.ts.
async function workspace() {
  const store = await Store.open(':memory:');
  const settings = {
    production: false,
    origin: 'http://127.0.0.1:8787',
    dataDir: '/tmp/studio-integration-test',
    demo: false,
    model: 'fixture/model',
  } satisfies Settings;
  const collab = new Collaboration(store, { settings } as any);
  await collab.initialize();
  const runtime = new DurableJobCoordinator({
    store,
    dispatcher: {
      provider: 'explicit-test-dispatch',
      publish: async () => ({ provider: 'explicit-test-dispatch' }),
    },
  });
  await runtime.ready;
  const agent = new Agent(store, settings, collab, { runtime });
  await agent.initialize();
  const user = await store.createUser(
      'owner@integration.test',
      'Fixture owner',
      null,
    ),
    project = await store.createProject(user, 'Integration acceptance', '');
  const artifact = await store.artifact(project.mainArtifactId, user.id),
    threadId = (await store.threads(artifact.id))[0]!.id;
  cleanup.push(async () => {
    await runtime.close();
    await collab.close();
    await store.close();
  });
  return {
    store,
    settings,
    collab,
    runtime,
    agent,
    user,
    project,
    artifact,
    threadId,
  };
}
describe('shared artifact policy boundary', () => {
  it('shares pause across principals and rejects viewer policy writes', async () => {
    const w = await workspace(),
      viewer = await w.store.createUser(
        'viewer@integration.test',
        'Viewer',
        null,
      );
    await w.store.exec(
      'INSERT INTO memberships VALUES(?,?,?)',
      w.project.id,
      viewer.id,
      'viewer',
    );
    await expect(
      w.agent.policy(viewer, w.artifact.id, {
        mode: 'automatic',
        paused: false,
      }),
    ).rejects.toThrow('role');
    await w.agent.policy(w.user, w.artifact.id, {
      mode: 'automatic',
      paused: true,
    });
    await w.store.message(
      w.user,
      w.artifact.id,
      w.threadId,
      '@studio please review',
    );
    await w.agent.observeMessage(
      w.user,
      w.artifact.id,
      w.threadId,
      '@studio please review',
    );
    expect(await w.agent.isActive(w.artifact.id)).toBe(false);
    expect((await w.agent.policy(viewer, w.artifact.id)).paused).toBe(true);
  });
  it('retains reviewed proposals separately from the canonical artifact source', async () => {
    const w = await workspace();
    const artifact = await w.store.createArtifact(
      w.user,
      w.project.id,
      'code',
      'Review target',
    );
    const thread = (await w.store.threads(artifact.id))[0]!.id;
    await w.store.message(
      w.user,
      artifact.id,
      thread,
      'Review this exact change.',
      'assistant',
      {
        version: artifact.version,
        content: {
          files: { 'index.html': '<h1>Proposal only</h1>' },
          entry: 'index.html',
        },
      },
    );
    expect((await w.store.artifact(artifact.id, w.user.id)).content).toEqual(
      artifact.content,
    );
    expect((await w.store.messages(artifact.id))[0]?.proposal?.version).toBe(
      artifact.version,
    );
  });
});

describe('source and repository transport limits', () => {
  it('keeps search credentials at the configured gateway and hashes retrieved excerpts', async () => {
    const source = await fixture((_url, _body, headers, reply) => {
      expect(headers.authorization).toBe('Bearer fixture-source-token');
      reply.end(
        JSON.stringify({
          sources: [
            {
              title: 'Fixture',
              url: 'https://example.test/source',
              excerpt: 'Retrieved fixture text.',
            },
          ],
        }),
      );
    });
    const result = await researchSources(
      'Only this brief.',
      { searchUrl: source.base, searchToken: 'fixture-source-token' },
      new AbortController().signal,
    );
    expect(result[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('fixture-source-token');
  });
  it('pins repository reads to a commit and rechecks authorization after awaited responses', async () => {
    let authorized = true,
      calls = 0;
    const request = vi.fn(async (url: string, options: RequestInit) => {
      calls++;
      expect(options.redirect).toBe('error');
      if (url.includes('/commits?'))
        return Response.json([{ sha: 'a'.repeat(40) }]);
      if (url.includes('/contents/'))
        return Response.json({
          type: 'file',
          encoding: 'base64',
          size: 12,
          content: Buffer.from('pinned text').toString('base64'),
        });
      authorized = false;
      return Response.json({ tree: [] });
    });
    const reader = new RepositoryReader(
      'https://github.com/acme/demo',
      {
        githubToken: 'private-token',
        githubRepositories: ['different/repo'],
      } as Settings,
      () => {
        if (!authorized) throw new Error('revoked');
      },
      new AbortController().signal,
      request as any,
    );
    expect((await reader.file('src/main.ts')).revision).toBe('a'.repeat(40));
    expect(String(request.mock.calls[1]![0])).toContain(
      `ref=${'a'.repeat(40)}`,
    );
    expect(request.mock.calls[0]![1].headers).not.toHaveProperty(
      'Authorization',
    );
    await expect(reader.tree()).rejects.toThrow('revoked');
    expect(calls).toBe(3);
    await expect(reader.file('../secrets')).rejects.toThrow('relative');
  });
  it('rejects unsafe endpoint origins and executable registrations from relative paths', () => {
    expect(() =>
      integrationSettingsFromEnv({
        NODE_ENV: 'production',
        STUDIO_SEARCH_URL: 'http://127.0.0.1:1234',
      }),
    ).toThrow('HTTPS');
    expect(() =>
      integrationSettingsFromEnv({
        STUDIO_SEARCH_URL: 'https://key:secret@example.test',
      }),
    ).toThrow('HTTPS');
    expect(() =>
      integrationSettingsFromEnv({
        STUDIO_OPEN_DESIGN_REGISTRATION: 'relative.json',
      }),
    ).toThrow('absolute');
  });
});
