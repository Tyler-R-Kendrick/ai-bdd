import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { implementationPointer } from '../shared/implementation.ts';
import { client, setup, testSettings } from './helpers.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
describe('assembled cloud domain guards', () => {
  it('releases database and background resources when application initialization fails', async () => {
    const directory = await mkdtemp('/workspace/ai-bdd/work/startup-cleanup-'),
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
});
