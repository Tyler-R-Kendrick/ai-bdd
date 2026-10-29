import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { registerVideoRoutes } from '../server/video.ts';
import { setup, client, project, member, testSettings } from './helpers.ts';
import { initialContent } from '../shared/domain.ts';
let dir: string,
  context: Awaited<ReturnType<typeof createApp>>,
  service: ReturnType<typeof registerVideoRoutes>;
let request: ReturnType<typeof client>, projectId: string, artifact: any;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-video-api-'));
  const settings = testSettings(dir);
  context = await createApp(settings, { db: ':memory:' });
  service =
    context.video ??
    registerVideoRoutes(context.app, {
      store: context.store,
      auth: context.auth,
      settings,
    });
  const owner = await setup(context.app);
  request = client(context.app, owner.cookie);
  projectId = (await project(request)).id;
  const content = initialContent('video', 'Video API fixture');
  Object.assign(content, { width: 320, height: 180, duration: 1 });
  content.layers = content.layers.map((layer: any) => ({
    ...layer,
    x: 20,
    y: 40,
    width: 280,
    height: 80,
    fontSize: 24,
    duration: 1,
    fontFamily: 'Georgia',
  }));
  artifact = (
    await request('POST', `/api/projects/${projectId}/artifacts`, {
      kind: 'video',
      title: 'API render',
      content,
    })
  ).json();
});
afterEach(async () => {
  await service.close();
  await context.app.close();
  await rm(dir, { force: true, recursive: true });
});
async function completed(id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const row = (
      await request(
        'GET',
        `/api/artifacts/${artifact.id}/video/renders/${id}`,
      )
    ).json();
    if (!['queued', 'rendering'].includes(row.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Video render did not finish');
}
describe('Authorized durable video rendering', () => {
  it('requires a current video revision and write access, then persists a real encoded output', async () => {
    const viewer = await member(context.app, request, projectId, 'viewer');
    const readOnly = client(context.app, viewer.cookie);
    expect(
      (
        await readOnly('POST', `/api/artifacts/${artifact.id}/video/render`, {
          version: 1,
          format: 'mp4',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request('POST', `/api/artifacts/${artifact.id}/video/render`, {
          version: 99,
          format: 'mp4',
        })
      ).statusCode,
    ).toBe(409);
    const queued = await request(
      'POST',
      `/api/artifacts/${artifact.id}/video/render`,
      { version: 1, format: 'mp4' },
    );
    expect(queued.statusCode).toBe(202);
    const result = await completed(queued.json().id);
    expect(result).toMatchObject({
      status: 'completed',
      artifactVersion: 1,
      format: 'mp4',
      progress: 1,
    });
    const output = await readOnly('GET', result.downloadUrl);
    expect(output.statusCode).toBe(200);
    expect(output.headers['content-type']).toBe('video/mp4');
    expect(output.rawPayload.length).toBeGreaterThan(1000);
    expect(
      context.store.one('SELECT sha256 FROM files WHERE id=?', result.fileId)
        .sha256,
    ).toHaveLength(64);
  });
  it('refuses to publish rendered output when project access is revoked during the awaited encoder work', async () => {
    const editor = await member(context.app, request, projectId, 'editor');
    const edit = client(context.app, editor.cookie);
    const queued = await edit(
      'POST',
      `/api/artifacts/${artifact.id}/video/render`,
      { version: 1, format: 'webm' },
    );
    expect(queued.statusCode).toBe(202);
    context.store.exec(
      'DELETE FROM memberships WHERE project_id=? AND user_id=?',
      projectId,
      editor.user.id,
    );
    const result = await completed(queued.json().id);
    expect(result.status).toBe('failed');
    expect(result.fileId).toBeNull();
    expect(
      context.store.one(
        'SELECT count(*) AS n FROM files WHERE artifact_id=?',
        artifact.id,
      ).n,
    ).toBe(0);
  });
});
