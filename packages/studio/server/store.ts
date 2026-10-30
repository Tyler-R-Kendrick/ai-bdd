import { canonicalDocumentIds } from '../shared/document-identity.ts';
import { openDatabase, type SqlDatabase } from './persistence/index.ts';
import * as Y from 'yjs';
import {
  prosemirrorJSONToYDoc,
  prosemirrorToYXmlFragment,
  yXmlFragmentToProsemirrorJSON,
} from 'y-prosemirror';
import { editorSchema } from '../shared/editor.ts';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import {
  capability,
  initialContent,
  validateContent,
  type Artifact,
  type ArtifactKind,
  type Role,
  type User,
  type Message,
  type RichNode,
} from '../shared/domain.ts';
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export const hash = (s: string | Uint8Array) =>
  createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
const artifactCols =
  'id, project_id AS projectId, kind, title, content, version, updated_at AS updatedAt, created_at AS createdAt, created_by AS createdBy, archived';
const messageCols =
  'id,artifact_id AS artifactId,thread_id AS threadId,author,author_id AS authorId,role,body,proposal,created_at AS createdAt';
export type OrderedMessage = Message & {
  sequence: number;
};
export type MessagePage = {
  messages: OrderedMessage[];
  nextCursor: string | null;
  hasMore: boolean;
};
export type ExportTable =
  | 'decisions'
  | 'threads'
  | 'messages'
  | 'links'
  | 'runs'
  | 'revisions'
  | 'audit'
  | 'files';
