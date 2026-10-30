import '@fastify/cookie';
import '@fastify/websocket';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { Store, HttpError } from '../server/store.ts';
import {
  openDatabase,
  postgresPoolConfig,
} from '../server/persistence/index.ts';
import { Auth, type Settings } from '../server/auth.ts';
import { Collaboration } from '../server/collaboration.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import {
  registerConversationRoutes,
  conversationExportPage,
  type StartConversationResearch,
} from '../server/integrations/conversation.ts';
import type {
  ConversationCard,
  ConversationOffer,
  ConversationView,
} from '../shared/conversation.ts';
import type { User } from '../shared/domain.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
const postgresUrl = process.env.STUDIO_TEST_POSTGRES_URL;
const generated = (text: string) => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  },
  warnings: [],
});
async function fixture(
  adapter: 'sqlite' | 'postgres',
  enabled = true,
  kind: 'design' | 'code' = 'design',
) {
  vi.stubEnv('AI_GATEWAY_API_KEY', 'fixture-only-conversation-key');
  const schema = 'conversation_' + randomUUID().replaceAll('-', '');
  const store = await Store.open(
    adapter === 'sqlite'
      ? ':memory:'
      : await openDatabase({ adapter, url: postgresUrl!, schema }),
  );
  const peer =
    adapter === 'sqlite'
      ? store
      : await Store.open(
          await openDatabase({ adapter, url: postgresUrl!, schema }),
        );
  cleanup.push(async () => {
    if (peer !== store) await peer.close();
    await store.close();
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
      'conversation-' + randomUUID() + '@example.test',
      'Conversation owner',
      null,
    ),
    project = await store.createProject(user, 'Conversation source', ''),
    artifact =
      kind === 'code'
        ? await store.createArtifact(
            user,
            project.id,
            'code',
            'Code conversation',
          )
        : await store.artifact(project.mainArtifactId, user.id),
    threadId = (await store.threads(artifact.id))[0]!.id;
  const message = await store.message(
    user,
    artifact.id,
    threadId,
    'Should previews use a contract fixture? Compare Pact and a direct integration.',
  );
  const requests: any[] = [];
  let beforeReply: (() => Promise<void>) | undefined;
  const offers: ConversationOffer[] = [
    {
      kind: 'decision',
      title: 'Preview boundary',
      rationale: 'The discussion has an unresolved integration boundary.',
      question: 'Which preview boundary should the team use?',
      options: ['Contract fixture', 'Direct integration'],
      brief:
        'Compare Pact contract fixtures and direct integrations for live preview.',
      evidenceMessageIds: [message.id],
      sourceQuote: 'Should previews use a contract fixture?',
    },
  ];
  const server = createServer(async (req, res) => {
    let source = '';
    for await (const chunk of req) source += chunk;
    requests.push({
      url: req.url,
      body: JSON.parse(source),
      headers: req.headers,
    });
    try {
      await beforeReply?.();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(generated(JSON.stringify({ offers }))));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const settings: Settings = {
    production: false,
    origin: 'http://127.0.0.1:8893',
    dataDir: '/tmp/studio-conversation-test',
    demo: false,
    model: 'fixture/model',
    integrations: {
      gatewayBaseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
    },
  };
  const collab = new Collaboration(store, new Auth(store, settings));
  cleanup.push(() => collab.close());
  const runtime = new DurableJobCoordinator({
    store,
    dispatcher: {
      provider: 'explicit-protocol-fixture',
      publish: async () => ({ provider: 'explicit-protocol-fixture' }),
    },
  });
  await runtime.ready;
  cleanup.push(() => runtime.close());
  const app = Fastify();
  cleanup.push(() => app.close());
  app.setErrorHandler((error, _req, reply) =>
    reply
      .code(
        error instanceof z.ZodError ? 400 : ((error as any).statusCode ?? 500),
      )
      .send({ error: (error as Error).message }),
  );
  const starts: Parameters<StartConversationResearch>[0][] = [];
  let failStart = false;
  const jobs = new Map<string, string>();
  const registered = await registerConversationRoutes(app, {
    store,
    collab,
    runtime,
    settings,
    enabled,
    debounceMs: 0,
    auth: {
      user: async (req) => {
        const id = req.headers['x-test-user'];
        if (typeof id !== 'string')
          throw new HttpError(401, 'Fixture identity required');
        return store.publicUser(id);
      },
    },
    startResearch: async (input) => {
      starts.push(input);
      const prior = jobs.get(input.idempotencyKey);
      if (prior) return { id: prior };
      const id = randomUUID();
      jobs.set(input.idempotencyKey, id);
      if (failStart) {
        failStart = false;
        throw new Error('Response lost after research enqueue');
      }
      return { id };
    },
  });
  const request = (
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
    actor: User = user,
  ) =>
    app.inject({
      method,
      url: `/api/artifacts/${artifact.id}/conversation${path}`,
      headers: { 'x-test-user': actor.id },
      ...(payload === undefined ? {} : { payload: payload as any }),
    });
  const view = async () => {
    const response = await request('GET', '?threadId=' + threadId);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as ConversationView;
  };
  const analyze = async () => {
    const response = await request('POST', '/analyze', { threadId });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().jobId as string;
    await runtime.executeJob(id, { messageId: randomUUID(), deliveryCount: 1 });
    return id;
  };
  const publish = (card: ConversationCard, actor: User = user) =>
    request(
      'POST',
      `/cards/${card.id}/publish`,
      { cardVersion: card.version, artifactVersion: card.artifactVersion },
      actor,
    );
  return {
    store,
    peer,
    user,
    project,
    artifact,
    threadId,
    message,
    offers,
    requests,
    runtime,
    request,
    view,
    analyze,
    publish,
    starts,
    registered,
    beforeReply: (fn: () => Promise<void>) => {
      beforeReply = fn;
    },
    failStart: () => {
      failStart = true;
    },
  };
}
for (const adapter of ['sqlite', 'postgres'] as const)
  describe.skipIf(adapter === 'postgres' && !postgresUrl)(
    `${adapter} real gateway conversation offers`,
    () => {
      it('keeps the operator capability off by default and makes no model request', async () => {
        const w = await fixture(adapter, false);
        expect(
          await w.registered.observe(w.user, w.artifact.id, w.threadId),
        ).toBeNull();
        expect((await w.view()).enabled).toBe(false);
        expect(
          (await w.request('POST', '/analyze', { threadId: w.threadId }))
            .statusCode,
        ).toBe(409);
        expect(w.requests).toHaveLength(0);
      });
      it('extracts attributed immutable offers through the installed SDK and publishes a real questionnaire only after a writer reviews it', async () => {
        const w = await fixture(adapter),
          other = await w.store.createArtifact(
            w.user,
            w.project.id,
            'document',
            'Unrelated source',
          );
        await w.store.message(
          w.user,
          other.id,
          (await w.store.threads(other.id))[0]!.id,
          'Unrelated secret discussion must stay isolated.',
        );
        const id = await w.analyze(),
          first = (await w.view()).cards[0]!;
        expect((await w.runtime.get(id))?.status).toBe('completed');
        expect(w.requests).toHaveLength(1);
        expect(w.requests[0].url).toBe('/language-model');
        expect(w.requests[0].headers['idempotency-key']).toBe(id + ':extract');
        expect(JSON.stringify(w.requests[0].body)).not.toContain(
          'Unrelated secret',
        );
        expect(first.createdBy).toBe('Studio agent');
        expect(first.status).toBe('proposed');
        expect(await w.store.decisions(w.artifact.id)).toHaveLength(1);
        expect(
          JSON.stringify(
            (await w.store.artifact(w.artifact.id, w.user.id)).content,
          ),
        ).not.toContain('questionnaireBlock');
        await w.runtime.executeJob(id, {
          messageId: 'redelivery',
          deliveryCount: 2,
        });
        expect(w.requests).toHaveLength(1);
        expect((await w.view()).cards).toHaveLength(1);
        const second = await w.store.createUser(
          'second-' + randomUUID() + '@example.test',
          'Second editor',
          null,
        );
        await w.store.exec(
          "INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,'editor')",
          w.project.id,
          second.id,
        );
        expect(
          (await w.registered.observe(second, w.artifact.id, w.threadId))?.id,
        ).toBe(id);
        const published = await w.publish(first);
        expect(published.statusCode, published.body).toBe(200);
        const doc = await w.store.artifact(w.artifact.id, w.user.id);
        expect(doc.version).toBe(2);
        expect(doc.content.doc.content.at(-1).attrs.id).toBe(
          published.json().id,
        );
        expect(
          doc.content.doc.content
            .at(-1)
            .attrs.data.questions[0].options.map((o: any) => o.label),
        ).toEqual(w.offers[0]!.options);
        expect((await w.view()).cards[0]!.updatedBy).toBe(w.user.name);
        expect(
          (await w.store.decisions(w.artifact.id)).every(
            (d) => d.status === 'proposed',
          ),
        ).toBe(true);
        expect((await w.publish(first)).statusCode).toBe(200);
      });
      it('creates a proposed ADR for media/code artifacts without accepting a model decision', async () => {
        const w = await fixture(adapter, true, 'code');
        await w.analyze();
        const card = (await w.view()).cards[0]!,
          result = await w.publish(card);
        expect(result.statusCode, result.body).toBe(200);
        expect(result.json().kind).toBe('proposed-adr');
        const decisions = await w.store.decisions(w.artifact.id),
          draft = decisions.find((d) => d.id === result.json().id);
        expect(draft?.status).toBe('proposed');
        expect(draft?.author).toBe(w.user.name);
        expect(draft?.context).toContain(w.offers[0]!.sourceQuote);
        expect((await w.store.artifact(w.artifact.id, w.user.id)).version).toBe(
          1,
        );
      });
      it('does not publish proposals after membership is revoked while the provider is running', async () => {
        const w = await fixture(adapter);
        w.beforeReply(async () => {
          await w.peer.exec(
            "UPDATE memberships SET role='viewer' WHERE project_id=? AND user_id=?",
            w.project.id,
            w.user.id,
          );
        });
        const id = await w.analyze();
        expect((await w.runtime.get(id))?.status).toBe('cancelled');
        expect(
          Number(
            (
              await w.store.one(
                'SELECT count(*) AS n FROM studio_conversation_cards',
              )
            ).n,
          ),
        ).toBe(0);
      });
      it('rejects fabricated citations and supports an explicit bounded reanalysis after failed work', async () => {
        const w = await fixture(adapter);
        w.offers[0]!.sourceQuote = 'Fabricated quotation';
        const id = await w.analyze();
        expect((await w.view()).cards).toHaveLength(0);
        expect((await w.runtime.get(id))?.status).not.toBe('completed');
        await w.runtime.cancel(id, w.user);
        w.offers[0]!.sourceQuote = 'Should previews use a contract fixture?';
        const retry = await w.request('POST', '/analyze', {
          threadId: w.threadId,
          retry: true,
        });
        expect(retry.statusCode, retry.body).toBe(200);
        expect(retry.json().jobId).not.toBe(id);
        await w.runtime.executeJob(retry.json().jobId, {
          messageId: randomUUID(),
          deliveryCount: 1,
        });
        expect((await w.view()).cards).toHaveLength(1);
      });
      it('rechecks the discussion after a real asynchronous provider response and publishes nothing from stale source', async () => {
        const w = await fixture(adapter);
        w.beforeReply(async () => {
          await w.peer.message(
            w.user,
            w.artifact.id,
            w.threadId,
            'New requirement: compare an offline sandbox too.',
          );
        });
        const id = await w.analyze();
        expect(w.requests).toHaveLength(1);
        expect((await w.view()).cards).toHaveLength(0);
        expect((await w.runtime.get(id))?.status).toBe('failed');
      });
      it('blocks viewers, stale discussion offers, and revoked writers at the durable publication boundary', async () => {
        const w = await fixture(adapter);
        await w.analyze();
        const card = (await w.view()).cards[0]!,
          viewer = await w.store.createUser(
            'viewer-' + randomUUID() + '@example.test',
            'Reader',
            null,
          );
        await w.store.exec(
          "INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,'viewer')",
          w.project.id,
          viewer.id,
        );
        expect((await w.publish(card, viewer)).statusCode).toBe(403);
        await w.peer.message(
          w.user,
          w.artifact.id,
          w.threadId,
          'We changed the acceptance criteria.',
        );
        expect((await w.view()).cards[0]!.stale).toBe(true);
        expect((await w.publish(card)).statusCode).toBe(409);
        expect((await w.store.artifact(w.artifact.id, w.user.id)).version).toBe(
          1,
        );
        await w.analyze();
        const current = (await w.view()).cards[0]!;
        await w.store.exec(
          "UPDATE memberships SET role='viewer' WHERE project_id=? AND user_id=?",
          w.project.id,
          w.user.id,
        );
        expect((await w.publish(current)).statusCode).toBe(403);
      });
      it('persists the exact edited research brief and retries a lost enqueue response with one stable key', async () => {
        const w = await fixture(adapter);
        w.offers[0]!.kind = 'research';
        await w.analyze();
        const card = (await w.view()).cards[0]!,
          brief =
            'Investigate Pact provider verification for this exact preview contract.';
        expect(w.starts).toHaveLength(0);
        w.failStart();
        const first = await w.request(
          'POST',
          `/cards/${card.id}/start-research`,
          { cardVersion: card.version, artifactVersion: 1, brief },
        );
        expect(first.statusCode).toBe(500);
        const claimed = (await w.view()).cards[0]!;
        expect(claimed.status).toBe('starting');
        expect(claimed.brief).toBe(brief);
        expect(claimed.error).toContain('Response lost');
        const changed = await w.request(
          'POST',
          `/cards/${card.id}/start-research`,
          {
            cardVersion: claimed.version,
            artifactVersion: 1,
            brief: 'A different brief',
          },
        );
        expect(changed.statusCode).toBe(409);
        const retried = await w.request(
          'POST',
          `/cards/${card.id}/start-research`,
          { cardVersion: claimed.version, artifactVersion: 1, brief },
        );
        expect(retried.statusCode, retried.body).toBe(200);
        expect(w.starts).toHaveLength(2);
        expect(w.starts[0]!.idempotencyKey).toBe(w.starts[1]!.idempotencyKey);
        expect(w.starts[1]!.brief).toBe(brief);
        expect((await w.view()).cards[0]!.jobId).toBe(retried.json().id);
        expect((await w.view()).cards[0]!.status).toBe('started');
      });
      it('rolls a questionnaire back when its metadata publication fails and exports every snapshot/card including dismissed history', async () => {
        const w = await fixture(adapter);
        await w.analyze();
        const card = (await w.view()).cards[0]!,
          original = w.store.exec.bind(w.store);
        w.store.exec = async (sql, ...args) => {
          if (sql.includes("SET status='published'"))
            throw new Error('Injected async card publication failure');
          return original(sql, ...args);
        };
        const failed = await w.publish(card);
        w.store.exec = original;
        expect(failed.statusCode).toBe(500);
        expect((await w.store.artifact(w.artifact.id, w.user.id)).version).toBe(
          1,
        );
        expect((await w.view()).cards[0]!.status).toBe('proposed');
        expect(
          (
            await w.request('POST', `/cards/${card.id}/dismiss`, {
              cardVersion: 1,
              artifactVersion: 1,
            })
          ).statusCode,
        ).toBe(200);
        const cards = await conversationExportPage(
            w.store,
            w.artifact.id,
            'studio_conversation_cards',
            0,
            1,
          ),
          snapshots = await conversationExportPage(
            w.store,
            w.artifact.id,
            'studio_conversation_snapshots',
          );
        expect(cards.rows[0]!.status).toBe('dismissed');
        expect(JSON.parse(snapshots.rows[0]!.input_json).messages[0].id).toBe(
          w.message.id,
        );
        expect(
          (
            await conversationExportPage(
              w.store,
              w.artifact.id,
              'studio_conversation_cards',
              cards.nextCursor!,
            )
          ).rows,
        ).toEqual([]);
      });
    },
  );
