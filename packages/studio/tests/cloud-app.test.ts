import { cpuAudioRenderDriver, probeAudio } from '../server/audio-renderer.ts';
import { initialAudioContent } from '../shared/audio.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { decisionProfileSchema } from '../shared/decision-profile.ts';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/persistence/index.ts';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app.ts';
import { implementationPointer } from '../shared/implementation.ts';
import { client, setup, testSettings } from './helpers.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
describe('assembled cloud domain guards', () => {
  it('composes the audio worker and verified source probe ports with authenticated output and complete export', async () => {
    let renders = 0,
      probes = 0;
    const studio = await createApp(
      testSettings('/tmp/studio-audio-composition'),
      {
        db: ':memory:',
        audioRenderDriver: {
          name: 'local-cpu-composition-test',
          runtime: 'long-lived-worker',
          render: async (input) => {
            renders++;
            return cpuAudioRenderDriver.render(input);
          },
        },
        audioSourceProbe: async (bytes, options) => {
          probes++;
          return probeAudio(bytes, options);
        },
      },
    );
    cleanup.push(() => studio.app.close());
    const { user, cookie } = await setup(studio.app),
      request = client(studio.app, cookie),
      project = await studio.store.createProject(user, 'Audio composition', ''),
      content = initialAudioContent();
    content.duration = 0.1;
    content.tracks = [];
    const artifact = await studio.store.createArtifact(
        user,
        project.id,
        'audio',
        'Verified mixdown',
        content,
      ),
      started = await request(
        'POST',
        `/api/artifacts/${artifact.id}/audio/render`,
        { version: artifact.version, format: 'wav' },
      );
    expect(started.statusCode, started.body).toBe(202);
    await vi.waitFor(
      async () =>
        expect((await studio.runtime.get(started.json().id))?.status).toBe(
          'completed',
        ),
      { timeout: 10000 },
    );
    expect(renders).toBe(1);
    const result = await request(
      'GET',
      `/api/artifacts/${artifact.id}/audio/renders/${started.json().id}`,
    );
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().status).toBe('completed');
    const download = await request('GET', result.json().downloadUrl);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    const metadata = await request(
      'GET',
      `/api/artifacts/${artifact.id}/audio/sources/${result.json().fileId}`,
    );
    expect(metadata.statusCode, metadata.body).toBe(200);
    expect(metadata.json().duration).toBeCloseTo(0.1, 2);
    expect(probes).toBe(1);
    const exported = await request(
      'GET',
      `/api/artifacts/${artifact.id}/export`,
    );
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.json().audioRenders).toHaveLength(1);
    expect(exported.json().audioRenders[0]).toMatchObject({
      status: 'completed',
      sourceSnapshot: {
        title: 'Verified mixdown',
        format: 'wav',
        content: { duration: 0.1, tracks: [] },
      },
    });
  });
  it('persists an independent decision profile and executes an advisory review through the actual application runtime', async () => {
    const requests: any[] = [];
    const provider = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ path: req.url, body });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          model: body.model,
          answers: body.questions.map((q: any) =>
            q.type === 'score'
              ? {
                  name: q.name,
                  type: 'score',
                  score: 1.925,
                  confidence: 0.95,
                  probabilities: q.levels.map((level: any, index: number) => ({
                    value: index,
                    label: level.label,
                    probability: index === 2 ? 0.95 : 0.025,
                  })),
                }
              : { name: q.name, type: 'predicate', probability: 0.95 },
          ),
          usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        }),
      );
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          provider.closeAllConnections();
          provider.close(() => resolve());
        }),
    );
    const studio = await createApp(
      {
        ...testSettings('/tmp/studio-decision-composition'),
        model: 'fixture/chat-model',
      },
      {
        db: ':memory:',
        decisionSettings: {
          production: false,
          timeoutMs: 3000,
          defaultProfile: decisionProfileSchema.parse({
            provider: 'openai-decisions',
            model: 'gpt-6-luna',
          }),
          openai: {
            baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
            apiKey: 'explicit-composition-http-fixture',
            models: ['gpt-6-luna'],
          },
        },
      },
    );
    cleanup.push(() => studio.app.close());
    const { user, cookie } = await setup(studio.app),
      request = client(studio.app, cookie),
      project = await studio.store.createProject(
        user,
        'Advisory review',
        'Measure integration timeout behavior before implementation.',
      ),
      id = project.mainArtifactId;
    const profile = await request(
      'GET',
      `/api/artifacts/${id}/decision/profile`,
    );
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json()).toMatchObject({
      independentOfChat: true,
      profile: { provider: 'openai-decisions', model: 'gpt-6-luna' },
    });
    const saved = await request(
      'PUT',
      `/api/artifacts/${id}/decision/profile`,
      {
        provider: 'openai-decisions',
        model: 'gpt-6-luna',
        minimumConfidence: 0.85,
      },
    );
    expect(saved.statusCode, saved.body).toBe(200);
    expect(
      (await request('GET', `/api/artifacts/${id}/agent/profile`)).json()
        .profile.harness,
    ).toBe('t3-code');
    const before = await studio.store.artifact(id, user.id),
      view = await request('GET', `/api/artifacts/${id}/decision-review`);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().available).toBe(true);
    const started = await request(
      'POST',
      `/api/artifacts/${id}/decision-review`,
      { requestId: randomUUID(), blockIds: [view.json().passages[0].id] },
    );
    expect(started.statusCode, started.body).toBe(200);
    await vi.waitFor(
      async () =>
        expect((await studio.runtime.get(started.json().id))?.status).toBe(
          'completed',
        ),
      { timeout: 5000 },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/v1/decisions');
    const history = await request(
      'GET',
      `/api/artifacts/${id}/decision/evaluations`,
    );
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().evaluations).toHaveLength(1);
    const exported = await request('GET', `/api/artifacts/${id}/export`);
    expect(exported.statusCode, exported.body).toBe(200);
    expect(
      exported
        .json()
        .decisionModels.filter((row: any) => row.kind === 'admission'),
    ).toHaveLength(1);
    expect(
      exported
        .json()
        .decisionModels.find((row: any) => row.kind === 'evaluation').value
        .result.answers[0].status,
    ).toBe('answered');
    expect(JSON.stringify(exported.json().decisionModels)).not.toMatch(
      /lease_owner|fixture-key|Authorization/,
    );
    expect(exported.json().audioRenders).toEqual([]);
    expect(history.json().evaluations[0].provenance).toMatchObject({
      provider: 'openai-decisions',
      requestedModel: 'gpt-6-luna',
      minimumConfidence: 0.85,
      purpose: 'semantic-design-gap',
      mode: 'native-decision',
    });
    expect((await studio.store.artifact(id, user.id)).content).toEqual(
      before.content,
    );
    expect((await studio.store.artifact(id, user.id)).version).toBe(
      before.version,
    );
    expect(
      (await request('GET', `/api/artifacts/${id}/agent/profile`)).json()
        .profile.harness,
    ).toBe('t3-code');
  });
  it('refuses human approval of an empty canonical plan and exposes the concrete source blocker', async () => {
    const studio = await createApp(testSettings('/tmp/studio-empty-plan'), {
      db: ':memory:',
    });
    cleanup.push(() => studio.app.close());
    const { cookie, user } = await setup(studio.app),
      request = client(studio.app, cookie);
    const project = await studio.store.createProject(
      user,
      'Empty plan',
      '',
      'https://github.com/example/empty-plan',
    );
    const artifact = await studio.store.artifact(
      project.mainArtifactId,
      user.id,
    );
    const empty = await studio.store.updateArtifact(
      user,
      artifact.id,
      artifact.version,
      { doc: { type: 'doc', content: [{ type: 'paragraph' }] } },
    );
    const graph = await studio.graphs.edit({ user, kind: 'human' }, empty.id, {
      expected: null,
      planRevision: empty.version,
      definition: {
        tasks: [
          {
            id: 'one',
            title: 'Unfounded task',
            description: 'No plan exists yet.',
            acceptanceCriteria: ['Needs source intent.'],
          },
        ],
        edges: [],
      },
    });
    const approved = await request(
      'POST',
      `/api/artifacts/${empty.id}/implementation/approve`,
      implementationPointer(graph),
    );
    expect(approved.statusCode).toBe(409);
    const readiness = await request(
      'GET',
      `/api/artifacts/${empty.id}/implementation/readiness`,
    );
    expect(readiness.json().blockers).toContainEqual({
      kind: 'source',
      id: empty.id,
      message: 'Write the plan before approving or starting implementation.',
    });
  });
  it('releases database and background resources when application initialization fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'studio-startup-cleanup-')),
      file = join(directory, 'studio.sqlite');
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    await expect(
      createApp(
        {
          ...testSettings(directory),
          oidcIssuer: 'http://organization.example.test',
          oidcClientId: 'fixture',
          oidcClientSecret: 'fixture-only',
        },
        { db: file },
      ),
    ).rejects.toThrow('OIDC requires HTTPS');
    const reopened = await Store.open(file);
    await reopened.close();
  });
  it('keeps source, ADR and repository writes locked to a claimed graph while discussion remains usable', async () => {
    const studio = await createApp(testSettings('/tmp/studio-cloud-domain'), {
      db: ':memory:',
    });
    cleanup.push(() => studio.app.close());
    const { cookie, user } = await setup(studio.app),
      request = client(studio.app, cookie),
      repository = 'https://github.com/example/guarded-plan';
    const project = await studio.store.createProject(
        user,
        'Guarded plan',
        '',
        repository,
      ),
      id = project!.mainArtifactId;
    const builder = {
        user,
        kind: 'agent' as const,
        agentId: 'fixture/builder',
      },
      human = { user, kind: 'human' as const };
    const draft = await studio.graphs.edit(builder, id, {
      expected: null,
      planRevision: 1,
      definition: {
        tasks: [
          {
            id: 'one',
            title: 'Implement boundary',
            description: 'Use the recorded interfaces',
            acceptanceCriteria: ['The boundary test passes'],
          },
        ],
        edges: [],
      },
    });
    const approved = await studio.graphs.approve(
      human,
      id,
      implementationPointer(draft),
    );
    await studio.graphs.claim(builder, id, {
      expected: implementationPointer(approved),
      repository,
      branch: 'feature/boundary',
      commit: 'a'.repeat(40),
    });
    const source = await studio.store.artifact(id, user.id),
      decision = (await studio.store.decisions(id))[0]!;
    const attempts = [
      [
        'PATCH',
        `/api/artifacts/${id}`,
        { version: source.version, content: source.content },
      ],
      [
        'PATCH',
        `/api/artifacts/${id}/title`,
        { title: 'Changed while claimed' },
      ],
      [
        'PUT',
        `/api/artifacts/${id}/decisions/${decision.id}`,
        {
          title: decision.title,
          context: decision.context,
          decision: decision.decision,
          consequences: decision.consequences,
          status: 'accepted',
          version: decision.version,
        },
      ],
      [
        'PATCH',
        `/api/projects/${project!.id}`,
        {
          title: 'Guarded plan',
          description: '',
          repository: 'https://github.com/example/other',
        },
      ],
    ] as const;
    for (const [method, path, body] of attempts) {
      const response = await request(method, path, body);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error).toContain('implementation-locked');
    }
    const thread = (await studio.store.threads(id))[0]!;
    expect(
      (
        await request('POST', `/api/artifacts/${id}/messages`, {
          threadId: thread.id,
          body: 'Implementation progress remains discussable',
        })
      ).statusCode,
    ).toBe(201);
    const exported = await request('GET', `/api/artifacts/${id}/export`);
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.json().implementation.snapshot.editingLock).toBeTruthy();
    expect(exported.json().implementation.events.length).toBeGreaterThan(0);
  });
  it('refreshes an already-open local Yjs room after a transactional investigation card write without reload', async () => {
    const studio = await createApp(
      testSettings('/tmp/studio-live-investigation'),
      process.env.STUDIO_TEST_POSTGRES_URL
        ? {
            database: await openDatabase({
              adapter: 'postgres',
              url: process.env.STUDIO_TEST_POSTGRES_URL,
              schema: 'app_export_' + randomUUID().replaceAll('-', ''),
            }),
          }
        : { db: ':memory:' },
    );
    cleanup.push(() => studio.app.close());
    const { user, cookie } = await setup(studio.app),
      project = (await studio.store.createProject(
        user,
        'Live source',
        '',
        'https://github.com/example/live-source',
      ))!,
      room = await studio.collab.room(project.mainArtifactId, user.id);
    const investigation = await studio.investigations!.propose(
      user,
      project.mainArtifactId,
      {
        version: 1,
        brief: 'Measure the actual boundary behavior',
        sourceCommit: 'a'.repeat(40),
      },
    );
    await vi.waitFor(
      () => {
        const source = yXmlFragmentToProsemirrorJSON(
          room.doc.getXmlFragment('default'),
        );
        expect(JSON.stringify(source)).toContain(investigation.id);
      },
      { timeout: 3000 },
    );
    const artifact = await studio.store.artifact(
      project.mainArtifactId,
      user.id,
    );
    await studio.collab.replace(
      artifact.id,
      user,
      artifact.content,
      artifact.version,
    );
    const exported = await client(studio.app, cookie)(
      'GET',
      `/api/artifacts/${artifact.id}/export`,
    );
    expect(exported.statusCode, exported.body).toBe(200);
    const history = exported.json().investigations;
    expect(
      history.find((row: any) => row.kind === 'investigation').value.id,
    ).toBe(investigation.id);
    expect(JSON.stringify(history)).not.toMatch(
      /lease_hash|token_hash|leaseToken/,
    );
  });
  it('exposes the selected default T3 availability and requires an explicit configured FX selection', async () => {
    const studio = await createApp(
      { ...testSettings('/tmp/studio-profile-api'), model: 'fixture/model' },
      { db: ':memory:' },
    );
    cleanup.push(() => studio.app.close());
    const { user, cookie } = await setup(studio.app),
      request = client(studio.app, cookie),
      project = (await studio.store.createProject(
        user,
        'Harness profile',
        '',
      ))!,
      id = project.mainArtifactId;
    const profile = await request('GET', `/api/artifacts/${id}/agent/profile`);
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json().profile.harness).toBe('t3-code');
    expect(
      (await request('GET', `/api/artifacts/${id}/title-policy`)).json()
        .available,
    ).toBe(false);
    expect(
      (await request('GET', `/api/artifacts/${id}`)).json().agentAvailable,
    ).toBe(false);
    const thread = (await studio.store.threads(id))[0]!;
    const offline = await request('POST', `/api/artifacts/${id}/agent`, {
      threadId: thread.id,
      intent: 'chat',
    });
    expect(offline.statusCode, offline.body).toBe(503);
    expect(offline.json().error).toContain('T3');
    expect(
      await studio.store.all(
        'SELECT id FROM studio_durable_jobs WHERE artifact_id=?',
        id,
      ),
    ).toHaveLength(0);
    const saved = await request('PUT', `/api/artifacts/${id}/agent/profile`, {
      harness: 'vercel-fx',
      provider: 'ai-gateway',
      model: 'fixture/model',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(
      (await request('GET', `/api/artifacts/${id}/title-policy`)).json()
        .available,
    ).toBe(true);
    expect(
      (await request('GET', `/api/artifacts/${id}`)).json().agentAvailable,
    ).toBe(true);
    const draft = await request(
      'GET',
      `/api/artifacts/${id}/implementation/draft`,
    );
    expect(draft.statusCode, draft.body).toBe(200);
    expect(draft.json()).toEqual({ jobs: [] });
  });
});
