import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { MachineService } from '../server/integrations/machines.ts';
import { OpenDesignService } from '../server/integrations/open-design.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const schema = 'concurrent_' + randomUUID().replaceAll('-', '');
  const stores = await Promise.all(
    [1, 2].map(async () =>
      Store.open(
        await openDatabase({
          adapter: 'postgres',
          url: process.env.STUDIO_TEST_POSTGRES_URL!,
          schema,
        }),
      ),
    ),
  );
  for (const store of stores) cleanup.push(() => store.close());
  const [first, second] = stores as [Store, Store],
    owner = await first.createUser(
      randomUUID() + '@example.test',
      'Owner',
      null,
    ),
    editor = await first.createUser(
      randomUUID() + '@example.test',
      'Editor',
      null,
    ),
    project = await first.createProject(owner, 'Concurrent', '');
  await first.exec(
    'INSERT INTO memberships VALUES(?,?,?)',
    project!.id,
    editor.id,
    'editor',
  );
  const services = stores.map(
    (store) => new MachineService(store, { notify: async () => {} } as any),
  );
  await Promise.all(services.map((service) => service.initialize()));
  return { first, second, owner, editor, project: project!, services };
}
describe.skipIf(!process.env.STUDIO_TEST_POSTGRES_URL)(
  'real PostgreSQL publication authorization',
  () => {
    it('rejects a mutation whose prior permission was revoked while waiting for its project lock', async () => {
      const { first, second, editor, project, services } = await fixture();
      let release!: () => void, locked!: () => void, attempted!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve)),
        ready = new Promise<void>((resolve) => (locked = resolve)),
        waiting = new Promise<void>((resolve) => (attempted = resolve));
      const original = second.db.lock.bind(second.db);
      vi.spyOn(second.db, 'lock').mockImplementation(async (key) => {
        if (key === 'project:' + project.id) attempted();
        return original(key);
      });
      const revoke = first.tx(async () => {
        await first.lock('project:' + project.id);
        locked();
        await gate;
        await first.exec(
          'DELETE FROM memberships WHERE project_id=? AND user_id=?',
          project.id,
          editor.id,
        );
      });
      await ready;
      const mutation = services[1]!.queue(editor, project.mainArtifactId, {
        version: 1,
        kind: 'investigation',
        brief: 'Do not publish after revoke',
      });
      await waiting;
      release();
      await revoke;
      await expect(mutation).rejects.toMatchObject({ statusCode: 404 });
      expect(
        await first.all(
          'SELECT id FROM studio_machine_work WHERE artifact_id=?',
          project.mainArtifactId,
        ),
      ).toHaveLength(0);
    });
    it('consumes pairing once and preserves valid running leases when another instance starts', async () => {
      const { first, second, owner, project, services } = await fixture(),
        [a, b] = services;
      const pairing = await a!.pairing(owner, project.id, 'Shared machine');
      const results = await Promise.allSettled([
        a!.pair(pairing.code),
        b!.pair(pairing.code),
      ]);
      expect(
        results.filter((value) => value.status === 'fulfilled'),
      ).toHaveLength(1);
      const machine = (
        results.find(
          (value) => value.status === 'fulfilled',
        ) as PromiseFulfilledResult<any>
      ).value;
      const identity = await a!.authenticate(
        { headers: { authorization: 'Bearer ' + machine.token } } as any,
        machine.id,
      );
      const work = await a!.queue(owner, project.mainArtifactId, {
          version: 1,
          kind: 'implementation',
          brief: 'One active lease',
        }),
        claimed = await a!.claim(identity);
      const another = new MachineService(second, {
        notify: async () => {},
      } as any);
      await another.initialize();
      expect(
        (
          await first.one(
            'SELECT status FROM studio_machine_work WHERE id=?',
            work.id,
          )
        ).status,
      ).toBe('running');
      expect(
        await another.heartbeat(identity, work.id, claimed.leaseToken),
      ).toMatchObject({ leaseActive: true });
      await another.complete(identity, work.id, claimed.leaseToken!, {
        summary: 'Durably submitted',
      });
      await expect(
        a!.complete(identity, work.id, claimed.leaseToken!, {
          summary: 'Stale duplicate',
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
    it('claims a brief confirmation before the external effect across independent services', async () => {
      const { first, second, owner, project } = await fixture();
      let calls = 0;
      const connect = async () => ({
        listTools: async () => ({
          tools: [{ name: 'collect_brief' }, { name: 'confirm_brief' }],
        }),
        callTool: async ({ name }: any) => {
          if (name === 'confirm_brief') calls++;
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  pluginWorkflowId: 'fixture-workflow',
                  briefDraftId: 'draft',
                  nonce: 'nonce',
                  confirmed: name === 'confirm_brief',
                }),
              },
            ],
          };
        },
        close: async () => {},
      });
      const a = new OpenDesignService(first, {}, connect),
        b = new OpenDesignService(second, {}, connect);
      await Promise.all([a.initialize(), b.initialize()]);
      const flow = await a.begin(
        owner,
        project.mainArtifactId,
        'local-codex',
        'en',
        {},
      );
      const results = await Promise.allSettled([
        a.confirm(owner, project.mainArtifactId, flow.id, {}),
        b.confirm(owner, project.mainArtifactId, flow.id, {}),
      ]);
      expect(
        results.filter((value) => value.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(calls).toBe(1);
    });
  },
);