const exportColumns: Record<ExportTable, string> = {
  decisions:
    'id,artifact_id AS artifactId,title,context,decision,consequences,status,version,author,updated_at AS updatedAt',
  threads:
    'id,artifact_id AS artifactId,anchor,quote,resolved,created_at AS createdAt',
  messages: messageCols,
  links: 'id,label,url,kind,state,updated_at AS updatedAt',
  runs: 'id,artifact_version AS artifactVersion,status,result,error,created_at AS createdAt,finished_at AS finishedAt',
  revisions: 'version,content,actor,created_at AS createdAt',
  audit: 'id,actor,action,detail,created_at AS createdAt',
  files: 'id,name,mime,sha256,byte_size AS byteSize,created_at AS createdAt',
};
const readMessage = (row: any): OrderedMessage => ({
  ...row,
  proposal: row.proposal ? JSON.parse(row.proposal) : null,
});
export const STUDIO_SCHEMA_VERSION = 2;
export class Store {
  sourceObserver?: (
    user: User,
    previous: Artifact,
    current: Artifact,
  ) => Promise<void>;
  contentReferenceValidator?: (input: {
    kind: ArtifactKind;
    projectId: string;
    artifactId: string;
    content: Record<string, any>;
  }) => Promise<void>;
  fileQuotaReservations?: (
    projectId: string,
    exemptFileId: string,
  ) => Promise<number>;
  artifactWriteGuard?: (artifact: Artifact, userId: string) => Promise<void>;
  repositoryAuthorizer?: (
    projectId: string,
    userId: string,
    action: 'read' | 'write' | 'admin',
    atomic: boolean,
  ) => Promise<void>;
  private constructor(readonly db: SqlDatabase) {}
  static async open(input: string | SqlDatabase): Promise<Store> {
    const db =
      typeof input === 'string'
        ? await openDatabase({ adapter: 'sqlite', file: input })
        : input;
    const store = new Store(db);
    try {
      await store.initialize();
      return store;
    } catch (error) {
      await db.close();
      throw error;
    }
  }
  private async initialize() {
    await this.db.transaction(async () => {
      await this.db.lock('schema:studio.core');
      let version: number;
      if (this.db.dialect === 'sqlite')
        version = (await this.db.one('PRAGMA user_version')).user_version;
      else {
        await this.db.exec(
          'CREATE TABLE IF NOT EXISTS studio_schema(id INTEGER PRIMARY KEY,version INTEGER NOT NULL)',
        );
        version =
          (await this.db.one('SELECT version FROM studio_schema WHERE id=1'))
            ?.version ?? 0;
      }
      if (version > STUDIO_SCHEMA_VERSION)
        throw new Error(
          'This database was created by a newer Studio version; refusing an unsafe downgrade',
        );
      await this.db.exec(`
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT,color TEXT NOT NULL,oidc_sub TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL,kind TEXT NOT NULL DEFAULT 'session');
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,repository TEXT NOT NULL DEFAULT '',main_artifact_id TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),PRIMARY KEY(project_id,user_id));
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,kind TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,ystate BLOB,updated_at TEXT NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,title TEXT NOT NULL,context TEXT NOT NULL,decision TEXT NOT NULL,consequences TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'proposed',version INTEGER NOT NULL DEFAULT 1,author TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,anchor TEXT,quote TEXT NOT NULL DEFAULT '',resolved INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,thread_id TEXT NOT NULL REFERENCES threads(id),author_id TEXT NOT NULL REFERENCES users(id),author TEXT NOT NULL,role TEXT NOT NULL,body TEXT NOT NULL,proposal TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,version INTEGER NOT NULL,content TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(artifact_id,version));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,artifact_id TEXT REFERENCES artifacts(id) ON DELETE CASCADE,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,artifact_version INTEGER NOT NULL,status TEXT NOT NULL,result TEXT,error TEXT,created_at TEXT NOT NULL,finished_at TEXT);
      CREATE TABLE IF NOT EXISTS studio_runner_jobs(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,job_id TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,name TEXT NOT NULL,mime TEXT NOT NULL,sha256 TEXT NOT NULL,bytes BLOB NOT NULL,created_at TEXT NOT NULL,storage_key TEXT,byte_size BIGINT NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS links(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,label TEXT NOT NULL,url TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'unknown',updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project_id,archived);
      CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id,created_at);
      CREATE INDEX IF NOT EXISTS messages_artifact ON messages(artifact_id);
      CREATE INDEX IF NOT EXISTS messages_artifact_thread ON messages(artifact_id,thread_id);
      CREATE INDEX IF NOT EXISTS threads_artifact ON threads(artifact_id);
      CREATE INDEX IF NOT EXISTS decisions_artifact ON decisions(artifact_id);
      CREATE INDEX IF NOT EXISTS links_artifact ON links(artifact_id);
      CREATE INDEX IF NOT EXISTS runs_artifact ON runs(artifact_id,created_at);
      CREATE INDEX IF NOT EXISTS audit_project ON audit(project_id,id);
`);
      if (this.db.dialect === 'sqlite') {
        const columns = await this.db.all<{
          name: string;
        }>('PRAGMA table_info(files)');
        if (!columns.some((column) => column.name === 'storage_key'))
          await this.db.exec('ALTER TABLE files ADD COLUMN storage_key TEXT');
        if (!columns.some((column) => column.name === 'byte_size'))
          await this.db.exec(
            'ALTER TABLE files ADD COLUMN byte_size BIGINT NOT NULL DEFAULT 0',
          );
        await this.db.exec('PRAGMA user_version=2');
      } else
        await this.db.run(
          'INSERT INTO studio_schema(id,version) VALUES(1,2) ON CONFLICT(id) DO UPDATE SET version=excluded.version',
        );
      await this.db.run(
        'UPDATE files SET byte_size=length(bytes) WHERE storage_key IS NULL AND byte_size=0',
      );
    });
  }
  one(sql: string, ...args: any[]): Promise<any> {
    return this.db.one(sql, args);
  }
  all(sql: string, ...args: any[]): Promise<any[]> {
    return this.db.all(sql, args);
  }
  async exec(sql: string, ...args: any[]) {
    if (!args.length && /^\s*(CREATE|ALTER|DROP|PRAGMA)\b/i.test(sql)) {
      await this.db.exec(sql);
      return { changes: 0 };
    }
    return this.db.run(sql, args);
  }
  tx<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.db.transaction(async () => fn());
  }
  lock(key: string) {
    return this.db.lock(key);
  }
  close() {
    return this.db.close();
  }
  async publicUser(id: string): Promise<User> {
    const u = await this.one(
      'SELECT id,email,name,color FROM users WHERE id=?',
      id,
    );
    if (!u) throw new HttpError(401, 'Sign in to continue');
    return u;
  }
  async userByEmail(email: string) {
    return await this.one(
      'SELECT * FROM users WHERE email=?',
      email.toLowerCase(),
    );
  }
  async createUser(
    email: string,
    name: string,
    password: string | null,
    sub: string | null = null,
  ): Promise<User> {
    const id = randomUUID();
    const color = ['#6b73d1', '#378469', '#b06440', '#8a5eb0'][
      parseInt(id[0]!, 16) % 4
    ]!;
    await this.exec(
      'INSERT INTO users(id,email,name,password,color,oidc_sub) VALUES(?,?,?,?,?,?)',
      id,
      email.toLowerCase(),
      name,
      password,
      color,
      sub,
    );
    return await this.publicUser(id);
  }
  async role(
    projectId: string,
    userId: string,
    action: 'read' | 'write' | 'admin' = 'read',
  ): Promise<Role> {
    const r = (
      await this.one(
        'SELECT role FROM memberships WHERE project_id=? AND user_id=?',
        projectId,
        userId,
      )
    )?.role as Role | undefined;
    if (!r) throw new HttpError(404, 'Project not found');
    if (!capability(r, action))
      throw new HttpError(403, 'Your project role does not allow this action');
    await this.repositoryAuthorizer?.(
      projectId,
      userId,
      action,
      this.db.inTransaction(),
    );
    return r;
  }
  async artifact(
    id: string,
    userId: string,
    action: 'read' | 'write' | 'admin' = 'read',
  ): Promise<Artifact> {
    const a = await this.one(
      `SELECT ${artifactCols} FROM artifacts WHERE id=?`,
      id,
    );
    if (!a) throw new HttpError(404, 'Artifact not found');
    await this.role(a.projectId, userId, action);
    if (a.archived && action !== 'read')
      throw new HttpError(409, 'This artifact is archived');
    return { ...a, content: JSON.parse(a.content), archived: !!a.archived };
  }
  async artifacts(projectId: string, userId: string) {
    await this.role(projectId, userId);
    return (
      await this.all(
        `SELECT ${artifactCols} FROM artifacts WHERE project_id=? AND archived=0 ORDER BY created_at,id`,
        projectId,
      )
    ).map((a) => ({
      ...a,
      content: JSON.parse(a.content),
      archived: !!a.archived,
    }));
  }
  async projects(userId: string) {
    return await this.all(
      'SELECT p.id,p.title,p.description,p.repository,p.main_artifact_id AS mainArtifactId,p.updated_at AS updatedAt,m.role FROM projects p JOIN memberships m ON m.project_id=p.id WHERE m.user_id=? ORDER BY p.updated_at DESC',
      userId,
    );
  }
  async audit(
    projectId: string,
    artifactId: string | null,
    actor: string,
    action: string,
    detail = '',
  ) {
    await this.exec(
      'INSERT INTO audit(project_id,artifact_id,actor,action,detail,created_at) VALUES(?,?,?,?,?,?)',
      projectId,
      artifactId,
      actor,
      action,
      detail,
      now(),
    );
  }
  async checkedContent(
    kind: ArtifactKind,
    content: unknown,
    projectId: string,
    artifactId = '',
  ): Promise<Record<string, any>> {
    let parsed: Record<string, any>;
    try {
      parsed = validateContent(kind, content);
    } catch (error) {
      if (error instanceof Error && 'issues' in error) throw error;
      throw new HttpError(400, (error as Error).message);
    }
    const assets = new Map<string, Set<string>>(),
      references = new Set<string>(),
      runReferences = new Set<string>();
    const file = (url: unknown, mime: string) => {
      if (typeof url !== 'string' || !/^\/api\/files\/[0-9a-f-]{36}$/.test(url))
        throw new HttpError(
          400,
          'Media must reference an uploaded project file',
        );
      const id = url.split('/').pop()!;
      if (!assets.has(id)) assets.set(id, new Set());
      assets.get(id)!.add(mime);
    };
    if (['image', 'brand', 'video'].includes(kind))
      for (const layer of parsed.layers ?? []) {
        if (layer.type === 'image') file(layer.src, 'image');
        if (layer.fontUrl) file(layer.fontUrl, 'font/woff2');
        if (layer.fontFamily === 'Generated' && !parsed.fontDesign)
          throw new HttpError(
            400,
            'Generated font layers require an editable font design',
          );
      }
    if (kind === 'audio')
      for (const track of parsed.tracks)
        for (const clip of track.clips) file(clip.src, 'audio');
    if (kind === 'midi' && parsed.sourceSrc)
      file(parsed.sourceSrc, 'audio/midi');
    if (kind === 'video')
      for (const clip of parsed.clips ?? []) {
        if (['image', 'audio', 'video'].includes(clip.type))
          file(clip.src, clip.type);
        if (clip.fontUrl) file(clip.fontUrl, 'font/woff2');
      }
    if (kind === 'scene' || kind === 'cad')
      for (const asset of parsed.imports ?? []) {
        if (asset.format === 'step' && kind !== 'cad')
          throw new HttpError(400, 'STEP files require the exact CAD editor');
        file(
          asset.src,
          (
            {
              glb: 'model/gltf-binary',
              stl: 'model/stl',
              step: 'model/step',
            } as Record<string, string>
          )[asset.format]!,
        );
      }
    if (kind === 'design' || kind === 'document') {
      const walk = (node: any) => {
        if (node.type === 'image') file(node.attrs?.src, 'image');
        if (
          node.type === 'artifactReferenceBlock' &&
          node.attrs?.data?.artifactId !==
            '00000000-0000-4000-8000-000000000000'
        )
          references.add(node.attrs?.data?.artifactId);
        if (node.type === 'evidenceBlock' && node.attrs?.data?.runId)
          runReferences.add(node.attrs.data.runId);
        for (const mark of node.marks ?? [])
          if (
            mark.type === 'link' &&
            !(
              typeof mark.attrs?.href === 'string' &&
              /^(https?:\/\/|mailto:|#)/i.test(mark.attrs.href)
            )
          )
            throw new HttpError(
              400,
              'Document links must use HTTP, HTTPS, mailto, or an anchor',
            );
        for (const child of node.content ?? []) walk(child);
      };
      parsed.doc = canonicalDocumentIds(parsed.doc, randomUUID).doc;
      walk(parsed.doc);
    }
    if (assets.size) {
      const rows = await this.all(
          'SELECT id,mime FROM files WHERE project_id=? AND id IN (' +
            [...assets].map(() => '?').join(',') +
            ')',
          projectId,
          ...assets.keys(),
        ),
        found = new Map(rows.map((row) => [row.id, row.mime]));
      for (const [id, wanted] of assets) {
        const mime = found.get(id);
        for (const expected of wanted)
          if (
            !mime ||
            (kind === 'audio' && mime === 'audio/midi') ||
            !(['image', 'audio', 'video'].includes(expected)
              ? mime.startsWith(expected + '/') ||
                (expected === 'audio' && mime === 'video/webm')
              : mime === expected)
          )
            throw new HttpError(
              400,
              'An uploaded asset is missing, has the wrong type, or belongs to another project',
            );
      }
    }
    if (references.size) {
      const rows = await this.all(
        'SELECT id FROM artifacts WHERE project_id=? AND id IN (' +
          [...references].map(() => '?').join(',') +
          ')',
        projectId,
        ...references,
      );
      if (rows.length !== references.size)
        throw new HttpError(
          400,
          'Document references must stay within their project',
        );
    }
    if (runReferences.size) {
      const rows = await this.all(
        'SELECT r.id FROM runs r JOIN artifacts a ON a.id=r.artifact_id WHERE a.project_id=? AND r.id IN (' +
          [...runReferences].map(() => '?').join(',') +
          ')',
        projectId,
        ...runReferences,
      );
      if (rows.length !== runReferences.size)
        throw new HttpError(400, 'Evidence must belong to this project');
    }
    await this.contentReferenceValidator?.({
      kind,
      projectId,
      artifactId,
      content: parsed,
    });
    return parsed;
  }
  async createProject(
    user: User,
    title: string,
    description: string,
    repository = '',
  ) {
    return await this.tx(async () => {
      await this.db.lock('user:' + user.id);
      if ((await this.projects(user.id)).length >= 100)
        throw new HttpError(
          409,
          'This account has reached its 100-project limit',
        );
      const id = randomUUID(),
        mainId = randomUUID();
      await this.exec(
        'INSERT INTO projects VALUES(?,?,?,?,?,?)',
        id,
        title,
        description,
        repository,
        mainId,
        now(),
      );
      await this.exec(
        'INSERT INTO memberships VALUES(?,?,?)',
        id,
        user.id,
        'owner',
      );
      await this.insertArtifact(
        user,
        id,
        'design',
        title + ' — design',
        mainId,
      );
      await this.audit(id, null, user.name, 'project.created', title);
      return (await this.projects(user.id)).find((p) => p.id === id);
    });
  }
  async insertArtifact(
    user: User,
    projectId: string,
    kind: ArtifactKind,
    title: string,
    id = randomUUID(),
    content = initialContent(kind, title),
  ): Promise<Artifact> {
    return this.tx(async () => {
      await this.db.lock('project:' + projectId);
      await this.role(projectId, user.id, 'write');
      if (
        (
          await this.one(
            'SELECT count(*) AS n FROM artifacts WHERE project_id=?',
            projectId,
          )
        ).n >= 500
      )
        throw new HttpError(
          409,
          'This project has reached its 500-artifact limit',
        );
      let validated = await this.checkedContent(kind, content, projectId, id),
        ystate: Uint8Array | null = null;
      if (kind === 'design' || kind === 'document') {
        const doc = prosemirrorJSONToYDoc(
          editorSchema(),
          validated.doc,
          'default',
        );
        try {
          ystate = Y.encodeStateAsUpdate(doc);
          validated = {
            doc: yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default')),
          };
        } finally {
          doc.destroy();
        }
      }
      const c = JSON.stringify(validated),
        t = now();
      await this.exec(
        'INSERT INTO artifacts(id,project_id,kind,title,content,updated_at,created_at,created_by,ystate) VALUES(?,?,?,?,?,?,?,?,?)',
        id,
        projectId,
        kind,
        title,
        c,
        t,
        t,
        user.id,
        ystate,
      );
      await this.exec(
        'INSERT INTO revisions(artifact_id,version,content,actor,created_at) VALUES(?,?,?,?,?)',
        id,
        1,
        c,
        user.name,
        t,
      );
      await this.exec(
        'INSERT INTO decisions(id,artifact_id,title,context,decision,consequences,author,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        randomUUID(),
        id,
        'ADR · ' + title,
        'Why does this artifact exist?',
        'Record the chosen approach and its owner.',
        'Record tradeoffs and alternatives.',
        user.name,
        t,
      );
      await this.exec(
        'INSERT INTO threads(id,artifact_id,created_at) VALUES(?,?,?)',
        randomUUID(),
        id,
        t,
      );
      await this.audit(projectId, id, user.name, 'artifact.created', kind);
      return await this.artifact(id, user.id);
    });
  }
  async createArtifact(
    user: User,
    projectId: string,
    kind: ArtifactKind,
    title: string,
    content?: Record<string, any>,
  ) {
    return this.tx(async () => {
      await this.db.lock('project:' + projectId);
      await this.role(projectId, user.id, 'write');
      return this.insertArtifact(
        user,
        projectId,
        kind,
        title,
        undefined,
        content,
      );
    });
  }
  async updateArtifact(
    user: User,
    id: string,
    version: number,
    content: unknown,
    title?: string,
    onPersist?: () => void | Promise<void>,
  ): Promise<Artifact> {
    const initial = await this.artifact(id, user.id, 'write');
    return this.tx(async () => {
      await this.db.lock('project:' + initial.projectId);
      const a = await this.artifact(id, user.id, 'write');
      await this.artifactWriteGuard?.(a, user.id);
      let validated = await this.checkedContent(
          a.kind,
          content,
          a.projectId,
          a.id,
        ),
        ystate = await this.state(id);
      if (a.kind === 'design' || a.kind === 'document') {
        const doc = ystate
          ? new Y.Doc()
          : prosemirrorJSONToYDoc(editorSchema(), validated.doc, 'default');
        try {
          if (ystate) {
            Y.applyUpdate(doc, ystate);
            doc.transact(
              () =>
                prosemirrorToYXmlFragment(
                  editorSchema().nodeFromJSON(validated.doc),
                  doc.getXmlFragment('default'),
                ),
              'versioned-source',
            );
          }
          ystate = Y.encodeStateAsUpdate(doc);
          validated = {
            doc: yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default')),
          };
        } finally {
          doc.destroy();
        }
      }
      const c = JSON.stringify(validated),
        t = now();
      const r = await this.exec(
        'UPDATE artifacts SET content=?,title=?,ystate=?,version=version+1,updated_at=? WHERE id=? AND version=?',
        c,
        title ?? a.title,
        ystate,
        t,
        id,
        version,
      );
      if (r.changes !== 1)
        throw new HttpError(
          409,
          'This artifact changed. Reload the latest version before saving.',
        );
      await this.exec(
        'INSERT INTO revisions(artifact_id,version,content,actor,created_at) VALUES(?,?,?,?,?)',
        id,
        version + 1,
        c,
        user.name,
        t,
      );
      await this.exec(
        'UPDATE projects SET updated_at=? WHERE id=?',
        t,
        a.projectId,
      );
      await this.audit(
        a.projectId,
        id,
        user.name,
        'artifact.updated',
        `version ${version + 1}`,
      );
      await onPersist?.();
      const current = await this.artifact(id, user.id);
      await this.sourceObserver?.(user, a, current);
      return current;
    });
  }
  async state(id: string): Promise<Uint8Array | null> {
    return (
      (await this.one('SELECT ystate FROM artifacts WHERE id=?', id))?.ystate ??
      null
    );
  }
  async documentState(id: string, userId: string): Promise<Uint8Array> {
    const initial = await this.artifact(id, userId);
    return this.tx(async () => {
      await this.db.lock('project:' + initial.projectId);
      const artifact = await this.artifact(id, userId);
      if (artifact.kind !== 'design' && artifact.kind !== 'document')
        throw new HttpError(400, 'This artifact uses a versioned media editor');
      const existing = await this.state(id);
      if (existing) return new Uint8Array(existing);
      const doc = prosemirrorJSONToYDoc(
        editorSchema(),
        artifact.content.doc,
        'default',
      );
      try {
        const state = Y.encodeStateAsUpdate(doc);
        await this.exec('UPDATE artifacts SET ystate=? WHERE id=?', state, id);
        return state;
      } finally {
        doc.destroy();
      }
    });
  }
  async persistDoc(
    user: User,
    id: string,
    state: Uint8Array,
    _content: Record<string, any>,
    onPersist?: () => void | Promise<void>,
    expectedVersion?: number,
  ): Promise<{ state: Uint8Array; artifact: Artifact }> {
    const initial = await this.artifact(id, user.id, 'write');
    return this.tx(async () => {
      await this.db.lock('project:' + initial.projectId);
      const artifact = await this.artifact(id, user.id, 'write');
      await this.artifactWriteGuard?.(artifact, user.id);
      if (expectedVersion !== undefined && artifact.version !== expectedVersion)
        throw new HttpError(
          409,
          'The document changed. Review the latest version before applying.',
        );
      if (state.length > 4 * 1024 * 1024)
        throw new HttpError(400, 'Document is too large');
      const doc = new Y.Doc();
      try {
        const persisted = await this.state(id);
        if (persisted) Y.applyUpdate(doc, persisted);
        Y.applyUpdate(doc, state);
        const normalized = canonicalDocumentIds(
          yXmlFragmentToProsemirrorJSON(
            doc.getXmlFragment('default'),
          ) as RichNode,
          randomUUID,
        );
        const schema = editorSchema();
        if (normalized.changed)
          doc.transact(
            () =>
              prosemirrorToYXmlFragment(
                schema.nodeFromJSON(normalized.doc),
                doc.getXmlFragment('default'),
              ),
            'canonical-anchors',
          );
        const merged = Y.encodeStateAsUpdate(doc);
        if (merged.length > 4 * 1024 * 1024)
          throw new HttpError(400, 'Document is too large');
        const content = await this.checkedContent(
          artifact.kind,
          { doc: yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default')) },
          artifact.projectId,
          id,
        );
        editorSchema().nodeFromJSON(content.doc).check();
        await this.exec('UPDATE artifacts SET ystate=? WHERE id=?', merged, id);
        if (JSON.stringify(artifact.content) !== JSON.stringify(content))
          await this.updateDocContent(user, artifact, content);
        await onPersist?.();
        return { state: merged, artifact: await this.artifact(id, user.id) };
      } finally {
        doc.destroy();
      }
    });
  }
  private async updateDocContent(
    user: User,
    a: Artifact,
    content: Record<string, any>,
  ) {
    const c = JSON.stringify(
        await this.checkedContent(a.kind, content, a.projectId, a.id),
      ),
      t = now();
    await this.exec(
      'UPDATE artifacts SET content=?,version=version+1,updated_at=? WHERE id=?',
      c,
      t,
      a.id,
    );
    await this.exec(
      'INSERT INTO revisions(artifact_id,version,content,actor,created_at) VALUES(?,?,?,?,?)',
      a.id,
      a.version + 1,
      c,
      user.name,
      t,
    );
    await this.exec(
      'UPDATE projects SET updated_at=? WHERE id=?',
      t,
      a.projectId,
    );
    await this.audit(
      a.projectId,
      a.id,
      user.name,
      'document.edited',
      `version ${a.version + 1}`,
    );
    await this.sourceObserver?.(user, a, await this.artifact(a.id, user.id));
  }
  async threads(id: string) {
    return (
      await this.all(
        'SELECT t.id,t.artifact_id AS artifactId,t.anchor,t.quote,t.resolved,t.created_at AS createdAt,(SELECT count(*) FROM messages m WHERE m.thread_id=t.id AND m.artifact_id=t.artifact_id) AS messageCount FROM threads t WHERE t.artifact_id=? ORDER BY t.created_at,t.id',
        id,
      )
    ).map((t) => ({ ...t, resolved: !!t.resolved }));
  }
  async messages(id: string) {
    return (
      await this.all(
        `SELECT sequence,${messageCols} FROM (SELECT rowid AS sequence,* FROM messages WHERE artifact_id=? ORDER BY rowid DESC LIMIT 100) ORDER BY sequence`,
        id,
      )
    ).map(readMessage);
  }
  async messageById(
    artifactId: string,
    messageId: string,
  ): Promise<OrderedMessage | null> {
    const row = await this.one(
      `SELECT rowid AS sequence,${messageCols} FROM messages WHERE artifact_id=? AND id=?`,
      artifactId,
      messageId,
    );
    return row ? readMessage(row) : null;
  }
  async messagePage(
    artifactId: string,
    threadId: string,
    options: {
      limit?: number;
      before?: string;
    } = {},
  ): Promise<MessagePage> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new HttpError(400, 'Message page size must be between 1 and 200');
    if (
      !(await this.one(
        'SELECT id FROM threads WHERE id=? AND artifact_id=?',
        threadId,
        artifactId,
      ))
    )
      throw new HttpError(404, 'Discussion not found');
    let before: number | undefined;
    if (options.before !== undefined) {
      const cursor = await this.one(
        'SELECT rowid AS sequence FROM messages WHERE id=? AND artifact_id=? AND thread_id=?',
        options.before,
        artifactId,
        threadId,
      );
      if (!cursor)
        throw new HttpError(404, 'Message cursor not found in this discussion');
      before = cursor.sequence;
    }
    const rows = await this.all(
      `SELECT rowid AS sequence,${messageCols} FROM messages WHERE artifact_id=? AND thread_id=?${before === undefined ? '' : ' AND rowid<?'} ORDER BY rowid DESC LIMIT ?`,
      artifactId,
      threadId,
      ...(before === undefined ? [] : [before]),
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse().map(readMessage);
    return {
      messages,
      hasMore,
      nextCursor: hasMore ? messages[0]!.id : null,
    };
  }
  async exportBounds(artifactId: string): Promise<Record<ExportTable, number>> {
    return Object.fromEntries(
      await Promise.all(
        (Object.keys(exportColumns) as ExportTable[]).map(async (table) => [
          table,
          (
            await this.one(
              `SELECT coalesce(max(rowid),0) AS sequence FROM ${table} WHERE artifact_id=?`,
              artifactId,
            )
          ).sequence,
        ]),
      ),
    ) as Record<ExportTable, number>;
  }
  async *exportRows(
    table: ExportTable,
    artifactId: string,
    through: number,
    checkAccess: () => void | Promise<void>,
  ) {
    let after = 0;
    while (after < through) {
      await checkAccess();
      // Page the append-only row order instead of retaining an SQLite iterator or
      // an unbounded JavaScript array while a slow download holds the stream open.
      const rows = await this.all(
        `SELECT rowid AS sequence,${exportColumns[table]} FROM ${table} WHERE artifact_id=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 100`,
        artifactId,
        after,
        through,
      );
      if (!rows.length) break;
      for (const row of rows) {
        await checkAccess();
        const { sequence, ...value } = row;
        after = sequence;
        if (table === 'messages')
          yield {
            ...value,
            proposal: value.proposal ? JSON.parse(value.proposal) : null,
          };
        else if (table === 'runs') yield await this.run(value.id, artifactId);
        else if (table === 'revisions')
          yield { ...value, content: JSON.parse(value.content) };
        else if (table === 'threads')
          yield { ...value, resolved: !!value.resolved };
        else yield value;
      }
      // Let cancellation, membership changes, and other requests run between pages.
      await setImmediate();
    }
  }
  async message(
    user: User,
    id: string,
    threadId: string,
    body: string,
    role = 'user',
    proposal: unknown = null,
  ) {
    const artifact = await this.artifact(id, user.id, 'write');
    return this.tx(async () => {
      await this.db.lock('project:' + artifact.projectId);
      await this.artifact(id, user.id, 'write');
      if (
        !(await this.one(
          'SELECT id FROM threads WHERE id=? AND artifact_id=?',
          threadId,
          id,
        ))
      )
        throw new HttpError(404, 'Discussion not found');
      const mid = randomUUID();
      await this.exec(
        'INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)',
        mid,
        id,
        threadId,
        user.id,
        role === 'assistant' ? 'Studio agent' : user.name,
        role,
        body,
        proposal ? JSON.stringify(proposal) : null,
        now(),
      );
      const m = await this.one(
        `SELECT rowid AS sequence,${messageCols} FROM messages WHERE id=?`,
        mid,
      );
      return readMessage(m);
    });
  }
  async decisions(id: string) {
    return await this.all(
      'SELECT id,artifact_id AS artifactId,title,context,decision,consequences,status,version,author,updated_at AS updatedAt FROM decisions WHERE artifact_id=? ORDER BY updated_at,id',
      id,
    );
  }
  async run(id: string, artifactId: string) {
    const row = await this.one(
      'SELECT id,artifact_id AS artifactId,artifact_version AS artifactVersion,status,result,error,created_at AS createdAt,finished_at AS finishedAt FROM runs WHERE id=? AND artifact_id=?',
      id,
      artifactId,
    );
    return row ? this.readRun(row) : null;
  }
  private async readRun(row: any) {
    const result = {
      ...row,
      result: row.result ? JSON.parse(row.result) : null,
    };
    const reference = await this.one(
      'SELECT job_id FROM studio_runner_jobs WHERE run_id=?',
      row.id,
    );
    if (!reference) return result;
    const job = await this.one(
      'SELECT status,error,updated_at FROM studio_durable_jobs WHERE id=?',
      reference.job_id,
    );
    if (!job)
      throw new HttpError(409, 'The durable test execution record is missing');
    if (job.status !== 'completed')
      return {
        ...result,
        status: job.status === 'failed' ? 'error' : job.status,
        error: job.error,
        finishedAt: ['failed', 'cancelled'].includes(job.status)
          ? job.updated_at
          : null,
      };
    return result;
  }
  async file(id: string, userId: string) {
    const row = await this.one(
      'SELECT id,project_id AS projectId,artifact_id AS artifactId,name,mime,sha256,bytes,storage_key AS storageKey,byte_size AS byteSize,created_at AS createdAt FROM files WHERE id=?',
      id,
    );
    if (!row) throw new HttpError(404, 'File not found');
    const artifact = await this.artifact(row.artifactId, userId);
    if (artifact.projectId !== row.projectId)
      throw new HttpError(404, 'File not found');
    return {
      ...row,
      bytes: row.storageKey ? undefined : Buffer.from(row.bytes ?? []),
      storageKey: row.storageKey ?? undefined,
      byteSize: Number(row.byteSize),
    };
  }
  async registerFile(
    user: User,
    artifactId: string,
    input: {
      id?: string;
      name: string;
      mime: string;
      sha256: string;
      bytes?: Uint8Array;
      storageKey?: string;
      byteSize: number;
    },
  ) {
    const initial = await this.artifact(artifactId, user.id, 'write');
    if (
      !Number.isSafeInteger(input.byteSize) ||
      input.byteSize < 0 ||
      input.byteSize > 100 * 1024 * 1024 ||
      !/^([a-f0-9]{64})$/.test(input.sha256) ||
      !input.name ||
      input.name.length > 250 ||
      !input.mime ||
      input.mime.length > 200
    )
      throw new HttpError(400, 'Invalid file metadata');
    if (
      !input.storageKey &&
      (input.bytes === undefined ||
        input.bytes.length !== input.byteSize ||
        hash(input.bytes) !== input.sha256)
    )
      throw new HttpError(400, 'Inline file bytes do not match their metadata');
    if (
      input.storageKey &&
      (!input.storageKey.trim() ||
        input.storageKey.length > 1000 ||
        /[\r\n]/.test(input.storageKey))
    )
      throw new HttpError(400, 'Invalid object storage reference');
    return this.tx(async () => {
      await this.db.lock('project:' + initial.projectId);
      const artifact = await this.artifact(artifactId, user.id, 'write'),
        id = input.id ?? randomUUID();
      const existing = await this.one(
        'SELECT artifact_id,sha256,byte_size FROM files WHERE id=?',
        id,
      );
      if (existing) {
        if (
          existing.artifact_id !== artifactId ||
          existing.sha256 !== input.sha256 ||
          Number(existing.byte_size) !== input.byteSize
        )
          throw new HttpError(
            409,
            'File identifier already contains different content',
          );
        return this.file(id, user.id);
      }
      const used = (
        await this.one(
          'SELECT coalesce(sum(byte_size),0) AS n FROM files WHERE project_id=?',
          artifact.projectId,
        )
      ).n;
      if (
        Number(used) +
          Number(
            (await this.fileQuotaReservations?.(artifact.projectId, id)) ?? 0,
          ) +
          input.byteSize >
        512 * 1024 * 1024
      )
        throw new HttpError(
          413,
          'This project has reached its 512 MB asset quota',
        );
      await this.exec(
        'INSERT INTO files(id,project_id,artifact_id,name,mime,sha256,bytes,created_at,storage_key,byte_size) VALUES(?,?,?,?,?,?,?,?,?,?)',
        id,
        artifact.projectId,
        artifactId,
        input.name,
        input.mime,
        input.sha256,
        input.storageKey ? Buffer.alloc(0) : input.bytes!,
        now(),
        input.storageKey ?? null,
        input.byteSize,
      );
      await this.audit(
        artifact.projectId,
        artifactId,
        user.name,
        'file.uploaded',
        input.name,
      );
      return this.file(id, user.id);
    });
  }
  async runs(id: string) {
    return Promise.all(
      (
        await this.all(
          'SELECT id,artifact_id AS artifactId,artifact_version AS artifactVersion,status,result,error,created_at AS createdAt,finished_at AS finishedAt FROM runs WHERE artifact_id=? ORDER BY created_at DESC LIMIT 100',
          id,
        )
      ).map((row) => this.readRun(row)),
    );
  }
}
