import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { hash } from '../server/store.ts';
import {
  client,
  member,
  project,
  setup,
  testSettings,
  type TestApp,
} from './helpers.ts';
describe('Artifact discussion pagination and complete streamed exports', () => {
  let instance: TestApp,
    request: ReturnType<typeof client>,
    cookie: string,
    user: any;
  const settings = testSettings('/tmp/studio-message-test');
  beforeEach(async () => {
    settings.origin = 'http://127.0.0.1:8787';
    instance = await createApp(settings, { db: ':memory:' });
    ({ cookie, user } = await setup(instance.app));
    request = client(instance.app, cookie);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await instance.app.close();
  });
  async function seed(
    artifactId: string,
    threadId: string,
    count: number,
    prefix = 'message',
  ) {
    return await instance.store.tx(async () => {
      const saved = [];
      for (let index = 0; index < count; index++)
        saved.push(
          await instance.store.message(
            user,
            artifactId,
            threadId,
            `${prefix} ${index}`,
          ),
        );
      return saved;
    });
  }
  const pageUrl = (
    artifactId: string,
    threadId: string,
    extra: Record<string, string> = {},
  ) =>
    `/api/artifacts/${artifactId}/messages?${new URLSearchParams({ threadId, ...extra })}`;
  it('reads every one of 1001 messages exactly once through exclusive, chronological UUID pages', async () => {
    const p = await project(request),
      thread = (await instance.store.threads(p.mainArtifactId))[0];
    const saved = await seed(p.mainArtifactId, thread.id, 1001);
    // Equal timestamps must not duplicate or skip rows at cursor boundaries.
    await instance.store.exec(
      'UPDATE messages SET created_at=? WHERE artifact_id=?',
      '2026-10-29T00:00:00.000Z',
      p.mainArtifactId,
    );
    const first = await request('GET', pageUrl(p.mainArtifactId, thread.id));
    expect(first.statusCode).toBe(200);
    let page = first.json();
    expect(page.messages).toHaveLength(100);
    expect(page.messages[0].body).toBe('message 901');
    expect(page.messages.at(-1).body).toBe('message 1000');
    expect(page).toMatchObject({ hasMore: true, nextCursor: saved[901]!.id });
    const exclusive = (
      await request(
        'GET',
        pageUrl(p.mainArtifactId, thread.id, {
          before: page.nextCursor,
          limit: '1',
        }),
      )
    ).json();
    expect(exclusive.messages.map((message: any) => message.body)).toEqual([
      'message 900',
    ]);
    let all = page.messages;
    while (page.hasMore) {
      const response = await request(
        'GET',
        pageUrl(p.mainArtifactId, thread.id, {
          before: page.nextCursor,
          limit: '200',
        }),
      );
      expect(response.statusCode).toBe(200);
      page = response.json();
      expect(page.messages.length).toBeLessThanOrEqual(200);
      all = [...page.messages, ...all];
    }
    expect(page.nextCursor).toBeNull();
    expect(all.map((message: any) => message.id)).toEqual(
      saved.map((message) => message.id),
    );
    expect(all[0].body).toBe('message 0');
    expect(new Set(all.map((message: any) => message.id)).size).toBe(1001);
    expect(
      (await instance.store.threads(p.mainArtifactId))[0].messageCount,
    ).toBe(1001);
    const bundle = (
      await request('GET', `/api/artifacts/${p.mainArtifactId}`)
    ).json();
    expect(bundle.messages).toHaveLength(100);
    expect(bundle.messages.at(-1).body).toBe('message 1000');
  });
  it('scopes threads and cursors to both the artifact and discussion', async () => {
    const p = await project(request),
      firstThread = (await instance.store.threads(p.mainArtifactId))[0];
    const first = await seed(p.mainArtifactId, firstThread.id, 2);
    const second = await instance.store.createArtifact(
        user,
        p.id,
        'document',
        'Another artifact',
      ),
      secondThread = (await instance.store.threads(second.id))[0];
    const foreign = (await seed(second.id, secondThread.id, 1, 'foreign'))[0]!;
    const commentId = randomUUID();
    await instance.store.exec(
      'INSERT INTO threads(id,artifact_id,anchor,quote,created_at) VALUES(?,?,?,?,?)',
      commentId,
      p.mainArtifactId,
      'paragraph-a',
      'Original requirement',
      new Date().toISOString(),
    );
    const comment = (await seed(p.mainArtifactId, commentId, 1, 'comment'))[0]!;
    for (const url of [
      pageUrl(p.mainArtifactId, secondThread.id),
      pageUrl(p.mainArtifactId, firstThread.id, { before: foreign.id }),
      pageUrl(p.mainArtifactId, firstThread.id, { before: comment.id }),
      pageUrl(second.id, secondThread.id, { before: first[0]!.id }),
      pageUrl(p.mainArtifactId, randomUUID()),
      pageUrl(p.mainArtifactId, firstThread.id, { before: randomUUID() }),
    ])
      expect((await request('GET', url)).statusCode).toBe(404);
    const scoped = (
      await request('GET', pageUrl(p.mainArtifactId, firstThread.id))
    ).json();
    expect(scoped.messages.map((message: any) => message.body)).toEqual([
      'message 0',
      'message 1',
    ]);
  });
  it('validates bounded pages, allows viewers, and denies nonmembers', async () => {
    const p = await project(request),
      thread = (await instance.store.threads(p.mainArtifactId))[0];
    for (const limit of ['0', '-1', '201', '1.5', 'NaN'])
      expect(
        (await request('GET', pageUrl(p.mainArtifactId, thread.id, { limit })))
          .statusCode,
      ).toBe(400);
    expect(
      (await request('GET', `/api/artifacts/${p.mainArtifactId}/messages`))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await request(
          'GET',
          pageUrl(p.mainArtifactId, thread.id, { before: 'not-a-uuid' }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request(
          'GET',
          pageUrl(p.mainArtifactId, thread.id, { sort: 'arbitrary' }),
        )
      ).statusCode,
    ).toBe(400);
    const viewer = await member(instance.app, request, p.id, 'viewer');
    const reader = client(instance.app, viewer.cookie);
    expect(
      (await reader('GET', pageUrl(p.mainArtifactId, thread.id))).json(),
    ).toEqual({ messages: [], hasMore: false, nextCursor: null });
    expect(
      (await reader('GET', `/api/artifacts/${p.mainArtifactId}/export`))
        .statusCode,
    ).toBe(200);
    expect(
      (await instance.app.inject(pageUrl(p.mainArtifactId, thread.id)))
        .statusCode,
    ).toBe(401);
    const outsider = await instance.store.createUser(
        'outsider@example.test',
        'Outsider',
        null,
      ),
      token = randomUUID();
    await instance.store.exec(
      'INSERT INTO sessions VALUES(?,?,?,?)',
      hash(token),
      outsider.id,
      Date.now() + 10000,
      'session',
    );
    const denied = client(instance.app, token);
    expect(
      (await denied('GET', pageUrl(p.mainArtifactId, thread.id))).statusCode,
    ).toBe(404);
    expect(
      (await denied('GET', `/api/artifacts/${p.mainArtifactId}/export`))
        .statusCode,
    ).toBe(404);
  });
  it('streams the complete JSON export without the bounded bundle message window', async () => {
    const p = await project(request),
      thread = (await instance.store.threads(p.mainArtifactId))[0];
    const saved = await seed(p.mainArtifactId, thread.id, 1001);
    const commentId = randomUUID();
    await instance.store.exec(
      'INSERT INTO threads(id,artifact_id,anchor,quote,created_at) VALUES(?,?,?,?,?)',
      commentId,
      p.mainArtifactId,
      'paragraph-a',
      'Quoted requirement',
      new Date().toISOString(),
    );
    await seed(p.mainArtifactId, commentId, 3, 'comment');
    const special = await instance.store.message(
      user,
      p.mainArtifactId,
      thread.id,
      'Quotes " and newlines\n<markup> and unicode λ',
      'assistant',
      { summary: 'A proposal', version: 1 },
    );
    const other = await instance.store.createArtifact(
      user,
      p.id,
      'document',
      'Excluded artifact',
    );
    await seed(
      other.id,
      (await instance.store.threads(other.id))[0].id,
      5,
      'excluded',
    );
    vi.spyOn(instance.store, 'messages').mockImplementation(() => {
      throw new Error('Export must not use the bounded bundle history');
    });
    const response = await request(
      'GET',
      `/api/artifacts/${p.mainArtifactId}/export`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers).not.toHaveProperty('content-length');
    const result = response.json();
    expect(result.schemaVersion).toBe(1);
    expect(result.artifact.id).toBe(p.mainArtifactId);
    expect(result.messages).toHaveLength(1005);
    expect(result.messages[0].id).toBe(saved[0]!.id);
    expect(result.messages.at(-1)).toMatchObject({
      id: special.id,
      proposal: { summary: 'A proposal', version: 1 },
    });
    expect(
      result.messages.every(
        (message: any) => message.artifactId === p.mainArtifactId,
      ),
    ).toBe(true);
    expect(result.threads).toHaveLength(2);
    expect(result.decisions).toHaveLength(1);
    expect(result.links).toEqual([]);
  });
  it('excludes messages appended after a real streamed download starts', async () => {
    const p = await project(request),
      thread = (await instance.store.threads(p.mainArtifactId))[0];
    await seed(p.mainArtifactId, thread.id, 1001);
    const address = await instance.app.listen({ host: '127.0.0.1', port: 0 });
    settings.origin = address;
    const response = await fetch(
      `${address}/api/artifacts/${p.mainArtifactId}/export`,
      { headers: { cookie: `studio_session=${cookie}` } },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(),
      first = await reader.read();
    expect(first.done).toBe(false);
    await instance.store.message(
      user,
      p.mainArtifactId,
      thread.id,
      'Posted during the download',
    );
    const chunks = [Buffer.from(first.value!)];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(Buffer.from(chunk.value));
    }
    const exported = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(exported.messages).toHaveLength(1001);
    expect(exported.messages.at(-1).body).toBe('message 1000');
    expect((await instance.store.messages(p.mainArtifactId)).at(-1)!.body).toBe(
      'Posted during the download',
    );
  });
});
