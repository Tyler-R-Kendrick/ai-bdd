import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { settingsFromEnv } from '../server/auth.ts';
import { hash } from '../server/store.ts';
import { artifactKinds } from '../shared/domain.ts';
import {
  client,
  member,
  origin,
  project,
  setup,
  testSettings,
  type TestApp,
} from './helpers.ts';
describe('Studio durable API and authorization', () => {
  let instance: TestApp,
    dir: string,
    cookie: string,
    user: any,
    request: ReturnType<typeof client>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'studio-api-'));
    instance = await createApp(testSettings(dir), {
      db: join(dir, 'studio.sqlite'),
    });
    ({ cookie, user } = await setup(instance.app));
    request = client(instance.app, cookie);
  });
  afterEach(async () => {
    await instance.app.close();
    await rm(dir, { recursive: true, force: true });
  });
  it('issues secure session attributes and never persists plaintext credentials', async () => {
    const response = await instance.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: {
        email: 'owner@example.test',
        password: 'correct-horse-battery-studio',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=Strict');
    const stored = await instance.store.userByEmail('owner@example.test');
    expect(stored.password).not.toContain('correct-horse');
    expect(
      await instance.store.one(
        'SELECT token FROM sessions WHERE token=?',
        cookie,
      ),
    ).toBeUndefined();
    expect(
      await instance.store.one(
        'SELECT token FROM sessions WHERE token=?',
        hash(cookie),
      ),
    ).toBeDefined();
    expect((await request('GET', '/api/me')).json()).not.toHaveProperty(
      'password',
    );
  });
  it('rejects unauthenticated requests, cross-origin writes, and repeat setup', async () => {
    expect((await instance.app.inject('/api/projects')).statusCode).toBe(401);
    expect(
      (
        await request(
          'POST',
          '/api/projects',
          { title: 'Forged' },
          { origin: 'https://attacker.test' },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await instance.app.inject({
          method: 'POST',
          url: '/api/projects',
          headers: { cookie: `studio_session=${cookie}` },
          payload: { title: 'Missing origin' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request('POST', '/api/auth/setup', {
          email: 'other@example.test',
          name: 'Other',
          password: 'long-enough-passphrase',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await instance.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { origin },
          payload: { email: 'owner@example.test', password: 'wrong' },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('creates a main design document, ADR, discussion and revision atomically', async () => {
    const p = await project(request);
    const list = (
      await request('GET', `/api/projects/${p.id}/artifacts`)
    ).json();
    expect(list).toHaveLength(1);
    const bundle = (
      await request('GET', `/api/artifacts/${p.mainArtifactId}`)
    ).json();
    expect(bundle.artifact).toMatchObject({
      kind: 'design',
      projectId: p.id,
      version: 1,
      createdBy: user.id,
    });
    expect(bundle.decisions).toHaveLength(1);
    expect(bundle.threads).toHaveLength(1);
    expect(bundle.decisions[0]).toMatchObject({
      artifactId: p.mainArtifactId,
      status: 'proposed',
      author: 'Test owner',
    });
    const history = (
      await request('GET', `/api/artifacts/${p.mainArtifactId}/history`)
    ).json();
    expect(history.revisions).toEqual([
      expect.objectContaining({ version: 1, actor: 'Test owner' }),
    ]);
  });
  it('supports every media type without live providers and keeps its own ADR and chat', async () => {
    const p = await project(request);
    for (const kind of artifactKinds.filter((k) => k !== 'design')) {
      const response = await request(
        'POST',
        `/api/projects/${p.id}/artifacts`,
        { kind, title: `A ${kind} artifact` },
      );
      expect(response.statusCode, response.body).toBe(201);
      const artifact = response.json(),
        bundle = (await request('GET', `/api/artifacts/${artifact.id}`)).json();
      expect(bundle.artifact.kind).toBe(kind);
      expect(bundle.decisions[0].artifactId).toBe(artifact.id);
      expect(bundle.threads[0].artifactId).toBe(artifact.id);
    }
    expect((await request('GET', '/api/capabilities')).json()).toMatchObject({
      agent: false,
      runner: false,
    });
  });
  it('persists artifacts and conversations across a complete server restart', async () => {
    const p = await project(request),
      bundle = (
        await request('GET', `/api/artifacts/${p.mainArtifactId}`)
      ).json();
    await request('POST', `/api/artifacts/${p.mainArtifactId}/messages`, {
      threadId: bundle.threads[0].id,
      body: 'Keep this decision context.',
    });
    await instance.app.close();
    instance = await createApp(testSettings(dir), {
      db: join(dir, 'studio.sqlite'),
    });
    request = client(instance.app, cookie);
    expect(
      (await request('GET', `/api/artifacts/${p.mainArtifactId}`)).json()
        .messages[0].body,
    ).toBe('Keep this decision context.');
    expect((await request('GET', '/api/projects')).json()[0].id).toBe(p.id);
  });
  it('enforces optimistic concurrency and retains both audit and immutable revisions', async () => {
    const p = await project(request),
      a = (
        await request('POST', `/api/projects/${p.id}/artifacts`, {
          kind: 'code',
          title: 'Checkout',
        })
      ).json();
    const content = {
      ...a.content,
      files: {
        ...a.content.files,
        'script.js': 'console.log("reviewed change")',
      },
    };
    const saved = await request('PATCH', `/api/artifacts/${a.id}`, {
      version: 1,
      content,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().version).toBe(2);
    expect(
      (
        await request('PATCH', `/api/artifacts/${a.id}`, {
          version: 1,
          content: a.content,
        })
      ).statusCode,
    ).toBe(409);
    const history = (
      await request('GET', `/api/artifacts/${a.id}/history`)
    ).json();
    expect(history.revisions.map((r: any) => r.version)).toEqual([2, 1]);
    expect(
      history.audit.some(
        (e: any) => e.action === 'artifact.updated' && e.actor === 'Test owner',
      ),
    ).toBe(true);
    expect(
      (await request('GET', `/api/artifacts/${a.id}/history/1`)).json().content,
    ).toEqual(a.content);
    expect(
      (await request('GET', `/api/artifacts/${a.id}`)).json().artifact.content,
    ).toEqual(content);
  });
  it('rejects unknown types, path traversal, extra request fields and invalid media content', async () => {
    const p = await project(request);
    for (const body of [
      { kind: 'shell', title: 'No' },
      {
        kind: 'code',
        title: 'No',
        content: { files: { '../config.ts': 'x' }, entry: '../config.ts' },
      },
      {
        kind: 'scene',
        title: 'No',
        content: { solids: [{ shape: 'box' }], unit: 'm', grid: true },
      },
      {
        kind: 'document',
        title: 'No',
        content: { doc: { type: 'script', text: 'bad' } },
      },
      { kind: 'code', title: 'No', admin: true },
    ]) {
      expect(
        (await request('POST', `/api/projects/${p.id}/artifacts`, body))
          .statusCode,
      ).toBe(400);
    }
    expect(
      (await request('GET', `/api/projects/${p.id}/artifacts`)).json(),
    ).toHaveLength(1);
  });
  it('prevents foreign project access and viewer writes across all mutation families', async () => {
    const p = await project(request),
      viewer = await member(instance.app, request, p.id, 'viewer'),
      view = client(instance.app, viewer.cookie);
    const other = await instance.store.createUser(
      'outsider@example.test',
      'Outsider',
      null,
    );
    const token = 'foreign-api-token';
    await instance.store.exec(
      "INSERT INTO sessions VALUES(?,?,?,'api')",
      hash(token),
      other.id,
      Date.now() + 60000,
    );
    expect(
      (
        await instance.app.inject({
          url: `/api/artifacts/${p.mainArtifactId}`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(404);
    const bundle = (
      await view('GET', `/api/artifacts/${p.mainArtifactId}`)
    ).json();
    expect(bundle.artifact.id).toBe(p.mainArtifactId);
    for (const [method, path, body] of [
      [
        'POST',
        `/api/projects/${p.id}/artifacts`,
        { kind: 'code', title: 'Denied' },
      ],
      [
        'PATCH',
        `/api/artifacts/${p.mainArtifactId}/title`,
        { title: 'Denied' },
      ],
      [
        'POST',
        `/api/artifacts/${p.mainArtifactId}/messages`,
        { threadId: bundle.threads[0].id, body: 'Denied' },
      ],
      [
        'POST',
        `/api/artifacts/${p.mainArtifactId}/threads`,
        { anchor: 'paragraph', quote: '', body: 'Denied' },
      ],
      [
        'POST',
        `/api/artifacts/${p.mainArtifactId}/links`,
        { label: 'Denied', url: 'https://example.test', kind: 'reference' },
      ],
      [
        'POST',
        `/api/projects/${p.id}/members`,
        { email: 'bad@example.test', name: 'Bad', role: 'owner' },
      ],
      ['POST', `/api/artifacts/${p.mainArtifactId}/runs`, {}],
    ] as const)
      expect((await view(method, path, body)).statusCode, path).toBe(403);
  });
  it('binds messages and comment resolution strictly to their artifact', async () => {
    const p = await project(request),
      a = (
        await request('POST', `/api/projects/${p.id}/artifacts`, {
          kind: 'document',
          title: 'Second artifact',
        })
      ).json();
    const b = (
      await request('GET', `/api/artifacts/${p.mainArtifactId}`)
    ).json();
    const cross = await request('POST', `/api/artifacts/${a.id}/messages`, {
      threadId: b.threads[0].id,
      body: 'Cross-artifact injection',
    });
    expect(cross.statusCode).toBe(404);
    const thread = await request('POST', `/api/artifacts/${a.id}/threads`, {
      anchor: 'stable-block-id',
      quote: 'The original requirement',
      body: 'Please clarify scope.',
    });
    expect(thread.statusCode).toBe(201);
    const tid = thread.json().id;
    expect(
      (
        await request(
          'PATCH',
          `/api/artifacts/${p.mainArtifactId}/threads/${tid}`,
          { resolved: true },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await request('PATCH', `/api/artifacts/${a.id}/threads/${tid}`, {
          resolved: true,
        })
      ).statusCode,
    ).toBe(200);
    const saved = (await request('GET', `/api/artifacts/${a.id}`)).json();
    expect(saved.threads.find((t: any) => t.id === tid)).toMatchObject({
      anchor: 'stable-block-id',
      quote: 'The original requirement',
      resolved: true,
    });
    expect(saved.messages[0].body).toBe('Please clarify scope.');
    expect(
      (await request('GET', `/api/artifacts/${p.mainArtifactId}`)).json()
        .messages,
    ).toEqual([]);
  });
  it('versions ADR decisions and preserves previous attributed decisions in audit', async () => {
    const p = await project(request),
      b = (await request('GET', `/api/artifacts/${p.mainArtifactId}`)).json(),
      adr = b.decisions[0];
    const change = {
      title: 'ADR · Artifact-scoped context',
      context: 'Need durable attribution',
      decision: 'Store threads with artifact foreign keys',
      consequences: 'No global conversation leakage',
      status: 'accepted',
      version: adr.version,
    };
    expect(
      (
        await request(
          'PUT',
          `/api/artifacts/${p.mainArtifactId}/decisions/${adr.id}`,
          change,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request(
          'PUT',
          `/api/artifacts/${p.mainArtifactId}/decisions/${adr.id}`,
          change,
        )
      ).statusCode,
    ).toBe(409);
    const saved = (
      await request('GET', `/api/artifacts/${p.mainArtifactId}`)
    ).json().decisions[0];
    expect(saved).toMatchObject({
      version: 2,
      status: 'accepted',
      author: 'Test owner',
    });
    const audit = (
      await request('GET', `/api/artifacts/${p.mainArtifactId}/history`)
    )
      .json()
      .audit.find((a: any) => a.action === 'decision.updated');
    expect(JSON.parse(audit.detail)).toMatchObject({
      previous: { status: 'proposed', version: 1 },
      next: { status: 'accepted' },
    });
  });
  it('protects the last project owner and immediately revokes former member API access', async () => {
    const p = await project(request);
    expect(
      (await request('DELETE', `/api/projects/${p.id}/members/${user.id}`))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await request('POST', `/api/projects/${p.id}/members`, {
          email: user.email,
          name: user.name,
          role: 'viewer',
        })
      ).statusCode,
    ).toBe(409);
    const editor = await member(instance.app, request, p.id, 'editor'),
      edit = client(instance.app, editor.cookie);
    expect(
      (await edit('GET', `/api/artifacts/${p.mainArtifactId}`)).statusCode,
    ).toBe(200);
    expect(
      (
        await request(
          'DELETE',
          `/api/projects/${p.id}/members/${editor.user.id}`,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await edit('GET', `/api/artifacts/${p.mainArtifactId}`)).statusCode,
    ).toBe(404);
  });
  it('archives secondary artifacts without allowing the main design or archived content to be edited', async () => {
    const p = await project(request),
      a = (
        await request('POST', `/api/projects/${p.id}/artifacts`, {
          kind: 'code',
          title: 'Archived prototype',
        })
      ).json();
    expect(
      (await request('POST', `/api/artifacts/${p.mainArtifactId}/archive`))
        .statusCode,
    ).toBe(409);
    expect(
      (await request('POST', `/api/artifacts/${a.id}/archive`)).statusCode,
    ).toBe(200);
    expect(
      (await request('GET', `/api/projects/${p.id}/artifacts`)).json(),
    ).toHaveLength(1);
    expect(
      (
        await request('PATCH', `/api/artifacts/${a.id}`, {
          version: 1,
          content: a.content,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await request('GET', `/api/artifacts/${a.id}/history`)).statusCode,
    ).toBe(200);
  });
  it('scopes uploads and rejects executable or misleading file types', async () => {
    const p = await project(request),
      boundary = 'studio-boundary';
    const upload = async (name: string, bytes: Buffer) =>
      instance.app.inject({
        method: 'POST',
        url: `/api/artifacts/${p.mainArtifactId}/files`,
        headers: {
          origin,
          cookie: `studio_session=${cookie}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`,
          ),
          bytes,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
    expect(
      (await upload('bad.svg', Buffer.from('<svg onload="alert(1)"></svg>')))
        .statusCode,
    ).toBe(400);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
      'base64',
    );
    const response = await upload('evidence.png', png);
    expect(response.statusCode, response.body).toBe(201);
    const file = await request('GET', response.json().url);
    expect(file.rawPayload).toEqual(png);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect((await instance.app.inject(response.json().url)).statusCode).toBe(
      401,
    );
  });
  it('serves isolated draft previews only to their owner with restrictive document policy', async () => {
    const p = await project(request),
      a = (
        await request('POST', `/api/projects/${p.id}/artifacts`, {
          kind: 'code',
          title: 'Isolated preview',
        })
      ).json();
    const html =
      '<main><h1>Preview document</h1><script>window.previewRan=true</script></main>';
    const response = await request('POST', `/api/artifacts/${a.id}/previews`, {
      html,
    });
    expect(response.statusCode, response.body).toBe(201);
    const path = response.json().url,
      result = await request('GET', path);
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe(html);
    expect(result.headers['content-security-policy']).toContain(
      'sandbox allow-scripts',
    );
    expect(result.headers['content-security-policy']).toContain(
      "connect-src 'none'",
    );
    expect(result.headers['content-security-policy']).toContain(
      "frame-ancestors 'self'",
    );
    expect(result.headers['cache-control']).toBe('no-store');
    const editor = await member(instance.app, request, p.id, 'editor');
    expect(
      (await client(instance.app, editor.cookie)('GET', path)).statusCode,
    ).toBe(404);
    expect((await instance.app.inject(path)).statusCode).toBe(401);
    const replacement = await request(
      'POST',
      `/api/artifacts/${a.id}/previews`,
      { html: '<h1>New draft</h1>' },
    );
    expect(replacement.statusCode).toBe(201);
    expect((await request('GET', path)).statusCode).toBe(404);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 121000);
    try {
      expect((await request('GET', replacement.json().url)).statusCode).toBe(
        404,
      );
    } finally {
      clock.mockRestore();
    }
    expect(
      (
        await request('POST', `/api/artifacts/${p.mainArtifactId}/previews`, {
          html,
        })
      ).statusCode,
    ).toBe(400);
  });
  it('issues scoped expiring agent tokens, rejects session-token bearer confusion and revokes tokens', async () => {
    const p = await project(request),
      response = await request('POST', '/api/tokens'),
      token = response.json().token;
    const bearer = () =>
      instance.app.inject({
        url: `/api/artifacts/${p.mainArtifactId}`,
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await bearer()).statusCode).toBe(200);
    expect(
      (
        await instance.store.one(
          'SELECT expires FROM sessions WHERE token=?',
          hash(token),
        )
      ).expires,
    ).toBeGreaterThan(Date.now());
    expect(
      (
        await instance.app.inject({
          url: '/api/me',
          headers: { authorization: `Bearer ${cookie}` },
        })
      ).statusCode,
    ).toBe(401);
    await request('DELETE', '/api/tokens');
    expect((await bearer()).statusCode).toBe(401);
    await request('POST', '/api/auth/logout');
    expect((await request('GET', '/api/me')).statusCode).toBe(401);
  });
  it('reports absent providers honestly and creates no successful test run', async () => {
    const p = await project(request),
      b = (await request('GET', `/api/artifacts/${p.mainArtifactId}`)).json();
    expect(
      (await request('POST', `/api/artifacts/${p.mainArtifactId}/runs`))
        .statusCode,
    ).toBe(503);
    expect(
      (await request('POST', `/api/artifacts/${p.mainArtifactId}/compile`))
        .statusCode,
    ).toBe(503);
    expect(
      (
        await request('POST', `/api/artifacts/${p.mainArtifactId}/agent`, {
          threadId: b.threads[0].id,
          intent: 'chat',
        })
      ).statusCode,
    ).toBe(503);
    expect(
      (await request('GET', `/api/artifacts/${p.mainArtifactId}`)).json().runs,
    ).toEqual([]);
  });
  it('rejects production startup with insecure defaults', () => {
    expect(() => settingsFromEnv({ NODE_ENV: 'production' })).toThrow('HTTPS');
    expect(() =>
      settingsFromEnv({
        NODE_ENV: 'production',
        STUDIO_ORIGIN: 'https://studio.example.test',
      }),
    ).toThrow('bootstrap password or OIDC');
    expect(() =>
      settingsFromEnv({
        NODE_ENV: 'production',
        STUDIO_ORIGIN: 'https://studio.example.test',
        STUDIO_DEMO: '1',
      }),
    ).toThrow('Demo access is forbidden');
    expect(() => settingsFromEnv({ STUDIO_ADMIN_PASSWORD: 'short' })).toThrow(
      '16 characters',
    );
    expect(() =>
      settingsFromEnv({ STUDIO_OIDC_ISSUER: 'https://identity.example.test' }),
    ).toThrow('OIDC requires');
  });
});
