import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  agentProfileSchema,
  type AgentProfile,
} from '../../shared/agent-profile.ts';
import type { Artifact, User } from '../../shared/domain.ts';
import { HttpError, type Store } from '../store.ts';
import type {
  DurableJobContext,
  DurableJobRuntime,
} from '../runtime/contracts.ts';

const snapshotSchema = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    color: z.string(),
  }),
  threadId: z.string(),
  latestId: z.string(),
  epoch: z.number().int(),
  profile: agentProfileSchema.optional(),
  title: z.string(),
  messages: z
    .array(z.object({ author: z.string(), body: z.string() }))
    .max(12),
});
export type TitleProvider = (input: {
  artifact: Pick<Artifact, 'id' | 'title' | 'kind'>;
  messages: { author: string; body: string }[];
  signal: AbortSignal;
  idempotencyKey: string;
  profile?: AgentProfile;
}) => Promise<string>;

/** Human titles are protected by default. Background naming is explicit and durable. */
export class ArtifactTitles {
  constructor(
    readonly options: {
      store: Store;
      runtime: DurableJobRuntime;
      provider?: TitleProvider;
      allowed?: (user: User, artifactId: string) => Promise<boolean>;
      onAdmit?: (user: User, artifactId: string) => Promise<void>;
      captureProfile?: (
        user: User,
        artifactId: string,
      ) => Promise<AgentProfile>;
      notify?: (projectId: string, artifactId: string) => Promise<void>;
      quietMs?: number;
    },
  ) {}
  async initialize() {
    const { store, runtime } = this.options;
    await store.tx(async () => {
      await store.db.lock('schema:studio.titles');
      await store.db.exec(
        'CREATE TABLE IF NOT EXISTS studio_title_state(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,mode TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 0)',
      );
    });
    runtime.register('artifact.title', (ctx) => this.execute(ctx));
  }
  /** Call in the same project transaction as a human rename, including MCP edits. */
  async markHuman(id: string) {
    const { store } = this.options;
    if (!store.db.inTransaction())
      throw new Error('Human title claims require the source transaction');
    await store.exec(
      "INSERT INTO studio_title_state VALUES(?,'human',1) ON CONFLICT(artifact_id) DO UPDATE SET mode='human',epoch=studio_title_state.epoch+1",
      id,
    );
  }
  /** Only actual generated creation sites may initialize automatic naming. */
  async markGenerated(id: string) {
    const { store } = this.options;
    if (!store.db.inTransaction())
      throw new Error('Generated titles require the source transaction');
    await store.exec(
      "INSERT INTO studio_title_state VALUES(?,'automatic',0) ON CONFLICT(artifact_id) DO NOTHING",
      id,
    );
  }
  async policy(user: User, id: string, mode?: 'human' | 'automatic') {
    const { store } = this.options;
    const artifact = await store.artifact(
      id,
      user.id,
      mode ? 'write' : 'read',
    );
    if (mode)
      await store.tx(async () => {
        await store.db.lock('project:' + artifact.projectId);
        await store.artifact(id, user.id, 'write');
        await store.exec(
          'INSERT INTO studio_title_state VALUES(?,?,1) ON CONFLICT(artifact_id) DO UPDATE SET mode=excluded.mode,epoch=studio_title_state.epoch+1',
          id,
          mode,
        );
        await store.audit(
          artifact.projectId,
          id,
          user.name,
          'artifact.title-policy',
          mode,
        );
      });
    const row = await store.one(
      'SELECT mode,epoch FROM studio_title_state WHERE artifact_id=?',
      id,
    );
    return {
      mode: (row?.mode ?? 'human') as 'human' | 'automatic',
      available: !!this.options.provider,
    };
  }
  async observeMessage(user: User, id: string, threadId: string) {
    const { store, runtime, provider, allowed } = this.options;
    if (!provider || (allowed && !(await allowed(user, id)))) return;
    const artifact = await store.artifact(id, user.id, 'write');
    const job = await store.tx(async () => {
      await store.db.lock('project:' + artifact.projectId);
      const current = await store.artifact(id, user.id, 'write');
      const row = await store.one(
        'SELECT mode,epoch FROM studio_title_state WHERE artifact_id=?',
        id,
      );
      if (row?.mode !== 'automatic') return null;
      const messages = (
        await store.messagePage(id, threadId, { limit: 12 })
      ).messages.filter((m) => m.role === 'user');
      const latest = messages.at(-1);
      if (!latest) return null;
      await this.options.onAdmit?.(user, id);
      const profile = await this.options.captureProfile?.(user, id);
      const snapshot = {
        ...(profile ? { profile } : {}),
        user,
        threadId,
        latestId: latest.id,
        epoch: row.epoch,
        title: current.title,
        messages: messages.map((m) => ({
          author: m.author.slice(0, 100),
          body: m.body.slice(0, 1000),
        })),
      };
      return runtime.enqueue({
        kind: 'artifact.title',
        projectId: current.projectId,
        artifactId: id,
        principalId: user.id,
        artifactVersion: current.version,
        snapshot,
        idempotencyKey: createHash('sha256')
          .update(JSON.stringify({ id, snapshot }))
          .digest('hex'),
        availableAt: Date.now() + (this.options.quietMs ?? 2500),
        maxAttempts: 3,
      });
    });
    if (job) await runtime.flushOutbox();
  }
  private async execute(ctx: DurableJobContext) {
    const { store, provider, allowed, notify } = this.options;
    const s = snapshotSchema.parse(ctx.snapshot);
    const user: User = s.user;
    const eligible = async () => {
      const artifact = await store.artifact(
        ctx.job.artifactId,
        user.id,
        'write',
      );
      const row = await store.one(
        'SELECT mode,epoch FROM studio_title_state WHERE artifact_id=?',
        artifact.id,
      );
      const latest = (
        await store.messagePage(artifact.id, s.threadId, { limit: 12 })
      ).messages
        .filter((m) => m.role === 'user')
        .at(-1);
      return {
        artifact,
        valid:
          row?.mode === 'automatic' &&
          row.epoch === s.epoch &&
          artifact.title === s.title &&
          artifact.version === ctx.job.artifactVersion &&
          latest?.id === s.latestId &&
          (!allowed || (await allowed(user, artifact.id))),
      };
    };
    await ctx.assertCurrent();
    const initial = await eligible();
    if (!provider || !initial.valid)
      return ctx.commit('title-result', async () => ({ skipped: true }));
    const title = await ctx.step('model-title', async (idempotencyKey) => {
      const value = (
        await provider({
          artifact: initial.artifact,
          messages: s.messages,
          signal: ctx.signal,
          idempotencyKey,
          profile: s.profile,
        })
      ).trim();
      if (!value || value.length > 180 || /[\u0000-\u001f]/.test(value))
        throw new HttpError(
          502,
          'The title provider returned an invalid title',
        );
      return value;
    });
    return ctx.commit('title-result', async () => {
      const current = await eligible();
      if (!current.valid) return { skipped: true };
      await store.exec(
        'UPDATE artifacts SET title=?,updated_at=? WHERE id=?',
        title,
        new Date().toISOString(),
        current.artifact.id,
      );
      await store.exec(
        'UPDATE studio_title_state SET epoch=epoch+1 WHERE artifact_id=?',
        current.artifact.id,
      );
      await store.audit(
        current.artifact.projectId,
        current.artifact.id,
        user.name,
        'artifact.title-maintained',
        title,
      );
      await notify?.(current.artifact.projectId, current.artifact.id);
      return { title };
    });
  }
}
