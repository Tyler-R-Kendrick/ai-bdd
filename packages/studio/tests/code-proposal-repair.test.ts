import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { Store } from '../server/store.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import { LocalModelError } from '../server/local/model.ts';
import { client, project, setup, testSettings } from './helpers.ts';
import { ownedFreeGatewayMetadata } from './free-gateway-fixture.ts';

const original = { files: { 'page.html': '<p>Before</p>\n', 'saved.txt': 'Original bytes.\n' }, entry: 'page.html' };
const valid = { summary: 'Requested edit.', changes: [{ op: 'replace', path: 'page.html', find: 'Before', replacement: 'After' }] };
const invalid = { summary: 'Attempted edit.', changes: [{ op: 'replace', path: 'page.html', find: 'missing literal', replacement: 'After' }] };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });

async function fixture(plans: unknown[]) {
  vi.stubEnv('AI_GATEWAY_API_KEY', 'owned-proposal-repair-fixture');
  const requests: { body: any; headers: any }[] = [];
  const fixtureErrors: unknown[] = [];
  let beforeResponse: ((round: number) => Promise<void>) | undefined;
  let refusal = false;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    requests.push({ body: JSON.parse(body), headers: request.headers });
    try { await beforeResponse?.(requests.length); }
    catch (error) { fixtureErrors.push(error); response.statusCode = 500; response.end('{}'); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ content: refusal ? [] : [{ type: 'text', text: JSON.stringify(plans[Math.min(requests.length - 1, plans.length - 1)]) }],
      finishReason: { unified: refusal ? 'content-filter' : 'stop', raw: refusal ? 'content-filter' : 'stop' },
      usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }, warnings: [] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const data = await mkdtemp('/tmp/studio-code-repair-'); cleanup.push(() => rm(data, { recursive: true, force: true }));
  let store = await Store.open(join(data, 'studio.sqlite'));
  const runtimeFor = (value: Store) => new DurableJobCoordinator({ store: value, dispatcher: { provider: 'owned-manual-repair', publish: async () => ({ provider: 'owned-manual-repair' }) } });
  let runtime = runtimeFor(store);
  await runtime.ready;
  const settings = { ...testSettings(data), model: 'fixture/model', integrations: {
    gatewayBaseUrl: 'http://127.0.0.1:' + (server.address() as any).port, gatewayMetadataFetch: ownedFreeGatewayMetadata(),
  } };
  let studio = await createApp(settings, { store, runtime, startupDispatchLimit: 0 });
  cleanup.push(() => studio.app.close());
  const signed = await setup(studio.app);
  let currentApi = client(studio.app, signed.cookie);
  const api: ReturnType<typeof client> = (...args) => currentApi(...args);
  const workspace = await project(api, 'Owned code repair');
  const created = await api('POST', '/api/projects/' + workspace.id + '/artifacts', { kind: 'code', title: 'Saved code', content: original });
  const artifact = created.json(), initial = (await api('GET', '/api/artifacts/' + artifact.id)).json(), threadId = initial.threads[0].id;
  const profile = { harness: 'vercel-fx', provider: 'ai-gateway', model: 'fixture/model' };
  expect((await api('PUT', '/api/artifacts/' + artifact.id + '/agent/profile', profile)).statusCode).toBe(200);
  async function admit() {
    const result = await api('POST', '/api/artifacts/' + artifact.id + '/agent', { threadId, intent: 'edit', brief: 'Update the paragraph while preserving all other saved bytes.', idempotencyKey: randomUUID() });
    expect(result.statusCode, result.body).toBe(200); return result.json().id as string;
  }
  const execute = async (id: string) => { await runtime.executeJob(id, { messageId: randomUUID(), deliveryCount: 1 }); expect(fixtureErrors).toEqual([]); };
  const state = async () => (await api('GET', '/api/artifacts/' + artifact.id)).json();
  async function restart() {
    await studio.app.close();
    store = await Store.open(join(data, 'studio.sqlite')); runtime = runtimeFor(store); await runtime.ready;
    studio = await createApp(settings, { store, runtime, startupDispatchLimit: 0 });
    currentApi = client(studio.app, signed.cookie);
  }
  return { api, get store() { return store; }, get runtime() { return runtime; }, get studio() { return studio; }, signed, artifact, initial, threadId, profile, requests, admit, execute, state, restart,
    beforeResponse: (fn: (round: number) => Promise<void>) => { beforeResponse = fn; }, refuse: () => { refusal = true; } };
}
function promptText(body: any) { return body.prompt.flatMap((message: any) => message.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n'); }
async function unchanged(w: Awaited<ReturnType<typeof fixture>>) {
  const state = await w.state(); expect(state.artifact).toEqual(w.initial.artifact); expect(state.decisions).toEqual(w.initial.decisions); expect(state.messages).toEqual(w.initial.messages);
}

describe('bounded explicit code-proposal repair through actual SDK and durable Agent', () => {
  it('uses trusted mechanical feedback, separate model/header keys and one captured profile before owner application', async () => {
    const w = await fixture([invalid, valid]);
    w.beforeResponse(async round => {
      if (round === 1) expect((await w.api('PUT', '/api/artifacts/' + w.artifact.id + '/agent/profile', { harness: 'local-cpu', provider: 'llama-cpp-cpu', model: 'qwen2.5-0.5b-instruct-q4-k-m' })).statusCode).toBe(200);
      if (round === 2) await unchanged(w);
    });
    const model = vi.spyOn(w.studio.agent as any, 'model');
    const id = await w.admit(); await w.execute(id);
    const job = (await w.runtime.get(id))!; expect(job.status).toBe('completed'); expect(job.attempt).toBe(1);
    expect(w.requests).toHaveLength(2); expect(model).toHaveBeenCalledTimes(2);
    const first = promptText(w.requests[0].body), second = promptText(w.requests[1].body);
    expect(second.startsWith(first)).toBe(true);
    expect(second).toContain('"reason":"missing-literal"'); expect(second).toContain('"operationIndex":0'); expect(second).toContain('"path":"page.html"');
    const messages = w.requests[1].body.prompt;
    expect(messages.map((message: any) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[1].content[0].text).toBe(w.requests[0].body.prompt[1].content[0].text);
    expect(messages[2].content[0].text).toBe(JSON.stringify(invalid));
    expect(messages[3].content[0].text).toContain('untrusted model output');
    expect(second).toContain('ORIGINAL saved source');
    const keys = model.mock.calls.map(call => call[1]); expect(new Set(keys).size).toBe(2);
    expect(keys).toEqual([id + ':code-proposal.v4.round-1', id + ':code-proposal.v4.round-2']);
    expect(w.requests.map(request => request.headers['idempotency-key'])).toEqual(keys);
    expect(model.mock.calls.every(call => JSON.stringify(call[0]) === JSON.stringify(w.profile))).toBe(true);
    const state = await w.state(); expect(state.artifact).toEqual(w.initial.artifact); expect(state.decisions).toEqual(w.initial.decisions);
    const proposal = state.messages[0]; expect(proposal.proposal.content).toEqual({ ...original, files: { ...original.files, 'page.html': '<p>After</p>\n' } });
    expect((await w.api('POST', `/api/artifacts/${w.artifact.id}/proposals/${proposal.id}/apply`, {})).statusCode).toBe(200);
    expect((await w.state()).artifact.version).toBe(w.artifact.version + 1);
    await w.execute(id); expect(w.requests).toHaveLength(2);
  });

  it('fails terminally after two invalid typed plans without a third generation or publication', async () => {
    const w = await fixture([invalid, invalid]), id = await w.admit();
    await w.execute(id); expect((await w.runtime.get(id))!.status).toBe('failed'); expect(w.requests).toHaveLength(2);
    await unchanged(w); await w.execute(id); expect(w.requests).toHaveLength(2);
    expect(await w.store.all("SELECT name FROM studio_job_receipts WHERE job_id=? AND name LIKE 'code-proposal.v4.round-%'", id)).toHaveLength(2);
  });

  it('does not push a second plan when the model proposes no change', async () => {
    const w = await fixture([{ summary: 'No change proposed.', changes: [] }, valid]), id = await w.admit();
    await w.execute(id); expect((await w.runtime.get(id))!.status).toBe('failed'); expect(w.requests).toHaveLength(1); await unchanged(w);
  });

  it('bounds prior-plan assistant text without re-encoding or interpreting its strings', async () => {
    const long = { ...invalid, summary: 'Untrusted previous text. '.repeat(400) };
    const w = await fixture([long, valid]), id = await w.admit(); await w.execute(id);
    expect((await w.runtime.get(id))!.status).toBe('completed');
    const assistant = w.requests[1].body.prompt.find((message: any) => message.role === 'assistant').content[0].text;
    expect(assistant.length).toBeLessThanOrEqual(8000); expect(assistant).toContain('Previous plan truncated');
    expect(assistant.startsWith(JSON.stringify(long).slice(0, 100))).toBe(true);
  });

  it('reuses both completed round receipts after closing and reopening the app, and reconstructs cached output again', async () => {
    const w = await fixture([invalid, valid]);
    vi.spyOn(w.store, 'checkedContent').mockRejectedValueOnce(new Error('Owned publication interruption'));
    const id = await w.admit(); await w.execute(id);
    expect((await w.runtime.get(id))!.status).toBe('queued'); expect(w.requests).toHaveLength(2); await unchanged(w);
    expect(await w.store.all("SELECT name FROM studio_job_receipts WHERE job_id=? AND name LIKE 'code-proposal.v4.round-%'", id)).toHaveLength(2);
    const saved = await w.store.one("SELECT value_json FROM studio_job_receipts WHERE job_id=? AND name='model-output-code-patch-v4'", id);
    const output = JSON.parse(saved.value_json); output.content = { files: { 'page.html': 'Untrusted cached content' }, entry: 'page.html' };
    const json = JSON.stringify(output);
    await w.store.exec("UPDATE studio_job_receipts SET value_json=?,value_sha256=? WHERE job_id=? AND name='model-output-code-patch-v4'", json, createHash('sha256').update(json).digest('hex'), id);
    await w.restart(); await w.store.exec('UPDATE studio_durable_jobs SET available_at=0 WHERE id=?', id); await w.execute(id);
    expect((await w.runtime.get(id))!.status).toBe('completed'); expect(w.requests).toHaveLength(2);
    expect((await w.state()).messages[0].proposal.content).toEqual({ ...original, files: { ...original.files, 'page.html': '<p>After</p>\n' } });
  });

  it('validates a cached raw first-round plan instead of treating its receipt as a complete proposal', async () => {
    const w = await fixture([valid]), id = await w.admit(), json = JSON.stringify(invalid);
    await w.store.exec('INSERT INTO studio_job_receipts(job_id,name,phase,value_json,value_sha256,created_at) VALUES(?,?,?,?,?,?)', id, 'code-proposal.v4.round-1', 'step', json, createHash('sha256').update(json).digest('hex'), new Date().toISOString());
    await w.restart(); await w.execute(id);
    expect((await w.runtime.get(id))!.status).toBe('completed'); expect(w.requests).toHaveLength(1);
    expect(w.requests[0].headers['idempotency-key']).toBe(id + ':code-proposal.v4.round-2');
    expect(w.requests[0].body.prompt.find((message: any) => message.role === 'assistant').content[0].text).toBe(json);
  });

  it('rejects an invalid selected raw plan in a cached outer receipt without another generation', async () => {
    const w = await fixture([valid]), id = await w.admit();
    const output = JSON.stringify({ text: 'Old output', content: original, codePlan: invalid });
    await w.store.exec('INSERT INTO studio_job_receipts(job_id,name,phase,value_json,value_sha256,created_at) VALUES(?,?,?,?,?,?)', id, 'model-output-code-patch-v4', 'step', output, createHash('sha256').update(output).digest('hex'), new Date().toISOString());
    await w.execute(id); expect((await w.runtime.get(id))!.status).toBe('failed'); expect(w.requests).toHaveLength(0); await unchanged(w);
  });

  it('does not repair a provider refusal', async () => {
    const w = await fixture([invalid, valid]); w.refuse(); const id = await w.admit();
    await w.execute(id); expect(w.requests).toHaveLength(1); await unchanged(w);
  });

  it.each(['memory', 'context', 'deadline', 'network'] as const)('does not repair a %s error', async code => {
    const w = await fixture([invalid, valid]);
    const doGenerate = vi.fn(async () => { throw code === 'network' ? new Error('Owned transport error') : new LocalModelError(code); });
    vi.spyOn(w.studio.agent as any, 'model').mockReturnValue({ specificationVersion: 'v3', provider: 'owned-error', modelId: 'fixture/model', supportedUrls: {}, doGenerate });
    const id = await w.admit(); await w.execute(id); expect(doGenerate).toHaveBeenCalledOnce(); await unchanged(w);
  });

  it.each(['source', 'permission', 'owner', 'cancel'] as const)('checks the %s fence before any repair round', async changed => {
    const w = await fixture([invalid, valid]), id = await w.admit();
    w.beforeResponse(async round => {
      if (round !== 1) return;
      if (changed === 'source') expect((await w.api('PATCH', '/api/artifacts/' + w.artifact.id, { version: w.artifact.version, content: { ...original, files: { ...original.files, 'saved.txt': 'A newer human source.' } } })).statusCode).toBe(200);
      else if (changed === 'permission') await w.store.exec('DELETE FROM memberships WHERE project_id=? AND user_id=?', w.artifact.projectId, w.signed.user.id);
      else if (changed === 'owner') await w.store.exec('UPDATE studio_planner_owners SET epoch=epoch+1 WHERE artifact_id=?', w.artifact.id);
      else await w.runtime.cancel(id, w.signed.user);
    });
    await w.execute(id); expect(w.requests).toHaveLength(1);
    expect(await w.store.all("SELECT * FROM messages WHERE artifact_id=? AND role='assistant'", w.artifact.id)).toEqual([]);
  });
});
