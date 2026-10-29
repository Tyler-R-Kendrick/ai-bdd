import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../server/store.ts';
import { Auth, type Settings } from '../server/auth.ts';
import { Collaboration } from '../server/collaboration.ts';
import { Agent } from '../server/agent.ts';
import { researchSources } from '../server/integrations/research.ts';
import { RepositoryReader } from '../server/integrations/repository.ts';
import { integrationSettingsFromEnv } from '../server/integrations/settings.ts';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(handler: (url: string, body: any, headers: any, reply: any) => void) {
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let source = ''; for await (const part of request) source += part;
    const body = source ? JSON.parse(source) : undefined;
    requests.push({ url: request.url, body, headers: request.headers });
    response.setHeader('Content-Type', 'application/json');
    handler(request.url!, body, request.headers, response);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { base: `http://127.0.0.1:${(server.address() as any).port}`, requests, server };
}
const generated = (text: string) => ({ content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }, warnings: [] });
function workspace(integrations: any = {}) {
  const store = new Store(':memory:');
  const settings = { production: false, origin: 'http://127.0.0.1:8787', dataDir: '/tmp/studio-integration-test', demo: false, model: 'fixture/model', integrations } satisfies Settings & { integrations: any };
  const auth = new Auth(store, settings), collab = new Collaboration(store, auth), agent = new Agent(store, settings, collab);
  const user = store.createUser('owner@integration.test', 'Fixture owner', null);
  const project = store.createProject(user, 'Integration acceptance', '', '');
  const artifact = store.artifact(project.mainArtifactId, user.id);
  const threadId = store.threads(artifact.id)[0]!.id;
  cleanup.push(async () => { await agent.close(); collab.close(); store.close(); });
  return { store, settings, collab, agent, user, project, artifact, threadId };
}

describe('real HTTP agent integration boundaries', () => {
  it('uses the installed AI SDK against a real HTTP gateway and retains artifact-specific context', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'fixture-only-gateway-key');
    const gateway = await fixture((_url, _body, _headers, reply) => reply.end(JSON.stringify(generated('The selected artifact needs a reviewed rollout decision.'))));
    const w = workspace({ gatewayBaseUrl: gateway.base });
    const other = w.store.createArtifact(w.user, w.project.id, 'document', 'Other context');
    const otherThread = w.store.threads(other.id)[0]!.id;
    w.store.message(w.user, other.id, otherThread, 'Do not leak this unrelated discussion.');
    w.store.message(w.user, w.artifact.id, w.threadId, 'Review this rollout.');
    await w.agent.respond(w.user, w.artifact.id, w.threadId, 'chat');
    expect(gateway.requests[0].url).toBe('/language-model');
    expect(gateway.requests[0].headers.authorization).toContain('fixture-only-gateway-key');
    expect(JSON.stringify(gateway.requests[0].body)).not.toContain('Do not leak this unrelated discussion.');
    expect(w.store.messages(w.artifact.id).at(-1)?.body).toContain('reviewed rollout');
    expect(w.agent.jobs(w.user, w.artifact.id)[0]?.status).toBe('completed');
  });
  it('publishes research only after actual source retrieval and preserves exact brief and provenance', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'fixture-only-gateway-key');
    const gateway = await fixture((_url, _body, _headers, reply) => reply.end(JSON.stringify(generated('The retrieved source identifies a replay boundary [1]. Hypothesis: use a separate preview fixture.'))));
    const search = await fixture((_url, body, _headers, reply) => reply.end(JSON.stringify({ sources: [{ title: 'Boundary contract', url: 'https://docs.pact.io/', excerpt: `A real fixture source for ${body.query}.` }] })));
    const w = workspace({ gatewayBaseUrl: gateway.base, searchUrl: search.base });
    const brief = 'Compare contract boundaries for live preview.';
    await w.agent.respond(w.user, w.artifact.id, w.threadId, 'research', brief);
    const job = w.agent.jobs(w.user, w.artifact.id)[0]!;
    expect(job.brief).toBe(brief); expect(job.status).toBe('completed'); expect(job.childArtifactId).toBeTruthy();
    expect(search.requests[0].body).toEqual({ query: brief, limit: 8 });
    expect(search.requests[0].body).not.toHaveProperty('artifact');
    const child = w.store.artifact(job.childArtifactId!, w.user.id);
    expect(JSON.stringify(child.content)).toContain('docs.pact.io');
    expect(JSON.stringify(child.content)).toContain('SHA-256');
    expect(w.store.decisions(child.id)).toHaveLength(1); expect(w.store.threads(child.id)).toHaveLength(1);
    const saved = JSON.parse(w.store.one('SELECT sources FROM studio_agent_jobs WHERE id=?', job.id).sources);
    expect(saved[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('keeps failed research as a durable failed request without publishing a child', async () => {
    const search = await fixture((_url, _body, _headers, reply) => { reply.statusCode = 503; reply.end('{"error":"unavailable"}'); });
    const w = workspace({ searchUrl: search.base });
    await expect(w.agent.respond(w.user, w.artifact.id, w.threadId, 'research', 'Find sources.')).rejects.toThrow('configured integration');
    const job = w.agent.jobs(w.user, w.artifact.id)[0]!;
    expect(job.status).toBe('failed'); expect(job.childArtifactId).toBeNull();
    expect(w.store.artifacts(w.project.id, w.user.id)).toHaveLength(1);
  });
  it('aborts an in-flight source request when paused and records cancellation', async () => {
    const search = await fixture(() => {});
    const w = workspace({ searchUrl: search.base });
    const task = w.agent.respond(w.user, w.artifact.id, w.threadId, 'research', 'An exact cancellable brief.');
    await vi.waitFor(() => expect(search.requests).toHaveLength(1));
    w.agent.policy(w.user, w.artifact.id, { mode: 'automatic', paused: true });
    await task;
    expect(w.agent.jobs(w.user, w.artifact.id)[0]?.status).toBe('cancelled');
    expect(w.store.artifacts(w.project.id, w.user.id)).toHaveLength(1);
    expect(w.agent.active.size).toBe(0);
  });
  it('resolves stable artifact IDs after rename without including unrelated project context', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'fixture-only-gateway-key');
    const gateway = await fixture((_url, _body, _headers, reply) => reply.end(JSON.stringify(generated('Reference read.'))));
    const w = workspace({ gatewayBaseUrl: gateway.base });
    const referenced = w.store.createArtifact(w.user, w.project.id, 'document', 'Original title');
    w.store.exec('UPDATE artifacts SET title=? WHERE id=?', 'Renamed title', referenced.id);
    w.store.message(w.user, w.artifact.id, w.threadId, `Compare #artifact:${referenced.id}`);
    await w.agent.respond(w.user, w.artifact.id, w.threadId, 'chat');
    expect(JSON.stringify(gateway.requests[0].body)).toContain('Renamed title');
    expect(JSON.stringify(gateway.requests[0].body)).toContain(referenced.id);
    expect(w.store.artifact(referenced.id, w.user.id).version).toBe(1);
  });
  it('shares pause state, suppresses automatic work while paused, and rejects viewer policy writes', () => {
    const w = workspace();
    const viewer = w.store.createUser('viewer@integration.test', 'Viewer', null);
    w.store.exec('INSERT INTO memberships VALUES(?,?,?)', w.project.id, viewer.id, 'viewer');
    expect(() => w.agent.policy(viewer, w.artifact.id, { mode: 'automatic', paused: false })).toThrow('role');
    w.agent.policy(w.user, w.artifact.id, { mode: 'automatic', paused: true });
    w.store.message(w.user, w.artifact.id, w.threadId, '@studio please review');
    w.agent.observeMessage(w.user, w.artifact.id, w.threadId, '@studio please review');
    expect(w.agent.pending.size).toBe(0); expect(w.agent.policy(viewer, w.artifact.id).paused).toBe(true);
  });
});

