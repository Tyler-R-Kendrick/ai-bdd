import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createApp } from '../server/app.ts';
import { Store } from '../server/store.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import { AgentProfiles } from '../server/integrations/agent-profiles.ts';
import { VisualRouting } from '../server/integrations/visual-routing.ts';
import { LOCAL_MODELS, DEFAULT_LOCAL_MODEL_ID, LOCAL_PROVIDER_ID, localModelFingerprint } from '../server/local/catalog.ts';
import nativeTools from '../server/local/native-t3-tools.json' with { type: 'json' };
import type { AgentProfile } from '../shared/agent-profile.ts';
import { client, project, setup, testSettings } from './helpers.ts';

const candidateId = 'granite-4.0-350m-q5-k-m';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
function profile(harness: 'local-cpu' | 't3-code', model: string): AgentProfile {
  return { harness, provider: harness === 'local-cpu' ? LOCAL_PROVIDER_ID : 'studioLocal', model: (harness === 'local-cpu' ? '' : 'studio-local/') + model };
}
async function fixture() {
  const directory = await mkdtemp('/tmp/studio-model-edit-capability-');
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  // Sparse catalog-presence fixtures only. These are never loaded or executed.
  for (const file of [...LOCAL_MODELS.flatMap(model => model.files), ...nativeTools.files]) {
    const path = join(directory, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, ''); await truncate(path, file.bytes); await chmod(path, 0o700);
  }
  const store = await Store.open(':memory:');
  const runtime = new DurableJobCoordinator({ store, dispatcher: { provider: 'owned-manual-capability-fixture', publish: async () => ({ provider: 'owned-manual-capability-fixture' }) } });
  await runtime.ready;
  const studio = await createApp({ ...testSettings(directory), integrations: {
    localModel: { directory }, managedT3: { toolsDirectory: directory, key: new Uint8Array(32).fill(7) },
  } }, { store, runtime, startupDispatchLimit: 0 });
  cleanup.push(() => studio.app.close());
  const signed = await setup(studio.app), api = client(studio.app, signed.cookie);
  const workspace = await project(api, 'Owned edit-capability fixture');
  const created = await api('POST', '/api/projects/' + workspace.id + '/artifacts', { kind: 'code', title: 'Saved source', content: { files: { 'index.html': '<button>Start</button>\n' }, entry: 'index.html' } });
  expect(created.statusCode, created.body).toBe(201);
  const artifact = created.json();
  const initial = (await api('GET', '/api/artifacts/' + artifact.id)).json();
  return { studio, store, runtime, signed, api, artifact, initial, threadId: initial.threads[0].id as string };
}
const generated = (content: any[], reason = 'stop') => ({ content, finishReason: { unified: reason, raw: reason }, usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }, warnings: [] });

