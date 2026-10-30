import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Auth, type Settings } from '../server/auth.ts';
import { Store, hash } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { AccountMachines } from '../server/integrations/account-machines.ts';
import { AgentProfiles } from '../server/integrations/agent-profiles.ts';
import { MachineService } from '../server/integrations/machines.ts';
import { InvestigationService } from '../server/integrations/investigations.ts';
import { registerAccountPlannerRoutes } from '../server/integrations/account-planners.ts';
import {
  plannerClaimSchema,
  plannerIdleMs,
  plannerLeaseMs,
  type PlannerScope,
} from '../shared/account-planners.ts';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const postgresUrl = process.env.STUDIO_TEST_POSTGRES_URL;
for (const adapter of ['sqlite', 'postgres'] as const)
  describe.skipIf(adapter === 'postgres' && !postgresUrl)(
    adapter + ' own-account Planner assignments',
    () => {
      async function fixture(enabled = true) {
        const schema = 'planner_assignment_' + randomUUID().replaceAll('-', '');
        const database =
          adapter === 'sqlite'
            ? ':memory:'
            : await openDatabase({ adapter, url: postgresUrl!, schema });
        const store = await Store.open(database);
        cleanups.push(async () => {
          if (adapter === 'postgres')
            await store.db.exec('DROP SCHEMA "' + schema + '" CASCADE');
          await store.close();
        });
        const settings: Settings = {
          production: false,
          origin: 'http://localhost',
          dataDir: '/tmp/planner-assignment-fixture',
          demo: false,
          integrations: { remotePlanner: true },
        };
        const auth = new Auth(store, settings);
        await auth.initialize();
        const user = await store.createUser(
          randomUUID() + '@example.test',
          'Device owner',
          null,
        );
        const peer = await store.createUser(
          randomUUID() + '@example.test',
          'Other writer',
          null,
        );
        const viewer = await store.createUser(
          randomUUID() + '@example.test',
          'Viewer',
          null,
        );
        const project = await store.createProject(
          user,
          'Assigned document',
          '',
          'https://github.com/example/planning',
        );
        const artifact = await store.artifact(project.mainArtifactId, user.id);
        for (const [id, role] of [
          [peer.id, 'editor'],
          [viewer.id, 'viewer'],
        ])
          await store.exec(
            'INSERT INTO memberships VALUES(?,?,?)',
            project.id,
            id,
            role,
          );
        const machines = new MachineService(store, { notify() {} } as any);
        await machines.initialize();
        const investigations = new InvestigationService({
          store,
          auth,
          machines,
          objects: {} as any,
        });
        await investigations.ready;
        const accounts = new AccountMachines({ store, auth });
        await accounts.ready;
        machines.hooks.authorizeMachine = (machine) =>
          accounts.assertCurrentMachine(machine);
        machines.hooks.otherWorkActive = (id) => accounts.otherWorkActive(id);
        const profiles = new AgentProfiles(
          store,
          settings,
          settings.integrations!,
        );
        await profiles.initialize();
        const remoteProfile = {
          harness: 'remote-planner' as const,
          provider: 'operator-acp',
          model: 'remote',
        };
        await profiles.view(user, artifact.id, remoteProfile);
        const device = await accounts.pair(
          (await accounts.pairing(user, 'Owner laptop')).code,
        );
        const peerDevice = await accounts.pair(
          (await accounts.pairing(peer, 'Peer private desktop')).code,
        );
        const principal = await accounts.authenticate(
          { headers: { authorization: 'Bearer ' + device.token } } as any,
          device.id,
        );
        const peerPrincipal = await accounts.authenticate(
          { headers: { authorization: 'Bearer ' + peerDevice.token } } as any,
          peerDevice.id,
        );
        const checkout = {
          checkoutKey: 'explicit-planning',
          repository: project.repository,
          sourceCommit: 'a'.repeat(40),
          branch: 'main',
        };
        const registered = await accounts.assignments(principal, [checkout]);
        await accounts.assignments(peerPrincipal, [checkout]);
        let now = Date.now(),
          live = false;
        const activityScopes: {
          artifactId: string;
          userId: string;
          scope: { assignmentId: string; epoch: number };
        }[] = [];
        const app = Fastify();
        await app.register(cookie);
        app.setErrorHandler((error, _, reply) =>
          reply
            .code((error as any).statusCode ?? 500)
            .send({ error: (error as Error).message }),
        );
        const service = await registerAccountPlannerRoutes(app, {
          store,
          auth,
          accounts,
          profiles,
          enabled,
          now: () => now,
          hasLiveActivity: async (artifactId, userId, scope) => {
            activityScopes.push({ artifactId, userId, scope });
            return live;
          },
        });
        await app.listen({ port: 0, host: '127.0.0.1' });
        settings.origin = app.listeningOrigin;
        cleanups.push(() => app.close());
        async function apiToken(actor = user) {
          const token = randomBytes(32).toString('base64url');
          await store.exec(
            "INSERT INTO sessions(token,user_id,expires,kind) VALUES(?,?,?,'api')",
            hash(token),
            actor.id,
            Date.now() + 3_600_000,
          );
          return token;
        }
        const userToken = await apiToken(),
          peerToken = await apiToken(peer),
          viewerToken = await apiToken(viewer);
        async function request(
          path: string,
          method = 'GET',
          token = userToken,
          body?: unknown,
        ) {
          return fetch(app.listeningOrigin + path, {
            method,
            headers: {
              authorization: 'Bearer ' + token,
              ...(body ? { 'content-type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
        }
        const assign = () =>
          service.assign(user, artifact.id, {
            deviceId: device.id,
            artifactVersion: artifact.version,
          });
        const claim = async () => {
          const assignment = await assign();
          return {
            assignment,
            claim: await service.claim(
              principal,
              assignment.id,
              assignment.epoch,
            ),
          };
        };
        return {
          store,
          auth,
          settings,
          user,
          peer,
          viewer,
          project,
          artifact,
          machines,
          accounts,
          profiles,
          remoteProfile,
          service,
          device,
          peerDevice,
          principal,
          peerPrincipal,
          checkout,
          registered,
          request,
          userToken,
          peerToken,
          viewerToken,
          assign,
          claim,
          activityScopes,
          schema,
          advance: (ms: number) => {
            now += ms;
          },
          seen: () =>
            store.exec(
              'UPDATE studio_account_machines SET last_seen=? WHERE id=?',
              now,
              device.id,
            ),
          live: (value: boolean) => {
            live = value;
          },
        };
      }
      it('discovers only the signed-in account devices and requires an explicit configured remote harness', async () => {
        const c = await fixture();
        const response = await c.request(
          `/api/artifacts/${c.artifact.id}/planners`,
        );
        expect(response.status).toBe(200);
        const view = await response.json();
        expect(view.devices).toEqual([
          expect.objectContaining({
            id: c.device.id,
            label: 'Owner laptop',
            status: 'available',
            checkoutKey: c.checkout.checkoutKey,
          }),
        ]);
        expect(JSON.stringify(view)).not.toContain(c.peerDevice.id);
        expect(JSON.stringify(view)).not.toContain('Peer private');
        await c.profiles.view(c.user, c.artifact.id, {
          harness: 't3-code',
          provider: 'project-default',
          model: 'project-default',
        });
        await expect(c.assign()).rejects.toThrow(
          'Select the attached remote Planner harness explicitly',
        );
        expect(
          await c.store.one(
            'SELECT id FROM studio_account_planner_assignments',
          ),
        ).toBeUndefined();
        const viewer = await c.request(
          `/api/artifacts/${c.artifact.id}/planners`,
          'POST',
          c.viewerToken,
          { deviceId: c.device.id, artifactVersion: c.artifact.version },
        );
        expect(viewer.status).toBe(403);
        const peer = await c.request(
          `/api/artifacts/${c.artifact.id}/planners`,
          'POST',
          c.peerToken,
          { deviceId: c.device.id, artifactVersion: c.artifact.version },
        );
        expect(peer.status).toBe(404);
      });
      it('gates the capability and assignment endpoints when remote execution is disabled', async () => {
        const c = await fixture(false);
        expect(c.accounts.dependencies.plannerAssignments).toBe(false);
        expect((await c.service.view(c.user, c.artifact.id)).enabled).toBe(
          false,
        );
        const response = await c.request(
          `/api/artifacts/${c.artifact.id}/planners`,
          'POST',
          c.userToken,
          { deviceId: c.device.id, artifactVersion: c.artifact.version },
        );
        expect(response.status).toBe(503);
        expect(await c.service.activeOnDevice(c.device.id)).toBe(false);
      });
      it('freezes exact source, profile, repository and explicit checkout while scoped credentials cannot authorize global APIs', async () => {
        const c = await fixture();
        const response = await c.request(
          `/api/artifacts/${c.artifact.id}/planners`,
          'POST',
          c.userToken,
          { deviceId: c.device.id, artifactVersion: c.artifact.version },
        );
        expect(response.status).toBe(200);
        const assignment = await response.json();
        expect(assignment).toMatchObject({
          status: 'queued',
          artifactVersion: c.artifact.version,
          profile: c.remoteProfile,
          checkoutKey: c.checkout.checkoutKey,
          repository: c.checkout.repository,
        });
        const polled = await c.request(
          `/api/account-machines/${c.device.id}/planners/poll`,
          'POST',
          c.device.token,
          { checkouts: [c.checkout] },
        );
        expect(polled.status).toBe(200);
        expect((await polled.json()).assignments).toEqual([assignment]);
        const claimed = await c.request(
          `/api/account-machines/${c.device.id}/planners/${assignment.id}/claim`,
          'POST',
          c.device.token,
          { epoch: assignment.epoch },
        );
        expect(claimed.status).toBe(200);
        const credential = plannerClaimSchema.parse(await claimed.json());
        expect(credential.token).not.toBe(c.device.token);
        expect(
          Date.parse(credential.expiresAt) - Date.now(),
        ).toBeLessThanOrEqual(plannerLeaseMs);
        const scope = await c.service.authenticatePlanner({
          headers: { authorization: 'Bearer ' + credential.token },
        } as any);
        expect(scope).toMatchObject({
          user: { id: c.user.id },
          artifactId: c.artifact.id,
          assignmentId: assignment.id,
          epoch: assignment.epoch,
        });
        await expect(
          c.auth.user({
            headers: { authorization: 'Bearer ' + credential.token },
            cookies: {},
          } as any),
        ).rejects.toThrow('Your session expired');
        expect(
          (
            await c.request(
              `/api/artifacts/${c.artifact.id}/planners`,
              'POST',
              credential.token,
              { deviceId: c.device.id, artifactVersion: c.artifact.version },
            )
          ).status,
        ).toBe(401);
        expect(
          (
            await c.request(
              `/api/account-machines/${c.device.id}/planners/${assignment.id}/renew`,
              'POST',
              credential.token,
              { epoch: assignment.epoch },
            )
          ).status,
        ).toBe(401);
        await expect(
          c.service.claim(c.peerPrincipal, assignment.id, assignment.epoch),
        ).rejects.toThrow('Your Planner assignment was not found');
        const exported = JSON.stringify(
          await c.service.exportState(c.artifact.id),
        );
        expect(exported).not.toContain(credential.token);
        expect(exported).not.toContain(hash(credential.token));
        expect(exported).toContain(c.checkout.sourceCommit);
      });
      it('replays a same-epoch claim without extending its lease and makes old-epoch release harmless to a replacement', async () => {
        const c = await fixture(),
          first = await c.claim();
        c.advance(1000);
        expect(
          await c.service.claim(
            c.principal,
            first.assignment.id,
            first.assignment.epoch,
          ),
        ).toEqual(first.claim);
        expect(await c.assign()).toMatchObject({
          id: first.assignment.id,
          status: 'claimed',
        });
        await c.service.stop(
          c.user,
          c.artifact.id,
          first.assignment.id,
          first.assignment.epoch,
        );
        const replacement = await c.assign();
        expect(replacement.epoch).toBe(first.assignment.epoch + 1);
        expect(replacement.id).not.toBe(first.assignment.id);
        await c.service.release(
          c.principal,
          first.assignment.id,
          first.assignment.epoch,
          'failed',
        );
        expect(
          (await c.service.view(c.user, c.artifact.id)).assignment?.id,
        ).toBe(replacement.id);
        await expect(
          c.service.release(
            c.principal,
            replacement.id,
            first.assignment.epoch,
            'failed',
          ),
        ).rejects.toThrow('epoch changed');
        await c.service.stop(
          c.user,
          c.artifact.id,
          replacement.id,
          replacement.epoch,
        );
        await expect(
          c.service.stop(
            c.user,
            c.artifact.id,
            replacement.id,
            replacement.epoch,
          ),
        ).resolves.toEqual({ ok: true });
      });
      it('hides peer assignment details and rejects another writer stopping or replacing an account-owned Planner', async () => {
        const c = await fixture(),
          first = await c.assign();
        const view = await c.service.view(c.peer, c.artifact.id);
        expect(view.blockedByOtherWriter).toBe(true);
        expect(view.assignment).toBeNull();
        expect(view.devices.map((d) => d.id)).toEqual([c.peerDevice.id]);
        expect(JSON.stringify(view)).not.toContain(c.device.id);
        expect(JSON.stringify(view)).not.toContain(first.id);
        await expect(
          c.service.assign(c.peer, c.artifact.id, {
            deviceId: c.peerDevice.id,
            artifactVersion: c.artifact.version,
          }),
        ).rejects.toThrow('Another writer owns');
        await expect(
          c.service.stop(c.peer, c.artifact.id, first.id, first.epoch),
        ).rejects.toThrow('Your Planner assignment was not found');
      });
      it('reserves a physical device against ordinary claims and refuses Planner claims while ordinary work is active', async () => {
        const c = await fixture(),
          assignment = await c.assign();
        const child = c.registered.assignments[0]!.credential;
        const machine = await c.machines.authenticate(
          { headers: { authorization: 'Bearer ' + child.token } } as any,
          child.id,
        );
        const work = await c.machines.queue(c.user, c.artifact.id, {
          version: c.artifact.version,
          kind: 'investigation',
          brief: 'Explicit investigation work',
        });
        expect(await c.accounts.otherWorkActive(machine.id)).toBe(true);
        expect(
          await c.accounts.otherWorkActive(machine.id, {
            excludePlanner: true,
          }),
        ).toBe(false);
        expect(await c.machines.claim(machine)).toEqual({ work: null });
        await c.service.stop(
          c.user,
          c.artifact.id,
          assignment.id,
          assignment.epoch,
        );
        const running = await c.machines.claim(machine);
        expect(running.work?.id).toBe(work.id);
        await expect(c.assign()).rejects.toThrow(
          'already running another approved workflow',
        );
      });
      it('extends idle only for exact assignment-bound real activity, and connection-only renewals eventually return idle', async () => {
        const c = await fixture(),
          first = await c.claim();
        const scope = {
          user: c.user,
          artifactId: c.artifact.id,
          assignmentId: first.assignment.id,
          epoch: first.assignment.epoch,
        };
        for (let i = 0; i < 3; i++) {
          c.advance(40_000);
          await c.seen();
          expect(
            (
              await c.service.renew(
                c.principal,
                first.assignment.id,
                first.assignment.epoch,
              )
            ).idle,
          ).toBe(i === 2);
        }
        await expect(c.service.assertPlanner(scope)).rejects.toThrow(
          'no longer current',
        );
        const second = await c.assign();
        const credential = await c.service.claim(
          c.principal,
          second.id,
          second.epoch,
        );
        c.live(true);
        for (let i = 0; i < 4; i++) {
          c.advance(40_000);
          expect(
            (await c.service.renew(c.principal, second.id, second.epoch)).idle,
          ).toBe(false);
        }
        expect(c.activityScopes.at(-1)).toEqual({
          artifactId: c.artifact.id,
          userId: c.user.id,
          scope: { assignmentId: second.id, epoch: second.epoch },
        });
        expect(
          await c.service.authenticatePlanner({
            headers: { authorization: 'Bearer ' + credential.token },
          } as any),
        ).toMatchObject({ assignmentId: second.id });
      });
      it('cannot resurrect an expired lease even when a stale activity report remains', async () => {
        const c = await fixture(),
          first = await c.claim();
        c.live(true);
        c.advance(plannerLeaseMs + 1);
        await expect(
          c.service.renew(
            c.principal,
            first.assignment.id,
            first.assignment.epoch,
          ),
        ).rejects.toThrow('lease expired');
        await expect(
          c.service.authenticatePlanner({
            headers: { authorization: 'Bearer ' + first.claim.token },
          } as any),
        ).rejects.toThrow('lease expired');
        const view = await c.service.view(c.user, c.artifact.id);
        expect(view.assignment?.status).toBe('stale');
        expect(await c.service.activeOnDevice(c.device.id)).toBe(false);
      });
      it('fences document revisions, accepted ADR content, profile changes and checkout changes', async () => {
        const c = await fixture(),
          first = await c.claim();
        const scope: PlannerScope = {
          user: c.user,
          artifactId: c.artifact.id,
          assignmentId: first.assignment.id,
          epoch: first.assignment.epoch,
        };
        const content = structuredClone(c.artifact.content);
        content.doc.content.push({
          type: 'paragraph',
          content: [{ type: 'text', text: 'New manual source.' }],
        });
        await c.store.updateArtifact(
          c.user,
          c.artifact.id,
          c.artifact.version,
          content,
        );
        await expect(c.service.assertPlanner(scope)).rejects.toThrow(
          'document, accepted decisions',
        );
        const latest = await c.store.artifact(c.artifact.id, c.user.id);
        const second = await c.service.assign(c.user, c.artifact.id, {
          deviceId: c.device.id,
          artifactVersion: latest.version,
        });
        await c.service.claim(c.principal, second.id, second.epoch);
        await c.store.exec(
          'INSERT INTO decisions(id,artifact_id,title,context,decision,consequences,status,version,author,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          randomUUID(),
          c.artifact.id,
          'Accepted architecture',
          'Context',
          'Use bounded leases',
          'Short-lived authority',
          'accepted',
          1,
          c.user.name,
          new Date().toISOString(),
        );
        await expect(
          c.service.assertPlanner({
            ...scope,
            assignmentId: second.id,
            epoch: second.epoch,
          }),
        ).rejects.toThrow('accepted decisions');
        const third = await c.service.assign(c.user, c.artifact.id, {
          deviceId: c.device.id,
          artifactVersion: latest.version,
        });
        await c.service.claim(c.principal, third.id, third.epoch);
        await c.profiles.view(c.user, c.artifact.id, {
          harness: 't3-code',
          provider: 'project-default',
          model: 'project-default',
        });
        await expect(
          c.service.assertPlanner({
            ...scope,
            assignmentId: third.id,
            epoch: third.epoch,
          }),
        ).rejects.toThrow('profile changed');
        await c.profiles.view(c.user, c.artifact.id, c.remoteProfile);
        await c.service.stop(c.user, c.artifact.id, third.id, third.epoch);
        const fourth = await c.service.assign(c.user, c.artifact.id, {
          deviceId: c.device.id,
          artifactVersion: latest.version,
        });
        const polled = await c.service.poll(c.principal, [
          { ...c.checkout, sourceCommit: 'b'.repeat(40) },
        ]);
        expect(polled.assignments).toEqual([]);
        expect(
          (await c.service.view(c.user, c.artifact.id)).assignment,
        ).toMatchObject({ id: fourth.id, status: 'stale' });
      });
      it('revokes scoped authority when project write access or the account device is revoked', async () => {
        const c = await fixture(),
          first = await c.claim();
        await c.store.exec(
          "UPDATE memberships SET role='viewer' WHERE project_id=? AND user_id=?",
          c.project.id,
          c.user.id,
        );
        await expect(
          c.service.renew(
            c.principal,
            first.assignment.id,
            first.assignment.epoch,
          ),
        ).rejects.toThrow('project role');
        await c.store.exec(
          "UPDATE memberships SET role='owner' WHERE project_id=? AND user_id=?",
          c.project.id,
          c.user.id,
        );
        await c.accounts.revoke(c.user, c.device.id);
        await expect(
          c.service.assertPlanner({
            user: c.user,
            artifactId: c.artifact.id,
            assignmentId: first.assignment.id,
            epoch: first.assignment.epoch,
          }),
        ).rejects.toThrow('revoked');
        expect(await c.service.activeOnDevice(c.device.id)).toBe(false);
      });
      it('serializes competing document assignments so one physical device receives only one reservation', async () => {
        const c = await fixture();
        const other = await c.store.createArtifact(
          c.user,
          c.project.id,
          'document',
          'Another document',
        );
        await c.profiles.view(c.user, other.id, c.remoteProfile);
        const results = await Promise.allSettled([
          c.assign(),
          c.service.assign(c.user, other.id, {
            deviceId: c.device.id,
            artifactVersion: other.version,
          }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
        expect(
          (
            await c.store.one(
              "SELECT count(*) AS n FROM studio_account_planner_assignments WHERE device_id=? AND status IN ('queued','claimed')",
              c.device.id,
            )
          ).n,
        ).toBe(1);
      });
      it('rechecks source guards and exports complete history without credential material', async () => {
        const c = await fixture();
        c.store.artifactWriteGuard = async () => {
          throw new Error('An implementation owns this source');
        };
        await expect(c.assign()).rejects.toThrow('implementation owns');
        c.store.artifactWriteGuard = undefined;
        const first = await c.claim();
        await c.service.release(
          c.principal,
          first.assignment.id,
          first.assignment.epoch,
          'stopped',
        );
        const second = await c.claim();
        const rows = await c.service.exportState(c.artifact.id);
        expect(rows.map((r) => r.id)).toEqual([
          first.assignment.id,
          second.assignment.id,
        ]);
        expect(rows[0]!.status).toBe('stopped');
        expect(rows[1]!.status).toBe('claimed');
        expect(JSON.stringify(rows)).not.toMatch(/token|token_hash/);
        expect(rows[0]!.sourceHash).toHaveLength(64);
        expect(rows[0]!.userId).toBe(c.user.id);
        expect(
          Date.parse(rows[0]!.idleExpiresAt) - Date.parse(rows[0]!.createdAt),
        ).toBe(plannerIdleMs);
      });
    },
  );