describe('source and repository transport limits', () => {
  it('keeps search credentials at the configured gateway and hashes retrieved excerpts', async () => {
    const source = await fixture((_url, _body, headers, reply) => { expect(headers.authorization).toBe('Bearer fixture-source-token'); reply.end(JSON.stringify({ sources: [{ title: 'Fixture', url: 'https://example.test/source', excerpt: 'Retrieved fixture text.' }] })); });
    const result = await researchSources('Only this brief.', { searchUrl: source.base, searchToken: 'fixture-source-token' }, new AbortController().signal);
    expect(result[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('fixture-source-token');
  });
  it('pins repository reads to a commit and rechecks authorization after awaited responses', async () => {
    let authorized = true, calls = 0;
    const request = vi.fn(async (url: string, options: RequestInit) => {
      calls++; expect(options.redirect).toBe('error');
      if (url.includes('/commits?')) return Response.json([{ sha: 'a'.repeat(40) }]);
      if (url.includes('/contents/')) return Response.json({ type: 'file', encoding: 'base64', size: 12, content: Buffer.from('pinned text').toString('base64') });
      authorized = false; return Response.json({ tree: [] });
    });
    const reader = new RepositoryReader('https://github.com/acme/demo', { githubToken: 'private-token', githubRepositories: ['different/repo'] } as Settings, () => { if (!authorized) throw new Error('revoked'); }, new AbortController().signal, request as any);
    expect((await reader.file('src/main.ts')).revision).toBe('a'.repeat(40));
    expect(String(request.mock.calls[1]![0])).toContain(`ref=${'a'.repeat(40)}`);
    expect(request.mock.calls[0]![1].headers).not.toHaveProperty('Authorization');
    await expect(reader.tree()).rejects.toThrow('revoked'); expect(calls).toBe(3);
    await expect(reader.file('../secrets')).rejects.toThrow('relative');
  });
  it('rejects unsafe endpoint origins and executable registrations from relative paths', () => {
    expect(() => integrationSettingsFromEnv({ NODE_ENV: 'production', STUDIO_SEARCH_URL: 'http://127.0.0.1:1234' })).toThrow('HTTPS');
    expect(() => integrationSettingsFromEnv({ STUDIO_SEARCH_URL: 'https://key:secret@example.test' })).toThrow('HTTPS');
    expect(() => integrationSettingsFromEnv({ STUDIO_OPEN_DESIGN_REGISTRATION: 'relative.json' })).toThrow('absolute');
  });
});
