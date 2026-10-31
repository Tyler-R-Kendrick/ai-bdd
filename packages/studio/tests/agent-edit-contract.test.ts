import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createApp } from '../server/app.ts';
import { Store } from '../server/store.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import { artifactKinds, initialContent, type ArtifactKind } from '../shared/domain.ts';
import { client, project, setup, testSettings } from './helpers.ts';
import { ownedFreeGatewayMetadata } from './free-gateway-fixture.ts';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

/** Actual AI SDK structured generation and Agent publication, using an owned HTTP transport. */
async function fixture(responseContent: unknown) {
  vi.stubEnv('AI_GATEWAY_API_KEY', 'explicit-owned-edit-contract-fixture');
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({ summary: 'Proposed requested change.', content: responseContent }) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
      warnings: [],
    }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const data = await mkdtemp('/tmp/studio-agent-edit-contract-');
  cleanup.push(() => rm(data, { recursive: true, force: true }));
  const store = await Store.open(':memory:');
  const runtime = new DurableJobCoordinator({ store, dispatcher: { provider: 'owned-manual-edit-contract', publish: async () => ({ provider: 'owned-manual-edit-contract' }) } });
  await runtime.ready;
  const settings = { ...testSettings(data), model: 'fixture/model', integrations: {
    gatewayBaseUrl: 'http://127.0.0.1:' + (server.address() as any).port,
    gatewayMetadataFetch: ownedFreeGatewayMetadata(),
  } };
  const studio = await createApp(settings, { store, runtime, startupDispatchLimit: 0 });
  cleanup.push(() => studio.app.close());
  const signed = await setup(studio.app);
  const api = client(studio.app, signed.cookie);
  const workspace = await project(api, 'Owned edit contract');
  async function seed(kind: ArtifactKind, content = initialContent(kind, 'Format contract')) {
    const response = await api('POST', '/api/projects/' + workspace.id + '/artifacts', { kind, title: 'Format contract', content });
    expect(response.statusCode, response.body).toBe(201);
    const artifact = response.json();
    const initial = (await api('GET', '/api/artifacts/' + artifact.id)).json();
    const profile = await api('PUT', '/api/artifacts/' + artifact.id + '/agent/profile', { harness: 'vercel-fx', provider: 'ai-gateway', model: 'fixture/model' });
    expect(profile.statusCode, profile.body).toBe(200);
    return { artifact, initial, threadId: initial.threads[0].id as string };
  }
  async function edit(artifactId: string, threadId: string, brief?: string) {
    const response = await api('POST', '/api/artifacts/' + artifactId + '/agent', { threadId, intent: 'edit', ...(brief === undefined ? {} : { brief }), idempotencyKey: randomUUID() });
    expect(response.statusCode, response.body).toBe(200);
    const job = response.json();
    await runtime.executeJob(job.id, { messageId: randomUUID(), deliveryCount: 1 });
    return (await runtime.get(job.id))!;
  }
  return { studio, store, api, requests, seed, edit, setResponseContent: (content: unknown) => { responseContent = content; } };
}

