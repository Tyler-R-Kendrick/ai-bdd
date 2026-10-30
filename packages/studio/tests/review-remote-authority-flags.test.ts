import { it, expect } from 'vitest';
import { remoteFixture, until } from './remote-fixture.ts';
import { HttpError } from '../server/store.ts';

it.each(['editor', 'owner'] as const)(
  'advertises current repository write authority for a project %s while preserving reader history',
  async (role) => {
    const w = await remoteFixture(),
      client = await w.connect(),
      run = await w.start();
    await until(() =>
      client.frames.some((frame: any) => frame.type === 'turn'),
    );
    const requestId = client.frames.find(
      (frame: any) => frame.type === 'turn',
    ).requestId;
    client.ws.send(
      JSON.stringify({
        type: 'input-request',
        requestId,
        eventId: crypto.randomUUID(),
        questionId: 'entitlement',
        input: {
          method: 'confirm',
          title: 'Current writer only',
          message: 'An answer needs current write authority.',
        },
      }),
    );
    await until(() =>
      client.frames.some((frame: any) => frame.type === 'event-accepted'),
    );
    const route = `/api/artifacts/${w.artifact.id}/planner/requests/${requestId}`;
    const owner = await w.request(route);
    expect(owner.status).toBe(200);
    expect(owner.value).toMatchObject({ canAnswer: true, canControl: true });
    const viewer = await w.request(route, undefined, 'viewer-browser');
    expect(viewer.status).toBe(200);
    expect(viewer.value).toMatchObject({ canAnswer: false, canControl: false });
    const editor = await w.store.userByEmail('viewer@remote.test');
    await w.store.exec(
      'UPDATE memberships SET role=? WHERE project_id=? AND user_id=?',
      role,
      w.project.id,
      editor.id,
    );
    let mode: 'denied' | 'allowed' | 'unavailable' = 'denied';
    const checks: boolean[] = [];
    w.store.repositoryAuthorizer = async (_project, userId, action, atomic) => {
      if (userId === editor.id && action === 'write') {
        checks.push(atomic);
        if (mode === 'denied')
          throw new HttpError(403, 'Repository push permission was revoked');
        if (mode === 'unavailable')
          throw new HttpError(503, 'The entitlement provider is unavailable');
      }
    };
    const displayed = await w.request(route, undefined, 'viewer-browser');
    expect(displayed.status).toBe(200);
    expect(displayed.value).toMatchObject({
      canAnswer: false,
      canControl: false,
    });
    expect(checks).toEqual([false]);
    expect(
      (
        await w.request(
          `/api/artifacts/${w.artifact.id}/planner/activity`,
          undefined,
          'viewer-browser',
        )
      ).status,
    ).toBe(200);
    const answer = await w.request(
      route + '/questions/entitlement',
      {
        idempotencyKey: crypto.randomUUID(),
        expectedRevision: 1,
        action: 'answer',
        value: true,
      },
      'viewer-browser',
    );
    const control = await w.request(
      route + '/control',
      { idempotencyKey: crypto.randomUUID(), action: 'pause' },
      'viewer-browser',
    );
    expect(answer.status).toBe(403);
    expect(control.status).toBe(403);
    expect((await w.request(route)).value.questions[0]).toMatchObject({
      status: 'open',
      revision: 1,
    });
    mode = 'allowed';
    const restored = await w.request(route, undefined, 'viewer-browser');
    expect(restored.status).toBe(200);
    expect(restored.value).toMatchObject({
      canAnswer: true,
      canControl: role === 'owner',
    });
    expect(
      (
        await w.request(
          route + '/questions/entitlement',
          {
            idempotencyKey: crypto.randomUUID(),
            expectedRevision: 1,
            action: 'answer',
            value: true,
          },
          'viewer-browser',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await w.request(
          route + '/control',
          {
            idempotencyKey: crypto.randomUUID(),
            action: 'pause',
          },
          'viewer-browser',
        )
      ).status,
    ).toBe(role === 'owner' ? 200 : 403);
    mode = 'unavailable';
    expect((await w.request(route, undefined, 'viewer-browser')).status).toBe(
      503,
    );
    expect(checks.length).toBeGreaterThan(0);
    expect(checks).toContain(false);
    expect(checks).toContain(true);
    await w.runtime.cancel(run.job.id, w.user);
    await run.done;
  },
);