describe('local artifact-edit capabilities without inference', () => {
  it('keeps independent model fingerprints and decision eligibility unchanged', () => {
    const profiles = new AgentProfiles({} as any, {} as any, { managedT3: { toolsDirectory: '/owned-controlled-presence', key: new Uint8Array(32) } });
    for (const harness of ['local-cpu', 't3-code'] as const) {
      expect(() => profiles.assertArtifactEdits(profile(harness, DEFAULT_LOCAL_MODEL_ID))).not.toThrow();
      for (const id of [candidateId, 'smollm2-135m-instruct-q4-k-m', 'unregistered'])
        expect(() => profiles.assertArtifactEdits(profile(harness, id))).toThrow('Choose and save');
    }
    expect(LOCAL_MODELS.filter(model => model.nativeDecisions).map(model => model.id)).toEqual([DEFAULT_LOCAL_MODEL_ID, 'smollm2-135m-instruct-q4-k-m']);
    expect(localModelFingerprint()).toBe('local-native-v1:qwen2.5-0.5b-instruct-q4-k-m:node-llama-cpp@3.22.2:6eb923e7d26e9cea28811e1a8e852009b21242fb157b26149d3b188f3a8c8653');
    for (const selected of [
      { harness: 't3-code', provider: 'operator-models', model: candidateId },
      { harness: 'vercel-fx', provider: 'ai-gateway', model: candidateId },
      { harness: 'remote-planner', provider: 'operator-acp', model: 'remote' },
    ] as AgentProfile[]) expect(() => profiles.assertArtifactEdits(selected)).not.toThrow();
    const external = new AgentProfiles({} as any, {} as any, {});
    expect(() => external.assertArtifactEdits({ harness: 't3-code', provider: 'studioLocal', model: 'external-operator-model' })).not.toThrow();
  });

  it.each(['local-cpu', 't3-code'] as const)('denies an unsupported %s edit before ownership, queue, decision or model work', async harness => {
    const w = await fixture();
    const selected = profile(harness, candidateId);
    const saved = await w.api('PUT', '/api/artifacts/' + w.artifact.id + '/agent/profile', selected);
    expect(saved.statusCode, saved.body).toBe(200);
    const catalog = saved.json();
    const provider = catalog.harnesses.find((h: any) => h.id === harness).providers.find((p: any) => p.id === selected.provider);
    expect(provider.models).toContain(selected.model);
    expect(provider.modelCapabilities[selected.model]).toEqual({ artifactEdits: false });
    const model = vi.spyOn(w.studio.agent as any, 'model');
    const decide = vi.spyOn(w.studio.decisions, 'decide');
    const enqueue = vi.spyOn(w.runtime, 'enqueue');
    const owner = vi.spyOn(w.studio.agent as any, 'claimOwner');
    const response = await w.api('POST', '/api/artifacts/' + w.artifact.id + '/agent', { threadId: w.threadId, intent: 'edit', brief: 'Change Start to Launch.' });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error).toContain('Choose and save a model that supports artifact edits');
    expect(enqueue).not.toHaveBeenCalled(); expect(owner).not.toHaveBeenCalled(); expect(model).not.toHaveBeenCalled(); expect(decide).not.toHaveBeenCalled();
    expect(await w.store.all('SELECT * FROM studio_planner_owners')).toEqual([]);
    expect(await w.store.all('SELECT * FROM studio_durable_jobs')).toEqual([]);
    const after = (await w.api('GET', '/api/artifacts/' + w.artifact.id)).json();
    expect(after.artifact).toEqual(w.initial.artifact); expect(after.messages).toEqual(w.initial.messages); expect(after.decisions).toEqual(w.initial.decisions);
  });

  it.each(['local-cpu', 't3-code'] as const)('admits an explicitly selected supported %s edit without changing the decision selection', async harness => {
    const w = await fixture();
    const before = await w.studio.decisions.captureProfile(w.signed.user, w.artifact.id);
    const selected = profile(harness, DEFAULT_LOCAL_MODEL_ID);
    const saved = await w.api('PUT', '/api/artifacts/' + w.artifact.id + '/agent/profile', selected);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().harnesses.find((h: any) => h.id === harness).providers.find((p: any) => p.id === selected.provider).modelCapabilities[selected.model]).toEqual({ artifactEdits: true });
    const response = await w.api('POST', '/api/artifacts/' + w.artifact.id + '/agent', { threadId: w.threadId, intent: 'edit', brief: 'Change Start to Launch.' });
    expect(response.statusCode, response.body).toBe(200);
    const job = (await w.runtime.get(response.json().id))!;
    expect(job.status).toBe('queued'); expect(job.attempt).toBe(0); expect((job.snapshot as any).profile).toEqual(selected);
    expect(await w.studio.decisions.captureProfile(w.signed.user, w.artifact.id)).toEqual(before);
    await w.runtime.cancel(job.id, w.signed.user);
  });

  it('rechecks a previously admitted unsupported edit before any model call or publication', async () => {
    const w = await fixture();
    await w.api('PUT', '/api/artifacts/' + w.artifact.id + '/agent/profile', profile('local-cpu', candidateId));
    // Simulate a job admitted by the old capability policy; the persisted snapshot is genuine.
    vi.spyOn(w.studio.agent.profiles, 'assertArtifactEdits').mockImplementationOnce(() => {});
    const response = await w.api('POST', '/api/artifacts/' + w.artifact.id + '/agent', { threadId: w.threadId, intent: 'edit', brief: 'Change Start to Launch.' });
    expect(response.statusCode, response.body).toBe(200);
    const model = vi.spyOn(w.studio.agent as any, 'model');
    await w.runtime.executeJob(response.json().id, { messageId: randomUUID(), deliveryCount: 1 });
    const job = (await w.runtime.get(response.json().id))!;
    expect(job.attempt).toBe(1); expect(job.status).toBe('failed'); expect(job.error).toContain('Choose and save');
    expect(model).not.toHaveBeenCalled();
    expect(await w.store.all('SELECT * FROM studio_job_receipts WHERE job_id=?', job.id)).toEqual([]);
    const after = (await w.api('GET', '/api/artifacts/' + w.artifact.id)).json();
    expect(after.artifact).toEqual(w.initial.artifact); expect(after.messages).toEqual(w.initial.messages);
  });

  it('retains chat and authorized read-only SDK functions for a model without artifact edits', async () => {
    const w = await fixture();
    await w.store.exec('UPDATE projects SET repository=? WHERE id=?', 'https://github.com/owned/capability-fixture', w.artifact.projectId);
    const reads: string[] = [];
    w.studio.agent.options.repositoryRead = async (_user, _repository, input) => {
      reads.push(input.kind);
      if (input.kind === 'commits') return [{ sha: 'a'.repeat(40) }];
      if (input.kind === 'file') return { type: 'file', encoding: 'base64', content: Buffer.from("export const name = 'Cedar Lantern';\n").toString('base64') };
      throw new Error('Unexpected controlled read');
    };
    let calls = 0;
    const controlledModel = { specificationVersion: 'v3', provider: 'owned-scripted-capability-fixture', modelId: candidateId, supportedUrls: {}, async doGenerate(call: any) {
      calls++;
      if (calls === 1) {
        expect(call.tools.some((tool: any) => tool.name === 'repository_file')).toBe(true);
        return generated([{ type: 'tool-call', toolCallId: 'saved-file', toolName: 'repository_file', input: JSON.stringify({ path: 'src/main.ts' }) }], 'tool-calls');
      }
      expect(JSON.stringify(call.prompt)).toContain('Cedar Lantern');
      return generated([{ type: 'text', text: 'The saved name is Cedar Lantern.' }]);
    } };
    vi.spyOn(w.studio.agent as any, 'model').mockReturnValue(controlledModel);
    await w.api('PUT', '/api/artifacts/' + w.artifact.id + '/agent/profile', profile('local-cpu', candidateId));
    const response = await w.api('POST', '/api/artifacts/' + w.artifact.id + '/agent', { threadId: w.threadId, intent: 'chat' });
    expect(response.statusCode, response.body).toBe(200);
    await w.runtime.executeJob(response.json().id, { messageId: randomUUID(), deliveryCount: 1 });
    expect((await w.runtime.get(response.json().id))!.status).toBe('completed'); expect(calls).toBe(2); expect(reads).toEqual(['commits', 'file']);
    const after = (await w.api('GET', '/api/artifacts/' + w.artifact.id)).json();
    expect(after.messages.at(-1).body).toBe('The saved name is Cedar Lantern.'); expect(after.messages.at(-1).proposal).toBe(null);
    expect(after.artifact).toEqual(w.initial.artifact); expect(after.decisions).toEqual(w.initial.decisions);
  });

  it('refuses a structured visual receipt saved by the older policy before proposal publication', async () => {
    const w = await fixture();
    w.studio.agent.integrations.plannerVisuals = true;
    const created = await w.api('POST', '/api/projects/' + w.artifact.projectId + '/artifacts', {
      kind: 'document', title: 'Saved visual source', content: { doc: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'The client sends a request to the server. The server reads the database and returns its saved response.' }] },
      ] } },
    });
    expect(created.statusCode, created.body).toBe(201);
    const document = created.json();
    const initial = (await w.api('GET', '/api/artifacts/' + document.id)).json();
    await w.api('PUT', '/api/artifacts/' + document.id + '/agent/profile', profile('local-cpu', candidateId));
    const human = await w.api('POST', '/api/artifacts/' + document.id + '/messages', { threadId: initial.threads[0].id, body: 'Diagram this request flow.' });
    expect(human.statusCode, human.body).toBe(201);
    const response = await w.api('POST', '/api/artifacts/' + document.id + '/agent', { threadId: initial.threads[0].id, intent: 'chat' });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().id;
    const snapshot = (await w.runtime.get(id))!.snapshot as any;
    expect(snapshot.visual).not.toBe(null);
    const value = JSON.stringify({ text: 'Old visual proposal.', content: initial.artifact.content,
      visual: { kind: 'diagramBlock', blockId: snapshot.visual.blockId, blockHash: snapshot.visual.blockHash } });
    await w.store.exec('INSERT INTO studio_job_receipts(job_id,name,phase,value_json,value_sha256,created_at) VALUES(?,?,?,?,?,?)', id, 'model-output', 'step', value, createHash('sha256').update(value).digest('hex'), new Date().toISOString());
    const model = vi.spyOn(w.studio.agent as any, 'model');
    const decide = vi.spyOn(w.studio.decisions, 'decide');
    const before = (await w.api('GET', '/api/artifacts/' + document.id)).json();
    await w.runtime.executeJob(id, { messageId: randomUUID(), deliveryCount: 1 });
    const job = (await w.runtime.get(id))!;
    expect(job.status).toBe('failed'); expect(job.error).toContain('Choose and save');
    expect(model).not.toHaveBeenCalled(); expect(decide).not.toHaveBeenCalled();
    expect((await w.store.one("SELECT value_json FROM studio_job_receipts WHERE job_id=? AND name='model-output'", id)).value_json).toBe(value);
    const after = (await w.api('GET', '/api/artifacts/' + document.id)).json();
    expect(after.artifact).toEqual(before.artifact); expect(after.messages).toEqual(before.messages); expect(after.decisions).toEqual(before.decisions);
  });

  it.each(['none', 'diagramBlock'])('allows visual classification %s but checks edit purpose before structured authorship', async classification => {
    const profiles = new AgentProfiles({} as any, {} as any, {});
    const assertArtifactEdits = vi.fn(() => profiles.assertArtifactEdits(profile('local-cpu', candidateId)));
    const answers: unknown[] = [true, true, classification];
    const decide = vi.fn(async () => ({ answers: [{ status: 'answered', value: answers.shift() }] }));
    const doGenerate = vi.fn(async () => { throw new Error('Structured authoring must not run'); });
    const router = new VisualRouting({ model: { specificationVersion: 'v3', provider: 'owned-controlled', modelId: candidateId, supportedUrls: {}, doGenerate } as any,
      decisions: { decide } as any, decisionProfile: {} as any, user: {} as any, artifactId: 'owned-artifact', artifactVersion: 1, assertArtifactEdits });
    const context = { signal: new AbortController().signal, assertCurrent: vi.fn(async () => {}), step: async (_name: string, work: (key: string) => Promise<unknown>) => work('owned-step') } as any;
    const pending = router.propose(context, { request: 'Explain the relationships.', paragraph: 'Saved source paragraph.', blockId: 'source', blockHash: 'frozen' }, {} as any);
    if (classification === 'none') { expect(await pending).toBe(null); expect(assertArtifactEdits).not.toHaveBeenCalled(); }
    else { await expect(pending).rejects.toMatchObject({ statusCode: 409 }); expect(assertArtifactEdits).toHaveBeenCalledOnce(); }
    expect(decide).toHaveBeenCalledTimes(3); expect(doGenerate).not.toHaveBeenCalled();
  });
});
