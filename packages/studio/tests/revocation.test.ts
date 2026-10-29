import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app.ts';
import {
  client,
  member,
  project,
  setup,
  testSettings,
  type TestApp,
} from './helpers.ts';
describe('Permission changes during asynchronous requests', () => {
  let instance: TestApp, request: ReturnType<typeof client>, owner: any;
  beforeEach(async () => {
    instance = await createApp(testSettings('/tmp/studio-revocation'), {
      db: ':memory:',
    });
    const session = await setup(instance.app);
    owner = session.user;
    request = client(instance.app, session.cookie);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await instance.app.close();
  });
  it('does not admit a new account after its inviting owner loses project access', async () => {
    const p = await project(request);
    await member(
      instance.app,
      request,
      p.id,
      'owner',
      'second-owner@example.test',
    );
    const lookup = instance.store.userByEmail.bind(instance.store),
      email = 'late-invite@example.test';
    let revoked = false;
    vi.spyOn(instance.store, 'userByEmail').mockImplementation((value) => {
      if (value === email && !revoked) {
        revoked = true;
        instance.store.exec(
          'DELETE FROM memberships WHERE project_id=? AND user_id=?',
          p.id,
          owner.id,
        );
      }
      return lookup(value);
    });
    const response = await request('POST', `/api/projects/${p.id}/members`, {
      email,
      name: 'Late invitation',
      role: 'editor',
    });
    expect(response.statusCode).toBe(404);
    expect(lookup(email)).toBeUndefined();
  });
  it('does not persist a provider result after the requesting editor is removed', async () => {
    const p = await project(request),
      editor = await member(instance.app, request, p.id, 'editor'),
      edit = client(instance.app, editor.cookie);
    await request('POST', `/api/artifacts/${p.mainArtifactId}/links`, {
      label: 'Review change',
      url: 'https://github.com/example/project/pull/1',
      kind: 'pull-request',
    });
    const bundle = (
        await request('GET', `/api/artifacts/${p.mainArtifactId}`)
      ).json(),
      link = bundle.links[0];
    let started!: () => void, complete!: (r: Response) => void;
    const waiting = new Promise<void>((r) => {
      started = r;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      started();
      return new Promise<Response>((r) => {
        complete = r;
      });
    });
    const pending = edit(
      'POST',
      `/api/artifacts/${p.mainArtifactId}/links/${link.id}/refresh`,
    );
    await waiting;
    expect(
      (
        await request(
          'DELETE',
          `/api/projects/${p.id}/members/${editor.user.id}`,
        )
      ).statusCode,
    ).toBe(200);
    complete(
      new Response(JSON.stringify({ merged: false, state: 'open' }), {
        status: 200,
      }),
    );
    expect((await pending).statusCode).toBe(404);
    expect(
      instance.store.one('SELECT state FROM links WHERE id=?', link.id).state,
    ).toBe('unknown');
  });
});
