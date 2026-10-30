import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createGateway } from 'ai';
import * as Y from 'yjs';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { Store, HttpError, hash } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import { ArtifactTitles } from '../server/integrations/titles.ts';
import { generateTitleGoal } from '../server/integrations/title-provider.ts';
import type { AgentProfile } from '../shared/agent-profile.ts';
const closes: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
const postgresUrl = process.env.STUDIO_TEST_POSTGRES_URL;
for (const adapter of ['sqlite', 'postgres'] as const)
  describe.skipIf(adapter === 'postgres' && !postgresUrl)(
    adapter + ' title and empty-body goal generation',
    () => {
      async function fixture(legacy = false) {
        const schema = 'title_goal_' + randomUUID().replaceAll('-', '');
        const store = await Store.open(
          adapter === 'sqlite'
            ? ':memory:'
            : await openDatabase({ adapter, url: postgresUrl!, schema }),
        );
        closes.push(async () => {
          if (adapter === 'postgres')
            await store.db.exec('DROP SCHEMA "' + schema + '" CASCADE');
          await store.close();
        });
        const user = await store.createUser(
            randomUUID() + '@example.test',
            'Goal owner',
            null,
          ),
          project = await store.createProject(user, 'Title and goal', ''),
          artifact = await store.createArtifact(
            user,
            project.id,
            'document',
            'Untitled goal',
          );
        const thread = (await store.threads(artifact.id))[0]!;
        let selected: AgentProfile = {
            harness: 'vercel-fx',
            provider: 'ai-gateway',
            model: 'fixture/title-a',
          },
          beforeReply: (() => Promise<void>) | undefined,
          allowed = true,
          rollback = false;
        let response = {
          title: 'Contract preview intent',
          goal: 'Describe a contract fixture preview that remains usable while the integration is unavailable.',
        };
        const requests: any[] = [];
        const server = createServer(async (req, res) => {
          let text = '';
          for await (const chunk of req) text += chunk;
          requests.push({ body: JSON.parse(text), headers: req.headers });
          await beforeReply?.();
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              content: [{ type: 'text', text: JSON.stringify(response) }],
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: 10,
                  noCache: 10,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 20, text: 20, reasoning: 0 },
              },
              warnings: [],
            }),
          );
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        closes.push(
          () =>
            new Promise<void>((done) => {
              server.closeAllConnections();
              server.close(() => done());
            }),
        );
        const gateway = createGateway({
          baseURL: `http://127.0.0.1:${(server.address() as any).port}`,
          apiKey: 'explicit-title-goal-local-http-fixture',
        });
        const runtime = new DurableJobCoordinator({
          store,
          dispatcher: {
            provider: 'title-goal-fixture',
            publish: async () => ({ provider: 'title-goal-fixture' }),
          },
        });
        await runtime.ready;
        closes.push(() => runtime.close());
        if (legacy) {
          await store.db.exec(
            'CREATE TABLE studio_title_state(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,mode TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 0)',
          );
          await store.exec(
            "INSERT INTO studio_title_state(artifact_id,mode,epoch) VALUES(?,'automatic',0)",
            artifact.id,
          );
        }
        const titles = new ArtifactTitles({
          store,
          runtime,
          quietMs: 0,
          allowed: async () => allowed,
          captureProfile: async () => selected,
          provider: (input) =>
            generateTitleGoal(gateway(input.profile!.model), input),
          onGoalSeed: async () => {
            if (rollback)
              throw new Error('Injected transactional goal marker failure');
          },
        });
        await titles.initialize();
        const state = () => store.artifact(artifact.id, user.id);
        const observe = async () => {
          await store.message(
            user,
            artifact.id,
            thread.id,
            'Plan a contract fixture preview while the integration is unavailable.',
          );
          await titles.observeMessage(user, artifact.id, thread.id);
          return (
            await store.all(
              "SELECT id FROM studio_durable_jobs WHERE kind='artifact.title' ORDER BY created_at,id DESC",
            )
          ).at(-1)?.id as string;
        };
        const execute = (id: string) =>
          runtime.executeJob(id, {
            messageId: 'delivery-' + id,
            deliveryCount: 1,
          });
        const gate = () => {
          let release!: () => void, entered!: () => void;
          const started = new Promise<void>((r) => (entered = r)),
            waiting = new Promise<void>((r) => (release = r));
          beforeReply = async () => {
            entered();
            await waiting;
          };
          return { started, release };
        };
        return {
          store,
          user,
          project,
          artifact,
          thread,
          titles,
          runtime,
          state,
          observe,
          execute,
          requests,
          gate,
          response,
          setProfile: (profile: AgentProfile) => (selected = profile),
          pause: () => (allowed = false),
          rollback: () => (rollback = true),
        };
      }
      it('migrates an existing automatic title policy with goal seeding disabled', async () => {
        const w = await fixture(true);
        expect(await w.titles.exportState(w.artifact.id)).toEqual({
          mode: 'automatic',
          epoch: 0,
          seedGoal: false,
        });
        const before = await w.state();
        await w.execute(await w.observe());
        expect((await w.state()).title).toBe(w.response.title);
        expect((await w.state()).content).toEqual(before.content);
      });
      it('requires separate body consent, freezes the selected generative profile, persists matching Yjs anchors and replays once', async () => {
        const w = await fixture();
        expect((await w.titles.policy(w.user, w.artifact.id)).seedGoal).toBe(
          false,
        );
        await w.titles.policy(w.user, w.artifact.id, 'automatic', true);
        const before = await w.state(),
          anchor = before.content.doc.content[0].attrs.id,
          id = await w.observe();
        w.setProfile({
          harness: 'vercel-fx',
          provider: 'ai-gateway',
          model: 'fixture/title-b',
        });
        await w.execute(id);
        await w.execute(id);
        const after = await w.state();
        expect(after.version).toBe(before.version + 1);
        expect(after.title).toBe(w.response.title);
        expect(JSON.stringify(after.content)).toContain(w.response.goal);
        expect(after.content.doc.content[0].attrs.id).toBe(anchor);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, await w.store.documentState(after.id, w.user.id));
        expect(
          yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default')),
        ).toEqual(after.content.doc);
        doc.destroy();
        expect(w.requests).toHaveLength(1);
        expect(w.requests[0].headers['ai-language-model-id']).toBe(
          'fixture/title-a',
        );
        expect((await w.runtime.get(id))?.result).toMatchObject({
          title: w.response.title,
          goalSeeded: true,
        });
        expect(
          (
            await w.store.one(
              'SELECT actor FROM revisions WHERE artifact_id=? AND version=?',
              after.id,
              after.version,
            )
          ).actor,
        ).toBe('Studio agent');
        expect((await w.titles.exportState(after.id)).seedGoal).toBe(true);
      });
      it('maintains titles without body consent and never replaces an existing paragraph or interactive block', async () => {
        const w = await fixture();
        await w.titles.policy(w.user, w.artifact.id, 'automatic');
        const before = await w.state();
        await w.execute(await w.observe());
        expect((await w.state()).content).toEqual(before.content);
        expect((await w.state()).version).toBe(before.version);
        const current = await w.state(),
          content = {
            doc: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Existing human scope' }],
                },
              ],
            },
          };
        await w.store.updateArtifact(
          w.user,
          current.id,
          current.version,
          content,
        );
        await w.titles.policy(w.user, current.id, 'automatic', true);
        await w.execute(await w.observe());
        expect(JSON.stringify((await w.state()).content)).toContain(
          'Existing human scope',
        );
        expect(JSON.stringify((await w.state()).content)).not.toContain(
          w.response.goal,
        );
      });
      it('protects a human rename and its revoked goal consent during actual HTTP generation', async () => {
        const w = await fixture();
        await w.titles.policy(w.user, w.artifact.id, 'automatic', true);
        const id = await w.observe(),
          gate = w.gate(),
          running = w.execute(id);
        await gate.started;
        await w.store.tx(async () => {
          await w.store.db.lock('project:' + w.project.id);
          await w.titles.markHuman(w.artifact.id);
          await w.store.exec(
            'UPDATE artifacts SET title=? WHERE id=?',
            'My deliberate title',
            w.artifact.id,
          );
        });
        gate.release();
        await running;
        expect((await w.state()).title).toBe('My deliberate title');
        expect(JSON.stringify((await w.state()).content)).not.toContain(
          w.response.goal,
        );
        expect((await w.titles.exportState(w.artifact.id)).seedGoal).toBe(
          false,
        );
        expect((await w.runtime.get(id))?.result).toEqual({ skipped: true });
      });
      it('rejects a source edit during HTTP generation without overwriting its text or title', async () => {
        const w = await fixture();
        await w.titles.policy(w.user, w.artifact.id, 'automatic', true);
        const id = await w.observe(),
          gate = w.gate(),
          running = w.execute(id);
        await gate.started;
        const current = await w.state();
        await w.store.updateArtifact(w.user, current.id, current.version, {
          doc: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'A person started writing.' }],
              },
            ],
          },
        });
        gate.release();
        await running;
        expect((await w.state()).title).toBe(current.title);
        expect(JSON.stringify((await w.state()).content)).toContain(
          'A person started writing.',
        );
        expect(JSON.stringify((await w.state()).content)).not.toContain(
          w.response.goal,
        );
      });
      it('rechecks writer membership and source locks after provider work', async () => {
        const w = await fixture();
        await w.titles.policy(w.user, w.artifact.id, 'automatic', true);
        const before = await w.state(),
          id = await w.observe(),
          gate = w.gate(),
          running = w.execute(id);
        await gate.started;
        await w.store.exec(
          'DELETE FROM memberships WHERE project_id=? AND user_id=?',
          w.project.id,
          w.user.id,
        );
        gate.release();
        await running;
        expect(
          await w.store.one(
            'SELECT title,content FROM artifacts WHERE id=?',
            w.artifact.id,
          ),
        ).toEqual({
          title: before.title,
          content: JSON.stringify(before.content),
        });
        expect((await w.runtime.get(id))?.status).not.toBe('completed');
      });
      it('keeps both source and title unchanged when the atomic marker hook fails or the model goal exceeds its bound', async () => {
        const w = await fixture();
        await w.titles.policy(w.user, w.artifact.id, 'automatic', true);
        const before = await w.state(),
          stateHash = hash((await w.store.state(before.id))!);
        w.rollback();
        await w.execute(await w.observe());
        expect((await w.state()).content).toEqual(before.content);
        expect((await w.state()).title).toBe(before.title);
        expect(hash((await w.store.state(before.id))!)).toBe(stateHash);
        w.response.goal = 'x'.repeat(1201);
        await w.execute(await w.observe());
        expect((await w.state()).content).toEqual(before.content);
        expect((await w.state()).title).toBe(before.title);
      });
      it('honors shared pause and active source write guards without publishing a seed', async () => {
        const w = await fixture();
        await w.titles.policy(w.user, w.artifact.id, 'automatic', true);
        const before = await w.state(),
          id = await w.observe();
        w.pause();
        await w.execute(id);
        expect(w.requests).toHaveLength(0);
        expect((await w.state()).content).toEqual(before.content);
        const other = await fixture();
        await other.titles.policy(
          other.user,
          other.artifact.id,
          'automatic',
          true,
        );
        const blocked = await other.observe();
        other.store.artifactWriteGuard = async () => {
          throw new HttpError(409, 'Implementation source is locked');
        };
        await other.execute(blocked);
        expect((await other.state()).title).toBe(other.artifact.title);
        expect(JSON.stringify((await other.state()).content)).not.toContain(
          other.response.goal,
        );
      });
    },
  );
