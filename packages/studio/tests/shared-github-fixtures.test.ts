import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.ts';
import { client, githubSignIn, member, project, setup, testSettings } from './helpers.ts';
import { fixtureGitHubIdentity } from './identity/github-signin-inject-fixture.ts';
import { identityHarness } from './identity/harness.ts';
import { prepareGitHubSession } from '../verification/github-session-fixture.ts';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it('reauthenticates the same fixture actor through its returned internal account identifier', async () => {
  const studio = await createApp(testSettings('/tmp/studio-shared-auto-identity'), { db: ':memory:' });
  cleanup.push(() => studio.app.close());
  const first = await setup(studio.app);
  expect(first.user.email).toMatch(/^[0-9a-f-]+@identity\.invalid$/);
  expect((await studio.store.one('SELECT password FROM users WHERE id=?', first.user.id)).password).toBeNull();
  const next = await githubSignIn(studio.app, first.user.email);
  expect(next.user.id).toBe(first.user.id);
  expect(next.user.email).toBe(first.user.email);
  expect((await studio.store.one('SELECT COUNT(*) AS n FROM users')).n).toBe(1);
});

it('shares with the signed-in member ID and retains owner/viewer authorization', async () => {
  const studio = await createApp(testSettings('/tmp/studio-shared-auto-members'), { db: ':memory:' });
  cleanup.push(() => studio.app.close());
  const owner = await setup(studio.app), request = client(studio.app, owner.cookie);
  const workspace = await project(request);
  const viewer = await member(studio.app, request, workspace.id, 'viewer');
  expect(viewer.user.email).toMatch(/@identity\.invalid$/);
  const principal = fixtureGitHubIdentity('viewer@example.test');
  expect(principal.kind).toBe('github');
  if (principal.kind !== 'github') throw new Error('Expected the owned direct GitHub actor');
  expect((await studio.store.one('SELECT user_id FROM github_signin_identities WHERE github_id=?', principal.id)).user_id).toBe(viewer.user.id);
  const readonly = client(studio.app, viewer.cookie);
  expect((await readonly('GET', `/api/artifacts/${workspace.mainArtifactId}`)).statusCode).toBe(200);
  expect((await readonly('POST', `/api/projects/${workspace.id}/members`, { userId: owner.user.id, role: 'viewer' })).statusCode).toBe(403);
  expect((await studio.store.one('SELECT role FROM memberships WHERE project_id=? AND user_id=?', workspace.id, owner.user.id)).role).toBe('owner');
});

it('uses explicit numeric bindings for the deliberately small repository-permission fixture', async () => {
  const fixture = await identityHarness();
  cleanup.push(() => fixture.close());
  const user = { id: 'owned-cross-store-reader', email: 'cross-store@example.test', name: 'Bound reader', color: '#555ca8' };
  const signedIn = await fixture.signIn(user);
  expect(signedIn.user.id).toBe(user.id);
  const principal = fixtureGitHubIdentity(user.email);
  if (principal.kind !== 'github') throw new Error('Expected the owned direct GitHub actor');
  expect((await fixture.store.one('SELECT user_id FROM github_signin_identities WHERE github_id=?', principal.id)).user_id).toBe(user.id);
});

it('retains the same passwordless release-fixture principal across independent store opens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-shared-auto-release-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const input = { dataDirectory: directory, email: 'release-fixture@example.test' };
  const first = await prepareGitHubSession(input), second = await prepareGitHubSession(input);
  expect(second.user.id).toBe(first.user.id);
  expect(second.user.email).toBe(first.user.email);
  expect(second.user.email).toMatch(/@identity\.invalid$/);
  expect(second.cookie).not.toBe(first.cookie);
});
