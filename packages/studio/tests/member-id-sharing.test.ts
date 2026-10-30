import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { client, githubSignIn, project, setup, testSettings, type TestApp } from './helpers.ts';

describe('project sharing by an existing GitHub member ID', () => {
  let instance: TestApp, directory: string, owner: any, request: ReturnType<typeof client>, workspace: any;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'studio-member-id-'));
    instance = await createApp(testSettings(directory), { db: join(directory, 'studio.sqlite'), startupDispatchLimit: 0 });
    owner = await setup(instance.app); request = client(instance.app, owner.cookie);
    workspace = await project(request);
  });
  afterEach(async () => { await instance.app.close(); await rm(directory, { recursive: true, force: true }); });
  async function registered(email: string) {
    // The legacy policy on this test's base needs a seed; automatic provisioning
    // ignores the seed and returns its own principal-bound record instead.
    await instance.store.createUser(email, 'Teammate', null);
    return githubSignIn(instance.app, email);
  }
  const endpoint = () => `/api/projects/${workspace.id}/members`;

  it('adds and updates a registered GitHub user without an email or name payload', async () => {
    const teammate = await registered('friend@example.test'), before = await instance.store.one('SELECT count(*) AS n FROM users');
    expect((await request('POST', endpoint(), { userId: teammate.user.id, role: 'editor' })).statusCode).toBe(200);
    const memberRequest = client(instance.app, teammate.cookie);
    expect((await memberRequest('GET', `/api/projects/${workspace.id}/artifacts`)).statusCode).toBe(200);
    expect((await request('POST', endpoint(), { userId: teammate.user.id, role: 'viewer' })).statusCode).toBe(200);
    expect((await request('GET', endpoint())).json()).toContainEqual(expect.objectContaining({ id: teammate.user.id, role: 'viewer' }));
    expect((await memberRequest('PATCH', `/api/projects/${workspace.id}`, { title: 'Forbidden viewer write', description: '', repository: '' })).statusCode).toBe(403);
    expect(await instance.store.one('SELECT count(*) AS n FROM users')).toEqual(before);
  });

  it('refuses an unknown or never-authenticated member ID without creating a user or membership', async () => {
    const placeholder = await instance.store.createUser('unbound@example.test', 'Never signed in', null);
    const before = await instance.store.one('SELECT count(*) AS n FROM users');
    for (const userId of [randomUUID(), placeholder.id])
      expect((await request('POST', endpoint(), { userId, role: 'editor' })).statusCode).toBe(404);
    expect(await instance.store.one('SELECT count(*) AS n FROM users')).toEqual(before);
    expect((await request('GET', endpoint())).json()).toHaveLength(1);
  });

  it('rejects malformed or mixed target selectors', async () => {
    const teammate = await registered('schema@example.test');
    for (const body of [
      { userId: 'not-an-id', role: 'editor' },
      { userId: teammate.user.id, email: 'schema@example.test', name: 'Ambiguous', role: 'editor' },
      { userId: teammate.user.id, role: 'admin' },
      { userId: teammate.user.id, name: 'Unexpected', role: 'editor' },
    ]) expect((await request('POST', endpoint(), body)).statusCode).toBe(400);
    expect((await request('GET', endpoint())).json()).toHaveLength(1);
  });

  it('requires a real owner session and canonical Origin before changing membership', async () => {
    const teammate = await registered('permissions@example.test');
    const body = { userId: teammate.user.id, role: 'owner' };
    expect((await instance.app.inject({ method: 'POST', url: endpoint(), headers: { origin: testSettings(directory).origin }, payload: body })).statusCode).toBe(401);
    expect((await request('POST', endpoint(), body, { origin: 'https://attacker.example.test' })).statusCode).toBe(403);
    const memberRequest = client(instance.app, teammate.cookie);
    expect((await memberRequest('POST', endpoint(), body)).statusCode).toBe(404);
    for (const role of ['viewer', 'editor'] as const) {
      expect((await request('POST', endpoint(), { ...body, role })).statusCode).toBe(200);
      expect((await memberRequest('POST', endpoint(), body)).statusCode).toBe(403);
    }
    expect((await request('GET', endpoint())).json()).toContainEqual(expect.objectContaining({ id: teammate.user.id, role: 'editor' }));
  });

  it('retains the last-owner rule and legacy email-input compatibility', async () => {
    expect((await request('POST', endpoint(), { userId: owner.user.id, role: 'viewer' })).statusCode).toBe(409);
    expect((await request('POST', endpoint(), { email: 'legacy@example.test', name: 'Legacy client', role: 'viewer' })).statusCode).toBe(200);
    expect((await request('GET', endpoint())).json()).toContainEqual(expect.objectContaining({ email: 'legacy@example.test', role: 'viewer' }));
    expect((await request('GET', endpoint())).json()).toContainEqual(expect.objectContaining({ id: owner.user.id, role: 'owner' }));
  });
});
