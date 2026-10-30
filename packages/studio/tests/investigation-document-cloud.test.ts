import '@fastify/cookie';
import '@fastify/websocket';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import type { FastifyRequest } from 'fastify';
import { Store } from '../server/store.ts';
import {
  openDatabase,
  postgresPoolConfig,
} from '../server/persistence/index.ts';
import { Auth } from '../server/auth.ts';
import { Collaboration } from '../server/collaboration.ts';
import { MachineService } from '../server/integrations/machines.ts';
import { InvestigationService } from '../server/integrations/investigations.ts';
import { DiskObjectStore } from '../server/hosting/disk-objects.ts';
import { validateInvestigationReferences } from '../server/integrations/investigation-references.ts';
import { editorSchema } from '../shared/editor.ts';
import {
  exportMarkdown,
  importMarkdown,
} from '../shared/document-interchange.ts';
import type { InvestigationResult } from '../shared/investigations.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const postgresUrl = process.env.STUDIO_TEST_POSTGRES_URL;
/** Real production schema/services, machine pairing, leases, canonical Store source validation and Yjs; no duplicate investigation table declaration. */
async function fixture(adapter: 'sqlite' | 'postgres') {
  const schema = 'investigation_doc_' + randomUUID().replaceAll('-', ''),
    directory = await mkdtemp(join(tmpdir(), 'studio-investigation-doc-'));
  const store = await Store.open(
    adapter === 'sqlite'
      ? ':memory:'
      : await openDatabase({ adapter, url: postgresUrl!, schema }),
  );
  cleanup.push(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
    if (adapter === 'postgres') {
      const pool = new Pool(postgresPoolConfig({ url: postgresUrl! }));
      try {
        await pool.query('DROP SCHEMA "' + schema + '" CASCADE');
      } finally {
        await pool.end();
      }
    }
  });
  const user = await store.createUser(
      'inv-doc-' + randomUUID() + '@example.test',
      'Evidence author',
      null,
    ),
    project = await store.createProject(
      user,
      'Evidence references',
      '',
      'https://github.com/example/reference',
    ),
    artifact = await store.artifact(project.mainArtifactId, user.id);
  const auth = new Auth(store, {
      production: false,
      origin: 'http://127.0.0.1:8893',
      dataDir: directory,
      demo: false,
    }),
    collab = new Collaboration(store, auth);
  cleanup.push(() => collab.close());
  const machines = new MachineService(store, collab);
  await machines.initialize();
  const paired = await machines.pair(
      (await machines.pairing(user, project.id, 'Source validation machine'))
        .code,
    ),
    machine = await machines.authenticate(
      {
        headers: { authorization: 'Bearer ' + paired.token },
      } as FastifyRequest,
      paired.id,
    );
  const service = new InvestigationService({
    store,
    auth,
    machines,
    objects: new DiskObjectStore(directory),
    nativeDocumentBlocks: true,
  });
  await service.ready;
  store.contentReferenceValidator = (input) =>
    validateInvestigationReferences(store, input);
  await service.registerCheckout(machine, {
    repository: 'https://github.com/example/reference',
    sourceCommit: '1'.repeat(40),
    branch: 'main',
  });
  const proposed = await service.propose(user, artifact.id, {
    version: artifact.version,
    brief: 'Measure the published preview boundary.',
    sourceCommit: '1'.repeat(40),
  });
  const result: InvestigationResult = {
    title: 'Preview boundary observations',
    report: 'Measurements from this exact checkout.',
    method: 'Execute an explicitly connected local fixture.',
    limitations: 'Synthetic acceptance dataset; no production-provider claim.',
    datasets: [
      {
        id: 'samples',
        title: 'Observed requests',
        columns: [
          { id: 'kind', label: 'Boundary', type: 'string' },
          { id: 'elapsed', label: 'Elapsed', type: 'number', unit: 'ms' },
        ],
        rows: [
          { id: 'one', values: { kind: 'contract fixture', elapsed: 24 } },
          { id: 'two', values: { kind: 'direct integration', elapsed: 170 } },
        ],
      },
    ],
    views: [
      {
        id: 'observations',
        title: 'Observed elapsed time',
        datasetId: 'samples',
        type: 'bar',
        columns: ['kind', 'elapsed'],
        x: 'kind',
        y: 'elapsed',
      },
    ],
    evidence: [],
    images: [],
  };
  const complete = async () => {
    await service.run(user, proposed.id);
    const claimed = await service.claim(machine);
    expect(claimed.work?.id).toBe(proposed.id);
    return service.complete(machine, proposed.id, {
      generation: claimed.work!.generation,
      leaseToken: claimed.leaseToken!,
      result,
    });
  };
  const doc = (
    type: 'investigationCard' | 'investigationView',
    id = proposed.id,
    viewId = 'observations',
  ) => ({
    doc: {
      type: 'doc',
      content: [
        {
          type,
          attrs: {
            data:
              type === 'investigationCard'
                ? { investigationId: id }
                : { investigationId: id, viewId },
          },
        },
      ],
    },
  });
  return {
    machine,
    store,
    user,
    project,
    artifact,
    service,
    proposed,
    result,
    complete,
    doc,
  };
}
const append = (artifact: any, nodes: any[]) => ({
  doc: {
    ...artifact.content.doc,
    content: [...artifact.content.doc.content, ...nodes],
  },
});
const withoutCards = (artifact: any) => ({
  doc: {
    ...artifact.content.doc,
    content: artifact.content.doc.content.filter(
      (node: any) => node.type !== 'investigationCard',
    ),
  },
});
for (const adapter of ['sqlite', 'postgres'] as const)
  describe.skipIf(adapter === 'postgres' && !postgresUrl)(
    `${adapter} investigation references in canonical source writes`,
    () => {
      it('permits only a persisted parent request card and rejects arbitrary same-project/cross-project source cards', async () => {
        const w = await fixture(adapter),
          parent = await w.store.artifact(w.artifact.id, w.user.id);
        expect(
          parent.content.doc.content.filter(
            (node: any) => node.type === 'investigationCard',
          ),
        ).toHaveLength(1);
        const sibling = await w.store.createArtifact(
          w.user,
          w.project.id,
          'document',
          'Sibling',
        );
        await expect(
          w.store.updateArtifact(
            w.user,
            sibling.id,
            sibling.version,
            w.doc('investigationCard'),
          ),
        ).rejects.toThrow('source artifact');
        await expect(
          w.store.createArtifact(
            w.user,
            w.project.id,
            'document',
            'Imported foreign card',
            w.doc('investigationCard'),
          ),
        ).rejects.toThrow('source artifact');
        const other = await w.store.createProject(
          w.user,
          'Other repository scope',
          '',
        );
        await expect(
          w.store.updateArtifact(
            w.user,
            other.mainArtifactId,
            1,
            w.doc('investigationCard'),
          ),
        ).rejects.toThrow('belonging');
        await expect(
          w.store.updateArtifact(
            w.user,
            parent.id,
            parent.version,
            append(
              parent,
              w.doc('investigationCard', randomUUID()).doc.content,
            ),
          ),
        ).rejects.toThrow('belonging');
      });
      it('publishes actual leased investigation views into the real child and permits the same record view in its source only', async () => {
        const w = await fixture(adapter),
          initial = await w.store.artifact(w.artifact.id, w.user.id);
        await expect(
          w.store.updateArtifact(
            w.user,
            initial.id,
            initial.version,
            append(initial, w.doc('investigationView').doc.content),
          ),
        ).rejects.toThrow('completed');
        const completed = await w.complete(),
          child = await w.store.artifact(completed.childArtifactId, w.user.id);
        expect(JSON.stringify(child.content)).toContain('investigationView');
        expect(JSON.stringify(child.content)).toContain(w.proposed.id);
        const parent = await w.store.artifact(w.artifact.id, w.user.id);
        await w.store.updateArtifact(
          w.user,
          parent.id,
          parent.version,
          append(parent, w.doc('investigationView').doc.content),
        );
        const sibling = await w.store.createArtifact(
          w.user,
          w.project.id,
          'document',
          'Unrelated sibling',
        );
        await expect(
          w.store.updateArtifact(
            w.user,
            sibling.id,
            1,
            w.doc('investigationView'),
          ),
        ).rejects.toThrow('source or published child');
        const current = await w.store.artifact(parent.id, w.user.id);
        await expect(
          w.store.updateArtifact(
            w.user,
            parent.id,
            current.version,
            append(
              current,
              w.doc('investigationView', w.proposed.id, 'missing').doc.content,
            ),
          ),
        ).rejects.toThrow('published view');
      });
      it('retains one stable request-card identity through source/MDX rewrites and permits removal only after an explicit withdrawal', async () => {
        const w = await fixture(adapter),
          before = await w.store.artifact(w.artifact.id, w.user.id),
          card = before.content.doc.content.find(
            (node: any) => node.type === 'investigationCard',
          );
        await expect(
          w.store.updateArtifact(
            w.user,
            before.id,
            before.version,
            withoutCards(before),
          ),
        ).rejects.toThrow('stable identity');
        await expect(
          w.store.updateArtifact(
            w.user,
            before.id,
            before.version,
            append(before, [card]),
          ),
        ).rejects.toThrow('exactly once');
        const changed = structuredClone(before.content);
        changed.doc.content.find(
          (node: any) => node.type === 'investigationCard',
        ).attrs.id = randomUUID();
        await expect(
          w.store.updateArtifact(w.user, before.id, before.version, changed),
        ).rejects.toThrow('stable identity');
        const moved = {
          doc: {
            ...before.content.doc,
            content: [card, ...withoutCards(before).doc.content],
          },
        };
        await w.store.updateArtifact(w.user, before.id, before.version, moved);
        const current = await w.store.artifact(before.id, w.user.id),
          roundtrip = importMarkdown(
            exportMarkdown(current.content.doc, true),
            true,
          );
        await w.store.updateArtifact(w.user, before.id, current.version, {
          doc: roundtrip.doc,
        });
        await w.service.transition(w.user, w.proposed.id, 'withdraw');
        const withdrawn = await w.store.artifact(before.id, w.user.id);
        await w.store.updateArtifact(
          w.user,
          before.id,
          withdrawn.version,
          withoutCards(withdrawn),
        );
        expect(
          JSON.stringify(
            (await w.store.artifact(before.id, w.user.id)).content,
          ),
        ).not.toContain('investigationCard');
      });
      it('prevents generic source edits from removing queued, running and completed request cards', async () => {
        const w = await fixture(adapter);
        const remove = async () => {
          const current = await w.store.artifact(w.artifact.id, w.user.id);
          return w.store.updateArtifact(
            w.user,
            current.id,
            current.version,
            withoutCards(current),
          );
        };
        await w.service.run(w.user, w.proposed.id);
        await expect(remove()).rejects.toThrow('stable identity');
        const claim = await w.service.claim(w.machine);
        expect(claim.work).toBeTruthy();
        await expect(remove()).rejects.toThrow('stable identity');
        await w.service.complete(w.machine, w.proposed.id, {
          generation: claim.work!.generation,
          leaseToken: claim.leaseToken!,
          result: w.result,
        });
        await expect(remove()).rejects.toThrow('stable identity');
      });
      it('validates MCP/import-shaped writes and incoming Yjs source against the same persisted records before source/revisions commit', async () => {
        const w = await fixture(adapter);
        await w.complete();
        const sibling = await w.store.createArtifact(
            w.user,
            w.project.id,
            'document',
            'MCP target',
          ),
          before = await w.store.artifact(sibling.id, w.user.id),
          state = await w.store.documentState(sibling.id, w.user.id),
          candidate = new Y.Doc();
        try {
          Y.applyUpdate(candidate, state);
          prosemirrorToYXmlFragment(
            editorSchema().nodeFromJSON(w.doc('investigationView').doc),
            candidate.getXmlFragment('default'),
          );
          await expect(
            w.store.persistDoc(
              w.user,
              sibling.id,
              Y.encodeStateAsUpdate(candidate),
              w.doc('investigationView'),
            ),
          ).rejects.toThrow('source or published child');
        } finally {
          candidate.destroy();
        }
        expect((await w.store.artifact(sibling.id, w.user.id)).version).toBe(
          before.version,
        );
        expect(
          Number(
            (
              await w.store.one(
                'SELECT count(*) AS n FROM revisions WHERE artifact_id=?',
                sibling.id,
              )
            ).n,
          ),
        ).toBe(1);
        await w.store.exec(
          'UPDATE studio_investigations SET result_hash=? WHERE id=?',
          '0'.repeat(64),
          w.proposed.id,
        );
        const parent = await w.store.artifact(w.artifact.id, w.user.id);
        await expect(
          w.store.updateArtifact(
            w.user,
            parent.id,
            parent.version,
            append(parent, w.doc('investigationView').doc.content),
          ),
        ).rejects.toThrow('integrity');
      });
    },
  );
