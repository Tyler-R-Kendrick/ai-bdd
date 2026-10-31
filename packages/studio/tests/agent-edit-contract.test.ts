import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
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
async function fixture(responseFields: Record<string, unknown>) {
  vi.stubEnv('AI_GATEWAY_API_KEY', 'explicit-owned-edit-contract-fixture');
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({ summary: 'Proposed requested change.', ...responseFields }) }],
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
  async function edit(artifactId: string, threadId: string, brief?: string, beforeRun?: (id: string) => Promise<void>) {
    const response = await api('POST', '/api/artifacts/' + artifactId + '/agent', { threadId, intent: 'edit', ...(brief === undefined ? {} : { brief }), idempotencyKey: randomUUID() });
    expect(response.statusCode, response.body).toBe(200);
    const job = response.json();
    await beforeRun?.(job.id);
    await runtime.executeJob(job.id, { messageId: randomUUID(), deliveryCount: 1 });
    return (await runtime.get(job.id))!;
  }
  return { studio, store, api, requests, seed, edit, setResponseContent: (content: unknown) => { responseFields = { content }; } };
}

describe('trusted artifact-kind edit output contract', () => {
  it('advertises literal code patches, preserves saved bytes, quotes a brief-only request and requires human acceptance', async () => {
    const original = { files: { 'index.html': '<button style="background:blue" aria-label="Start">Start</button>', 'notes.txt': 'Retain this saved file.\n' }, entry: 'index.html' };
    const proposed = { files: { ...original.files, 'index.html': '<button style="background:blue" aria-label="Launch">Launch</button>' }, entry: 'index.html' };
    const w = await fixture({ changes: [{ op: 'replace', path: 'index.html', find: 'Start', replacement: 'Launch' }] });
    const { artifact, initial, threadId } = await w.seed('code', original);
    // The normal route accepts a brief without an existing human message.
    expect(initial.messages).toHaveLength(0);
    const brief = 'Change the visible and accessible button label to "Launch".\nPreserve its blue color and every other saved file.';
    const job = await w.edit(artifact.id, threadId, brief);
    expect(job.status).toBe('completed'); expect(job.attempt).toBe(1);
    expect(w.requests).toHaveLength(1);
    const request = w.requests[0];
    const schema = request.responseFormat.schema;
    expect(schema.type).toBe('object'); expect(schema.required).toEqual(expect.arrayContaining(['summary', 'changes']));
    expect(schema.additionalProperties).toBe(false); expect(schema.properties.content).toBeUndefined();
    expect(schema.properties.changes.type).toBe('array');
    expect(JSON.stringify(schema.properties.changes)).toContain('replacement');
    expect(JSON.stringify(schema.properties.changes)).toContain('ALL non-overlapping');
    const operations = schema.properties.changes.items.oneOf;
    for (const operation of operations.filter((value: any) => ['replace', 'delete'].includes(value.properties.op.const)))
      expect(operation.properties.path.enum).toEqual(['index.html', 'notes.txt']);
    const createPath = operations.find((value: any) => value.properties.op.const === 'create').properties.path;
    expect(createPath.pattern).toBeDefined();
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
    const w = await fixture({ content: { title: 'Unrelated ADR', context: 'Not code', decision: 'Copied metadata', consequences: '' } });
    const { artifact, initial, threadId } = await w.seed('code');
    const contentCheck = vi.spyOn(w.store, 'checkedContent');
    const job = await w.edit(artifact.id, threadId, 'Update the existing code button label.');
    expect(job.status).toBe('queued'); expect(job.attempt).toBe(1);
    expect(await w.store.all("SELECT name FROM studio_job_receipts WHERE job_id=? AND name='model-output-code-patch-v4'", job.id)).toEqual([]);
    expect(w.requests).toHaveLength(1); expect(contentCheck).not.toHaveBeenCalled();
    const after = (await w.api('GET', '/api/artifacts/' + artifact.id)).json();
    expect(after.artifact).toEqual(initial.artifact); expect(after.messages).toEqual(initial.messages); expect(after.decisions).toEqual(initial.decisions);
    const cancel = await w.api('POST', '/api/artifacts/' + artifact.id + '/agent/cancel', {});
    expect(cancel.statusCode).toBe(200);
  });

  it('keeps the independent Store code-project guard after literal reconstruction', async () => {
    const w = await fixture({ changes: [{ op: 'replace', path: 'index.html', find: 'It works.', replacement: 'Ready.' }] });
    const original = { files: { 'index.html': '<p>It works.</p>' }, entry: 'index.html' };
    const { artifact, initial, threadId } = await w.seed('code', original);
    const contentCheck = vi.spyOn(w.store, 'checkedContent').mockRejectedValueOnce(new Error('Independent source guard refused publication'));
    const job = await w.edit(artifact.id, threadId, 'Update the code.');
    expect(job.status).toBe('queued'); expect(job.attempt).toBe(1); expect(contentCheck).toHaveBeenCalledOnce();
    expect(await w.store.all("SELECT name FROM studio_job_receipts WHERE job_id=? AND name='model-output-code-patch-v4'", job.id)).toHaveLength(1);
    expect(w.requests).toHaveLength(1);
    const after = (await w.api('GET', '/api/artifacts/' + artifact.id)).json();
    expect(after.artifact).toEqual(initial.artifact); expect(after.messages).toEqual(initial.messages);
    await w.api('POST', '/api/artifacts/' + artifact.id + '/agent/cancel', {});
  });

  it('retains untouched source bytes when actual SDK output includes a validated absent identity replacement', async () => {
    const original = { files: { 'main.html': '<p>Before</p>\n', 'keep.txt': 'Exact trailing newline.\n' }, entry: 'main.html' };
    const expected = { ...original, files: { ...original.files, 'main.html': '<p>After</p>\n' } };
    const w = await fixture({ changes: [
      { op: 'replace', path: 'main.html', find: 'Before', replacement: 'After' },
      { op: 'replace', path: 'keep.txt', find: 'An absent literal', replacement: 'An absent literal' },
    ] });
    const { artifact, initial, threadId } = await w.seed('code', original);
    const contentCheck = vi.spyOn(w.store, 'checkedContent');
    const job = await w.edit(artifact.id, threadId, 'Update the existing paragraph.');
    expect(job.status).toBe('completed'); expect(w.requests).toHaveLength(1); expect(contentCheck).toHaveBeenCalledOnce();
    const state = (await w.api('GET', '/api/artifacts/' + artifact.id)).json();
    expect(state.artifact).toEqual(initial.artifact); expect(state.decisions).toEqual(initial.decisions);
    const message = state.messages.find((entry: any) => entry.role === 'assistant');
    expect(message.threadId).toBe(threadId); expect(message.proposal.content).toEqual(expected);
    expect((await w.api('POST', `/api/artifacts/${artifact.id}/proposals/${message.id}/apply`, {})).statusCode).toBe(200);
    const applied = (await w.api('GET', '/api/artifacts/' + artifact.id)).json();
    expect(applied.artifact.content).toEqual(expected); expect(applied.artifact.version).toBe(artifact.version + 1); expect(applied.decisions).toEqual(initial.decisions);
  });

  it.each([
    [{ op: 'replace', path: 'index.html', find: 'absent', replacement: 'new' }],
    [{ op: 'replace', path: 'missing.html', find: 'Start', replacement: 'Launch' }],
    [{ op: 'create', path: '/tmp/escape.js', content: '' }],
    [{ op: 'create', path: 'index.html', content: 'regenerated' }],
    [{ op: 'delete', path: 'index.html' }],
    [{ op: 'replace', path: 'index.html', find: 'Start', replacement: 'Launch' }, { op: 'delete', path: 'index.html' }],
  ].map((changes, index) => ({ changes, terminal: [0, 4, 5].includes(index), calls: [0, 5].includes(index) ? 2 : 1 })))('refuses invalid or contradictory patch %# before proposal/source changes', async ({ changes, terminal, calls }) => {
    const w = await fixture({ changes });
    const original = { files: { 'index.html': '<button>Start</button>\n', 'notes.txt': 'untouched\n' }, entry: 'index.html' };
    const { artifact, initial, threadId } = await w.seed('code', original);
    const contentCheck = vi.spyOn(w.store, 'checkedContent');
    const job = await w.edit(artifact.id, threadId, 'Update the code.');
    expect(job.status).toBe(terminal ? 'failed' : 'queued'); expect(job.attempt).toBe(1); expect(contentCheck).not.toHaveBeenCalled(); expect(w.requests).toHaveLength(calls);
    const after = (await w.api('GET', '/api/artifacts/' + artifact.id)).json();
    expect(after.artifact).toEqual(initial.artifact); expect(after.messages).toEqual(initial.messages); expect(after.decisions).toEqual(initial.decisions);
    await w.api('POST', '/api/artifacts/' + artifact.id + '/agent/cancel', {});
  });

  it('applies multiple same-file replacements literally and refuses a stale proposal version', async () => {
    const replacement = '$&\\$`';
    const original = { files: { 'index.html': '<p>first second</p>\n', 'notes.txt': 'exact trailing newline\n' }, entry: 'index.html' };
    const w = await fixture({ changes: [
      { op: 'replace', path: 'index.html', find: 'first', replacement },
      { op: 'replace', path: 'index.html', find: 'second', replacement: 'later' },
    ] });
    const { artifact, initial, threadId } = await w.seed('code', original);
    expect((await w.edit(artifact.id, threadId, 'Make two literal edits.')).status).toBe('completed');
    const state = (await w.api('GET', '/api/artifacts/' + artifact.id)).json();
    const proposal = state.messages.find((entry: any) => entry.role === 'assistant');
    expect(proposal.proposal.content).toEqual({ ...original, files: { ...original.files, 'index.html': '<p>' + replacement + ' later</p>\n' } });
    expect(state.artifact).toEqual(initial.artifact);
    const newer = { ...original, files: { ...original.files, 'notes.txt': 'A newer owner edit.\n' } };
    expect((await w.api('PATCH', '/api/artifacts/' + artifact.id, { version: artifact.version, content: newer })).statusCode).toBe(200);
    const applied = await w.api('POST', `/api/artifacts/${artifact.id}/proposals/${proposal.id}/apply`, {});
    expect(applied.statusCode).toBe(409);
    const after = (await w.api('GET', '/api/artifacts/' + artifact.id)).json();
    expect(after.artifact.version).toBe(artifact.version + 1); expect(after.artifact.content).toEqual(newer);
  });

  it.each(['model-output', 'model-output-code-patch-v1', 'model-output-code-patch-v2', 'model-output-code-patch-v3'])('does not reuse the %s receipt for the source-bound code-patch contract', async oldStep => {
    const original = { files: { 'index.html': '<button>Start</button>\n' }, entry: 'index.html' };
    const w = await fixture({ changes: [{ op: 'replace', path: 'index.html', find: 'Start', replacement: 'Launch' }] });
    const { artifact, threadId } = await w.seed('code', original);
    const old = JSON.stringify({ text: 'Stale full-content output', content: original });
    const job = await w.edit(artifact.id, threadId, 'Update the label.', async id => {
      await w.store.exec('INSERT INTO studio_job_receipts(job_id,name,phase,value_json,value_sha256,created_at) VALUES(?,?,?,?,?,?)', id, oldStep, 'step', old, createHash('sha256').update(old).digest('hex'), new Date().toISOString());
    });
    expect(job.status).toBe('completed'); expect(w.requests).toHaveLength(1);
    expect((await w.store.one('SELECT value_json FROM studio_job_receipts WHERE job_id=? AND name=?', job.id, oldStep)).value_json).toBe(old);
    expect(await w.store.all("SELECT name FROM studio_job_receipts WHERE job_id=? AND name='model-output-code-patch-v4'", job.id)).toHaveLength(1);
    const state = (await w.api('GET', '/api/artifacts/' + artifact.id)).json();
    expect(state.artifact.content).toEqual(original);
    expect(state.messages[0].proposal.content.files['index.html']).toBe('<button>Launch</button>\n');
  });

  it('advertises only each selected artifact\'s saved filenames across actual SDK requests', async () => {
    const fields = { changes: [{ op: 'replace', path: 'first.html', find: 'Before', replacement: 'After' }] };
    const w = await fixture(fields);
    const first = await w.seed('code', { files: { 'first.html': '<p>Before</p>', 'first-notes.txt': 'private first context' }, entry: 'first.html' });
    expect((await w.edit(first.artifact.id, first.threadId, 'Update the paragraph.')).status).toBe('completed');
    fields.changes[0]!.path = 'second.html';
    const second = await w.seed('code', { files: { 'second.html': '<p>Before</p>', 'second-notes.txt': 'private second context' }, entry: 'second.html' });
    expect((await w.edit(second.artifact.id, second.threadId, 'Update the paragraph.')).status).toBe('completed');
    expect(w.requests).toHaveLength(2);
    for (const [index, names] of [['first.html', 'first-notes.txt'], ['second.html', 'second-notes.txt']].entries()) {
      const schema = w.requests[index].responseFormat.schema;
      for (const operation of schema.properties.changes.items.oneOf.filter((value: any) => ['replace', 'delete'].includes(value.properties.op.const)))
        expect(operation.properties.path.enum).toEqual(names);
      expect(JSON.stringify(schema)).not.toContain(index ? 'first.html' : 'second.html');
    }
  });

  it.each(artifactKinds.filter(kind => kind !== 'code'))('retains the existing %s content format in actual structured generation', async kind => {
    const content = initialContent(kind, 'Format contract');
    const w = await fixture({ content });
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
