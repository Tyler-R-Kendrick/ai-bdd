import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { createApp } from '../server/app.ts';
import {
  client,
  member,
  origin,
  project,
  setup,
  testSettings,
  type TestApp,
} from './helpers.ts';

async function eventually(check: () => boolean, timeout = 5000) {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until)
      throw new Error('Collaboration condition did not converge');
    await new Promise((r) => setTimeout(r, 20));
  }
}
function text(doc: Y.Doc) {
  return JSON.stringify(
    yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default')),
  );
}
function append(doc: Y.Doc, value: string) {
  doc.transact(() => {
    const node = new Y.XmlElement('paragraph');
    node.setAttribute('id', randomUUID());
    const text = new Y.XmlText();
    text.insert(0, value);
    node.insert(0, [text]);
    doc.getXmlFragment('default').push([node]);
  });
}

describe('Authenticated CRDT collaboration', () => {
  let instance: TestApp,
    dir: string,
    cookie: string,
    request: ReturnType<typeof client>,
    url: string;
  let clients: { doc: Y.Doc; provider: WebsocketProvider }[] = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'studio-crdt-'));
    instance = await createApp(testSettings(dir), {
      db: join(dir, 'studio.sqlite'),
    });
    ({ cookie } = await setup(instance.app));
    request = client(instance.app, cookie);
    url = (await instance.app.listen({ host: '127.0.0.1', port: 0 })).replace(
      'http:',
      'ws:',
    );
  });
  afterEach(async () => {
    for (const c of clients) {
      c.provider.destroy();
      c.doc.destroy();
    }
    clients = [];
    await instance.app.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function connect(artifactId: string, session = cookie) {
    const doc = new Y.Doc();
    class AuthenticatedWebSocket extends WebSocket {
      constructor(address: string | URL, protocols?: string | string[]) {
        super(address, protocols, {
          headers: { Origin: origin, Cookie: `studio_session=${session}` },
        });
      }
    }
    const provider = new WebsocketProvider(
      url + '/api/collaboration',
      artifactId,
      doc,
      {
        connect: false,
        disableBc: true,
        WebSocketPolyfill: AuthenticatedWebSocket as any,
      },
    );
    clients.push({ doc, provider });
    provider.connect();
    await eventually(() => provider.synced);
    return { doc, provider };
  }
  it('merges simultaneous offline edits and persists the exact document across restart', async () => {
    const p = await project(request),
      a = await connect(p.mainArtifactId),
      b = await connect(p.mainArtifactId);
    expect(text(a.doc)).toContain('Acceptance criteria');
    expect(text(a.doc)).toBe(text(b.doc));
    a.provider.disconnect();
    b.provider.disconnect();
    append(a.doc, 'Editor A adds a durable requirement.');
    append(b.doc, 'Editor B adds an independent requirement.');
    a.provider.connect();
    b.provider.connect();
    await eventually(
      () =>
        text(a.doc).includes('Editor B adds') &&
        text(b.doc).includes('Editor A adds'),
    );
    expect(text(a.doc)).toBe(text(b.doc));
    await eventually(() =>
      JSON.stringify(
        instance.store.artifact(
          p.mainArtifactId,
          instance.store.userByEmail('owner@example.test').id,
        ).content,
      ).includes('Editor B adds'),
    );
    const expected = text(a.doc);
    for (const c of clients) {
      c.provider.destroy();
      c.doc.destroy();
    }
    clients = [];
    await instance.app.close();
    instance = await createApp(testSettings(dir), {
      db: join(dir, 'studio.sqlite'),
    });
    url = (await instance.app.listen({ host: '127.0.0.1', port: 0 })).replace(
      'http:',
      'ws:',
    );
    const restored = await connect(p.mainArtifactId);
    expect(text(restored.doc)).toBe(expected);
    const history = (
      await client(instance.app, cookie)(
        'GET',
        `/api/artifacts/${p.mainArtifactId}/history`,
      )
    ).json();
    expect(
      history.audit.some(
        (e: any) => e.action === 'document.edited' && e.actor === 'Test owner',
      ),
    ).toBe(true);
  });
  it('lets viewers synchronize and observe writes while rejecting their document changes', async () => {
    const p = await project(request),
      viewer = await member(instance.app, request, p.id, 'viewer'),
      owner = await connect(p.mainArtifactId),
      view = await connect(p.mainArtifactId, viewer.cookie);
    expect(view.provider.wsconnected).toBe(true);
    expect(text(view.doc)).toBe(text(owner.doc));
    append(owner.doc, 'Visible to the whole team.');
    await eventually(() =>
      text(view.doc).includes('Visible to the whole team.'),
    );
    let rejected = false;
    view.provider.on('connection-close', (event: any) => {
      if (event?.code === 1008) {
        rejected = true;
        view.provider.shouldConnect = false;
      }
    });
    append(view.doc, 'Unauthorized viewer mutation');
    await eventually(() => rejected);
    expect(text(owner.doc)).not.toContain('Unauthorized viewer mutation');
    expect(
      JSON.stringify(
        instance.store.artifact(p.mainArtifactId, viewer.user.id).content,
      ),
    ).not.toContain('Unauthorized viewer mutation');
  });
  it('rejects invalid rich nodes before they reach durable storage or other collaborators', async () => {
    const p = await project(request),
      owner = await connect(p.mainArtifactId),
      hostile = await connect(p.mainArtifactId);
    let rejected = false;
    hostile.provider.on('connection-close', (event: any) => {
      if (event?.code === 1008) {
        rejected = true;
        hostile.provider.shouldConnect = false;
      }
    });
    hostile.doc.getXmlFragment('default').push([new Y.XmlElement('script')]);
    await eventually(() => rejected);
    expect(text(owner.doc)).not.toContain('"type":"script"');
    const bundle = (
      await request('GET', `/api/artifacts/${p.mainArtifactId}`)
    ).json();
    expect(JSON.stringify(bundle.artifact.content)).not.toContain(
      '"type":"script"',
    );
  });
  it('leaves the live document unchanged when a replacement fails validation or storage', async () => {
    const p = await project(request),
      editor = await connect(p.mainArtifactId),
      owner = instance.store.publicUser(
        instance.store.userByEmail('owner@example.test').id,
      ),
      before = text(editor.doc),
      original = instance.store.artifact(p.mainArtifactId, owner.id);
    expect(() =>
      instance.collab.replace(
        p.mainArtifactId,
        owner,
        {
          doc: {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Invalid root' }],
          },
        },
        original.version,
      ),
    ).toThrow();
    expect(text(instance.collab.rooms.get(p.mainArtifactId)!.doc)).toBe(before);
    expect(instance.store.artifact(p.mainArtifactId, owner.id).content).toEqual(
      original.content,
    );
    const persist = instance.store.persistDoc.bind(instance.store);
    instance.store.persistDoc = () => {
      throw new Error('Injected disk failure');
    };
    try {
      expect(() =>
        instance.collab.replace(
          p.mainArtifactId,
          owner,
          {
            doc: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: 'Must not become live before storage',
                    },
                  ],
                },
              ],
            },
          },
          original.version,
        ),
      ).toThrow('Injected disk failure');
    } finally {
      instance.store.persistDoc = persist;
    }
    expect(text(instance.collab.rooms.get(p.mainArtifactId)!.doc)).toBe(before);
    expect(text(editor.doc)).toBe(before);
    expect(instance.store.artifact(p.mainArtifactId, owner.id).content).toEqual(
      original.content,
    );
  });
  it('attributes presence to the authenticated account and blocks revoked memberships', async () => {
    const p = await project(request),
      editor = await member(instance.app, request, p.id, 'editor'),
      owner = await connect(p.mainArtifactId),
      edit = await connect(p.mainArtifactId, editor.cookie);
    edit.provider.awareness.setLocalStateField('user', {
      id: 'owner',
      name: 'Forged workspace administrator',
      color: '#000000',
    });
    await eventually(() =>
      [...owner.provider.awareness.getStates().values()].some(
        (v) => v.user?.id === editor.user.id,
      ),
    );
    const visible = [...owner.provider.awareness.getStates().values()].find(
      (v) => v.user?.id === editor.user.id,
    );
    expect(visible?.user.name).toBe('Test editor');
    await request('DELETE', `/api/projects/${p.id}/members/${editor.user.id}`);
    let rejected = false;
    edit.provider.on('connection-close', (event: any) => {
      if (event?.code === 1008) {
        rejected = true;
        edit.provider.shouldConnect = false;
      }
    });
    append(edit.doc, 'Revoked account cannot change the document');
    await eventually(() => rejected);
    expect(text(owner.doc)).not.toContain('Revoked account cannot');
  });
  it('stops sending new document content to a revoked participant who remains passive', async () => {
    const p = await project(request),
      editor = await member(instance.app, request, p.id, 'editor'),
      owner = await connect(p.mainArtifactId),
      passive = await connect(p.mainArtifactId, editor.cookie);
    let closed = false;
    passive.provider.shouldConnect = false;
    passive.provider.on('connection-close', () => {
      closed = true;
    });
    await request('DELETE', `/api/projects/${p.id}/members/${editor.user.id}`);
    append(owner.doc, 'Private content written after access revocation');
    await eventually(() => closed);
    expect(text(passive.doc)).not.toContain(
      'Private content written after access revocation',
    );
    expect(text(owner.doc)).toContain(
      'Private content written after access revocation',
    );
  });
  it('rejects cross-origin WebSocket connections before synchronization', async () => {
    const p = await project(request),
      socket = new WebSocket(url + '/api/collaboration/' + p.mainArtifactId, {
        headers: {
          Origin: 'https://attacker.test',
          Cookie: `studio_session=${cookie}`,
        },
      });
    const result = await new Promise<number>((resolve, reject) => {
      socket.on('close', resolve);
      socket.on('error', reject);
    });
    expect(result).toBe(1008);
  });
});