describe('trusted artifact-kind edit output contract', () => {
  it('advertises code files/entry, quotes a brief-only API request, and requires human acceptance', async () => {
    const original = { files: { 'index.html': '<button style="background:blue" aria-label="Start">Start</button>', 'notes.txt': 'Retain this saved file.' }, entry: 'index.html' };
    const proposed = { files: { ...original.files, 'index.html': '<button style="background:blue" aria-label="Launch">Launch</button>' }, entry: 'index.html' };
    const w = await fixture(proposed);
    const { artifact, initial, threadId } = await w.seed('code', original);
    // The normal route accepts a brief without an existing human message.
    expect(initial.messages).toHaveLength(0);
    const brief = 'Change the visible and accessible button label to "Launch".\nPreserve its blue color and every other saved file.';
    const job = await w.edit(artifact.id, threadId, brief);
    expect(job.status).toBe('completed'); expect(job.attempt).toBe(1);
    expect(w.requests).toHaveLength(1);
    const request = w.requests[0];
    const schema = request.responseFormat.schema.properties.content;
    expect(schema.type).toBe('object'); expect(schema.required).toEqual(expect.arrayContaining(['files', 'entry']));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.files.type).toBe('object'); expect(schema.properties.files.additionalProperties.type).toBe('string');
    expect(schema.properties.entry.type).toBe('string');
    const prompt = request.prompt.flatMap((message: any) => message.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
    expect(prompt).toContain('Apply this latest human edit request'); expect(prompt).toContain(JSON.stringify(brief));
    const state = (await w.api('GET', '/api/artifacts/' + artifact.id)).json();
    expect(state.artifact).toEqual(initial.artifact); expect(state.decisions).toEqual(initial.decisions);
    const message = state.messages.find((entry: any) => entry.role === 'assistant');
    expect(message.threadId).toBe(threadId); expect(message.proposal.version).toBe(artifact.version); expect(message.proposal.content).toEqual(proposed);
    const accepted = await w.api('POST', `/api/artifacts/${artifact.id}/proposals/${message.id}/apply`, {});
    expect(accepted.statusCode, accepted.body).toBe(200);
    const after = (await w.api('GET', '/api/artifacts/' + artifact.id)).json();
    expect(after.artifact.version).toBe(artifact.version + 1); expect(after.artifact.content).toEqual(proposed);
    expect(after.decisions).toEqual(initial.decisions); expect(after.messages[0].proposal).toBe(null);
  });

  it('rejects ADR-shaped content through real SDK schema validation before checking or publishing a code proposal', async () => {
    const w = await fixture({ title: 'Unrelated ADR', context: 'Not code', decision: 'Copied metadata', consequences: '' });
    const { artifact, initial, threadId } = await w.seed('code');
    const contentCheck = vi.spyOn(w.store, 'checkedContent');
    const job = await w.edit(artifact.id, threadId, 'Update the existing code button label.');
    expect(job.status).toBe('queued'); expect(job.attempt).toBe(1);
    expect(await w.store.all("SELECT name FROM studio_job_receipts WHERE job_id=? AND name='model-output'", job.id)).toEqual([]);
    expect(w.requests).toHaveLength(1); expect(contentCheck).not.toHaveBeenCalled();
    const after = (await w.api('GET', '/api/artifacts/' + artifact.id)).json();
    expect(after.artifact).toEqual(initial.artifact); expect(after.messages).toEqual(initial.messages); expect(after.decisions).toEqual(initial.decisions);
    const cancel = await w.api('POST', '/api/artifacts/' + artifact.id + '/agent/cancel', {});
    expect(cancel.statusCode).toBe(200);
  });

  it('keeps the independent Store code-project guard after SDK shape validation', async () => {
    const w = await fixture({ files: { 'index.html': '<p>Valid declared file.</p>' }, entry: 'missing.html' });
    const { artifact, initial, threadId } = await w.seed('code');
    const contentCheck = vi.spyOn(w.store, 'checkedContent');
    const job = await w.edit(artifact.id, threadId, 'Update the code.');
    expect(job.status).toBe('failed'); expect(job.attempt).toBe(1); expect(contentCheck).toHaveBeenCalledOnce();
    expect(await w.store.all("SELECT name FROM studio_job_receipts WHERE job_id=? AND name='model-output'", job.id)).toHaveLength(1);
    expect(job.error).toMatch(/entry/i); expect(w.requests).toHaveLength(1);
    const after = (await w.api('GET', '/api/artifacts/' + artifact.id)).json();
    expect(after.artifact).toEqual(initial.artifact); expect(after.messages).toEqual(initial.messages);
    await w.api('POST', '/api/artifacts/' + artifact.id + '/agent/cancel', {});
  });

  it.each(artifactKinds.filter(kind => kind !== 'code'))('retains the existing %s content format in actual structured generation', async kind => {
    const content = initialContent(kind, 'Format contract');
    const w = await fixture(content);
    const { artifact, initial, threadId } = await w.seed(kind, content);
    // Documents receive canonical stable block IDs when initially saved.
    // The controlled transport returns those exact persisted source bytes.
    w.setResponseContent(initial.artifact.content);
    const request = 'Preserve the current format while proposing the requested review.';
    const posted = await w.api('POST', '/api/artifacts/' + artifact.id + '/messages', { threadId, body: request });
    expect(posted.statusCode, posted.body).toBe(201);
    const job = await w.edit(artifact.id, threadId);
    expect(job.status, job.error ?? undefined).toBe('completed'); expect(job.attempt).toBe(1); expect(w.requests).toHaveLength(1);
    const state = (await w.api('GET', '/api/artifacts/' + artifact.id)).json();
    expect(state.artifact).toEqual(initial.artifact); expect(state.decisions).toEqual(initial.decisions);
    const message = state.messages.find((entry: any) => entry.role === 'assistant');
    expect(message.proposal.content).toEqual(initial.artifact.content); expect(message.threadId).toBe(threadId);
    expect(JSON.stringify(w.requests[0].responseFormat.schema.properties.content)).not.toBe('{}');
    const prompt = w.requests[0].prompt.flatMap((message: any) => message.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
    expect(prompt).toContain(JSON.stringify(request));
  });
});
