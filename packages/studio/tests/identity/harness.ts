import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { HttpError, hash } from '../../server/store.ts';
import { registerRepositoryIdentity } from '../../server/identity/github.ts';
import type {
  IdentityStore,
  IdentityAuth,
  IdentitySettings,
} from '../../server/identity/ports.ts';
import type { User, Project } from '../../shared/domain.ts';
import { githubFixture } from './github-fixture.ts';
export async function identityHarness() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,name TEXT,color TEXT);CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),expires BIGINT,kind TEXT);CREATE TABLE github_signin_sessions(token TEXT PRIMARY KEY REFERENCES sessions(token) ON DELETE CASCADE);CREATE TABLE projects(id TEXT PRIMARY KEY,title TEXT,repository TEXT);CREATE TABLE memberships(project_id TEXT,user_id TEXT,role TEXT,PRIMARY KEY(project_id,user_id));',
  );
  let tail: Promise<void> = Promise.resolve();
  const active = new AsyncLocalStorage<boolean>();
  async function lock<T>(fn: () => Promise<T> | T) {
    const before = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => (release = resolve));
    await before;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  async function run<T>(fn: () => T): Promise<T> {
    return active.getStore() ? fn() : lock(fn);
  }
  const store: IdentityStore = {
    lock: async () => {},
    one: (sql, ...args) => run(() => db.prepare(sql).get(...args)),
    all: (sql, ...args) => run(() => db.prepare(sql).all(...args)),
    exec: (sql, ...args) => run(() => db.prepare(sql).run(...args)),
    async projects(userId) {
      return (await store.all(
        'SELECT p.id,p.title,p.repository,m.role FROM projects p JOIN memberships m ON m.project_id=p.id WHERE m.user_id=?',
        userId,
      )) as Project[];
    },
    async publicUser(id) {
      const user = await store.one('SELECT * FROM users WHERE id=?', id);
      if (!user) throw new HttpError(401, 'Unknown fixture account');
      return user;
    },
    async tx<T>(fn: () => Promise<T>) {
      return lock(() =>
        active.run(true, async () => {
          db.exec('BEGIN IMMEDIATE');
          try {
            const value = await fn();
            db.exec('COMMIT');
            return value;
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        }),
      );
    },
  };
  const origin = 'http://studio.fixture.test',
    auth: IdentityAuth = {
      async user(req) {
        const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1],
          token = bearer ??
            req.cookies.studio_session,
          row =
            token &&
            (await store.one(
              'SELECT user_id FROM sessions WHERE token=? AND expires>? AND kind=?' + (bearer ? '' : ' AND EXISTS(SELECT 1 FROM github_signin_sessions g WHERE g.token=sessions.token)'),
              hash(token),
              Date.now(),
              bearer ? 'api' : 'session',
            ));
        if (!row) throw new HttpError(401, 'Sign in');
        return store.publicUser(row.user_id);
      },
      assertOrigin(req) {
        if (!req.headers.authorization && req.headers.origin !== origin)
          throw new HttpError(403, 'Origin is not allowed');
      },
    };
  const users: User[] = [
    {
      id: 'studio-alice',
      email: 'alice@example.test',
      name: 'Alice',
      color: '#555ca8',
    },
    {
      id: 'studio-bob',
      email: 'bob@example.test',
      name: 'Bob',
      color: '#378469',
    },
    {
      id: 'studio-charlie',
      email: 'charlie@example.test',
      name: 'Charlie',
      color: '#b06440',
    },
  ];
  for (const user of users) {
    await store.exec(
      'INSERT INTO users VALUES(?,?,?,?)',
      user.id,
      user.email,
      user.name,
      user.color,
    );
    await store.exec(
      'INSERT INTO sessions VALUES(?,?,?,?)',
      hash(user.id + '-session'),
      user.id,
      Date.now() + 3600000,
      'session',
    );
    // This isolated permission fixture starts after a verified browser sign-in.
    await store.exec('INSERT INTO github_signin_sessions(token) VALUES(?)', hash(user.id + '-session'));
  }
  const fixture = await githubFixture(),
    settings: IdentitySettings = {
      origin,
      production: false,
      repositoryIdentity: {
        clientId: fixture.clientId,
        clientSecret: fixture.clientSecret,
        encryptionKey: randomBytes(32).toString('base64url'),
        kind: 'oauth-app',
        authorizationUrl: fixture.origin + '/login/oauth/authorize',
        tokenUrl: fixture.origin + '/login/oauth/access_token',
        apiBaseUrl: fixture.origin,
        allowLoopback: true,
        webhookSecret: 'fixture-webhook-secret-at-least-32-characters',
        leaseSeconds: 30,
      },
    };
  const app = Fastify();
  await app.register(cookie);
  app.setErrorHandler((error, _req, reply) =>
    reply
      .code((error as any).statusCode ?? 400)
      .send({ error: (error as Error).message }),
  );
  const identity = await registerRepositoryIdentity(app, {
    store,
    auth,
    settings,
  });
  await app.ready();
  const cookieFor = (user: User) => 'studio_session=' + user.id + '-session';
  async function connect(
    user = users[0]!,
    account = { id: 101, login: 'alice-fixture' },
  ) {
    fixture.selected.user = account;
    const start = await app.inject({
      method: 'POST',
      url: '/api/identity/github/start',
      headers: { origin, cookie: cookieFor(user) },
      payload: { returnTo: '/?fixture=connected' },
    });
    if (start.statusCode !== 200) throw new Error(start.body);
    const browserCookie = start.cookies.find(
        (c) => c.name === 'studio_repository_oauth',
      )!.value,
      url = start.json().authorizationUrl;
    const authorize = await fetch(url, { redirect: 'manual' }),
      callback = authorize.headers.get('location');
    if (!callback) throw new Error('Fixture authorization failed');
    const response = await app.inject({
      url: new URL(callback).pathname + new URL(callback).search,
      headers: { cookie: 'studio_repository_oauth=' + browserCookie },
    });
    return { response, callback, browserCookie, url };
  }
  async function project(
    user: User,
    repository = 'https://github.com/acme/private',
    id = 'private-project',
  ) {
    await store.exec(
      'INSERT INTO projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET repository=excluded.repository',
      id,
      'Protected fixture project',
      repository,
    );
    await store.exec(
      "INSERT INTO memberships VALUES(?,?,'editor') ON CONFLICT(project_id,user_id) DO NOTHING",
      id,
      user.id,
    );
    return id;
  }
  return {
    app,
    store,
    auth,
    settings,
    identity,
    fixture,
    users,
    origin,
    cookieFor,
    connect,
    project,
    async close() {
      await app.close();
      await fixture.close();
      db.close();
    },
  };
}
