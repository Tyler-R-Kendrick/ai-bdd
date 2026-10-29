import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { Store, hash } from '../server/store.ts';
import {
  openDatabase,
  postgresPoolConfig,
} from '../server/persistence/index.ts';
import { postgresQuery, postgresSchema } from '../server/persistence/sql.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function local() {
  const store = await Store.open(':memory:');
  cleanup.push(() => store.close());
  return store;
}
async function fixture(store: Store) {
  const user = await store.createUser(
      'owner-' + randomUUID() + '@example.test',
      'Owner',
      null,
    ),
    project = await store.createProject(
      user,
      'Shared project',
      'Asynchronous persistence',
    );
  return { user, project };
}

describe('asynchronous SQL adapter boundaries', () => {
  it('translates placeholders and row ordering without changing quoted literals or comments', () => {
    expect(
      postgresQuery(
        'SELECT \'?\' AS label,"?",rowid FROM messages WHERE id=? -- ?\n AND body=$tag$?$tag$ /* ? */',
      ),
    ).toBe(
      'SELECT \'?\' AS label,"?",ordinal FROM messages WHERE id=$1 -- ?\n AND body=$tag$?$tag$ /* ? */',
    );
    const columns = new Map<string, string[]>();
    const ddl = postgresSchema(
      'CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,body TEXT NOT NULL,bytes BLOB,n INTEGER);',
      columns,
    );
    expect(ddl).toContain('ordinal BIGSERIAL UNIQUE NOT NULL');
    expect(ddl).toContain('bytes BYTEA');
    expect(ddl).toContain('n BIGINT');
    expect(postgresQuery('INSERT INTO messages VALUES(?,?,?,?)', columns)).toBe(
      'INSERT INTO messages("id","body","bytes","n") VALUES($1,$2,$3,$4)',
    );
  });
  it('requires verified TLS for remote PostgreSQL without weakening URL sslmode semantics', () => {
    expect(
      postgresPoolConfig({
        url: 'postgresql://user:example@db.example.test/database?sslmode=require',
      }).ssl,
    ).toMatchObject({ rejectUnauthorized: true });
    expect(() =>
      postgresPoolConfig({
        url: 'postgresql://user:example@db.example.test/database?sslmode=disable',
      }),
    ).toThrow('certificate-verified TLS');
    expect(
      postgresPoolConfig({
        url: 'postgresql://studio:example@127.0.0.1/database?sslmode=disable',
      }).ssl,
    ).toBe(false);
  });
  it('isolates overlapping SQLite transactions and rolls back awaited nested callbacks', async () => {
    const store = await local();
    await store.db.exec(
      'CREATE TABLE test_transactions(id TEXT PRIMARY KEY,value TEXT)',
    );
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve)),
      ready = new Promise<void>((resolve) => (entered = resolve));
    const failing = store.tx(async () => {
      await store.exec(
        'INSERT INTO test_transactions VALUES(?,?)',
        'uncommitted',
        'private',
      );
      entered();
      await gate;
      await store.tx(async () => {
        throw new Error('rollback nested callback');
      });
    });
    await ready;
    const outside = store.one(
      'SELECT * FROM test_transactions WHERE id=?',
      'uncommitted',
    );
    release();
    await expect(failing).rejects.toThrow('rollback nested');
    expect(await outside).toBeUndefined();
  });
  it('stores immutable external file references, byte quotas and context without requiring inline bytes', async () => {
    const store = await local(),
      { user, project } = await fixture(store),
      bytes = Buffer.from('asset fixture');
    const file = await store.registerFile(user, project.mainArtifactId, {
      name: 'fixture.txt',
      mime: 'text/plain',
      sha256: hash(bytes),
      storageKey: 'sha256/' + hash(bytes),
      byteSize: bytes.length,
    });
    expect(file.bytes).toBeUndefined();
    expect(file.byteSize).toBe(bytes.length);
    expect(file.storageKey).toContain(hash(bytes));
    expect(
      (
        await store.one(
          'SELECT sum(byte_size) AS n FROM files WHERE project_id=?',
          project.id,
        )
      ).n,
    ).toBe(bytes.length);
    await expect(
      store.file(
        file.id,
        (await store.createUser('other@example.test', 'Other', null)).id,
      ),
    ).rejects.toThrow('Project not found');
  });
});
const pgURL = process.env.STUDIO_TEST_POSTGRES_URL;
describe.skipIf(!pgURL)('real PostgreSQL cross-instance persistence', () => {
  async function pair() {
    const schema = 'test_' + randomUUID().replaceAll('-', '');
    const firstDb = await openDatabase({
        adapter: 'postgres',
        url: pgURL!,
        schema,
      }),
      secondDb = await openDatabase({
        adapter: 'postgres',
        url: pgURL!,
        schema,
      });
    const first = await Store.open(firstDb),
      second = await Store.open(secondDb);
    cleanup.push(
      () => second.close(),
      () => first.close(),
    );
    return { first, second };
  }
  it('shares complete project/chat/ADR state and stable paginated message ordering across two instances', async () => {
    const { first, second } = await pair(),
      { user, project } = await fixture(first);
    const artifact = await second.artifact(project.mainArtifactId, user.id),
      thread = (await first.threads(artifact.id))[0];
    expect(await second.decisions(artifact.id)).toHaveLength(1);
    for (let index = 0; index < 205; index++)
      await first.message(user, artifact.id, thread.id, 'message ' + index);
    const latest = await second.messagePage(artifact.id, thread.id, {
        limit: 100,
      }),
      older = await second.messagePage(artifact.id, thread.id, {
        limit: 100,
        before: latest.nextCursor!,
      }),
      oldest = await second.messagePage(artifact.id, thread.id, {
        limit: 100,
        before: older.nextCursor!,
      });
    expect(
      [...oldest.messages, ...older.messages, ...latest.messages].map(
        (message) => message.body,
      ),
    ).toEqual(Array.from({ length: 205 }, (_, index) => 'message ' + index));
    await first.exec(
      'DELETE FROM memberships WHERE project_id=? AND user_id=?',
      project.id,
      user.id,
    );
    await expect(second.artifact(artifact.id, user.id)).rejects.toThrow(
      'Project not found',
    );
  });
  it('merges concurrent durable Yjs states without losing independent edits and fences stale replacements', async () => {
    const { first, second } = await pair(),
      { user, project } = await fixture(first);
    const artifact = await first.createArtifact(
      user,
      project.id,
      'document',
      'Concurrent source',
      {
        doc: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Alpha' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Beta' }] },
          ],
        },
      },
    );
    const a = new Y.Doc(),
      b = new Y.Doc();
    try {
      const seedA = await first.documentState(artifact.id, user.id),
        seedB = await second.documentState(artifact.id, user.id);
      expect(hash(seedA)).toBe(hash(seedB));
      Y.applyUpdate(a, seedA);
      Y.applyUpdate(b, seedB);
      (
        (a.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText
      ).insert(0, 'First ');
      (
        (b.getXmlFragment('default').get(1) as Y.XmlElement).get(0) as Y.XmlText
      ).insert(0, 'Second ');
      await Promise.all([
        first.persistDoc(user, artifact.id, Y.encodeStateAsUpdate(a), {}),
        second.persistDoc(user, artifact.id, Y.encodeStateAsUpdate(b), {}),
      ]);
      const merged = await first.artifact(artifact.id, user.id);
      expect(JSON.stringify(merged.content)).toContain('First Alpha');
      expect(JSON.stringify(merged.content)).toContain('Second Beta');
      expect(merged.version).toBe(3);
      await expect(
        first.persistDoc(
          user,
          artifact.id,
          Y.encodeStateAsUpdate(a),
          {},
          undefined,
          1,
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      const before = await first.state(artifact.id);
      (
        (a.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText
      ).insert(0, 'Rollback ');
      await expect(
        first.persistDoc(
          user,
          artifact.id,
          Y.encodeStateAsUpdate(a),
          {},
          async () => {
            await first.exec(
              'INSERT INTO audit(project_id,artifact_id,actor,action,detail,created_at) VALUES(?,?,?,?,?,?)',
              project.id,
              artifact.id,
              user.name,
              'rollback-only',
              '',
              new Date().toISOString(),
            );
            throw new Error('hook fails after SQL');
          },
        ),
      ).rejects.toThrow('hook fails');
      expect(hash((await second.state(artifact.id))!)).toBe(hash(before!));
      expect(
        (
          await second.one(
            'SELECT count(*) AS n FROM audit WHERE action=?',
            'rollback-only',
          )
        ).n,
      ).toBe(0);
    } finally {
      a.destroy();
      b.destroy();
    }
  });
});
