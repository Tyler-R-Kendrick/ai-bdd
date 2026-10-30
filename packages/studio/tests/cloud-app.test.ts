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
      { db: ':memory:' },
    );
    cleanup.push(() => studio.app.close());
    const { user } = await setup(studio.app),
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
      (await request('GET', `/api/artifacts/${id}`)).json().agentAvailable,
    ).toBe(false);
    const saved = await request('PUT', `/api/artifacts/${id}/agent/profile`, {
      harness: 'vercel-fx',
      provider: 'ai-gateway',
      model: 'fixture/model',
    });
    expect(saved.statusCode, saved.body).toBe(200);
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
