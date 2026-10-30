import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  agentProfileSchema,
  type AgentProfile,
} from '../../shared/agent-profile.ts';
import type { Artifact, User, RichNode } from '../../shared/domain.ts';
import { HttpError, type Store } from '../store.ts';
import type {
  DurableJobContext,
  DurableJobRuntime,
} from '../runtime/contracts.ts';
import {
  titleGoalSchema,
  type TitleGenerationInput,
  type TitleGoal,
} from './title-provider.ts';
import {
  hasEmptyDocumentBody,
  seedDocumentGoal,
} from './title-goal-content.ts';

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
  contentHash: z.string().optional(),
  seedGoal: z.boolean().default(false),
  messages: z.array(z.object({ author: z.string(), body: z.string() })).max(12),
});
export type TitleProvider = (
  input: TitleGenerationInput,
) => Promise<string | TitleGoal>;
const sourceHash = (artifact: Artifact) =>
  createHash('sha256').update(JSON.stringify(artifact.content)).digest('hex');

/** Human titles are protected by default. Background naming is explicit and durable. */
export class ArtifactTitles {
  constructor(
    readonly options: {
      store: Store;
      runtime: DurableJobRuntime;
      provider?: TitleProvider;
      allowed?: (user: User, artifactId: string) => Promise<boolean>;
      onAdmit?: (user: User, artifactId: string) => Promise<void>;
      available?: (user: User, artifactId: string) => Promise<boolean>;
      captureProfile?: (
        user: User,
        artifactId: string,
      ) => Promise<AgentProfile>;
      notify?: (projectId: string, artifactId: string) => Promise<void>;
      onGoalSeed?: (
        user: User,
        artifact: Artifact,
        beforeDoc: RichNode,
      ) => Promise<void>;
      quietMs?: number;
    },
  ) {}
  async initialize() {
    const { store, runtime } = this.options;
    await store.tx(async () => {
      await store.db.lock('schema:studio.titles');
      await store.db.exec(
        'CREATE TABLE IF NOT EXISTS studio_title_state(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,mode TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,seed_goal INTEGER NOT NULL DEFAULT 0)',
      );
      if (store.db.dialect === 'postgres')
        await store.db.exec(
          'ALTER TABLE studio_title_state ADD COLUMN IF NOT EXISTS seed_goal INTEGER NOT NULL DEFAULT 0',
        );
      else if (
        !(await store.all('PRAGMA table_info(studio_title_state)')).some(
          (column) => column.name === 'seed_goal',
        )
      )
        await store.db.exec(
          'ALTER TABLE studio_title_state ADD COLUMN seed_goal INTEGER NOT NULL DEFAULT 0',
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
      "INSERT INTO studio_title_state(artifact_id,mode,epoch,seed_goal) VALUES(?,'human',1,0) ON CONFLICT(artifact_id) DO UPDATE SET mode='human',epoch=studio_title_state.epoch+1,seed_goal=0",
      id,
    );
  }
  /** Only actual generated creation sites may initialize automatic naming. */
  async markGenerated(id: string) {
    const { store } = this.options;
    if (!store.db.inTransaction())
      throw new Error('Generated titles require the source transaction');
    await store.exec(
      "INSERT INTO studio_title_state(artifact_id,mode,epoch,seed_goal) VALUES(?,'automatic',0,0) ON CONFLICT(artifact_id) DO NOTHING",
      id,
    );
  }
  async policy(
    user: User,
    id: string,
    mode?: 'human' | 'automatic',
    seedGoal = false,
  ) {
    const { store } = this.options;
    const artifact = await store.artifact(id, user.id, mode ? 'write' : 'read');
    if (mode)
      await store.tx(async () => {
        await store.db.lock('project:' + artifact.projectId);
        const current = await store.artifact(id, user.id, 'write');
        if (mode === 'automatic')
          await store.artifactWriteGuard?.(current, user.id);
        if (seedGoal && !['design', 'document'].includes(current.kind))
          throw new HttpError(400, 'Goal seeding requires a document');
        await store.exec(
          'INSERT INTO studio_title_state(artifact_id,mode,epoch,seed_goal) VALUES(?,?,1,?) ON CONFLICT(artifact_id) DO UPDATE SET mode=excluded.mode,epoch=studio_title_state.epoch+1,seed_goal=excluded.seed_goal',
          id,
          mode,
          mode === 'automatic' && seedGoal ? 1 : 0,
        );
        await store.audit(
          artifact.projectId,
          id,
          user.name,
          'artifact.title-policy',
          JSON.stringify({ mode, seedGoal: mode === 'automatic' && seedGoal }),
        );
      });
    const row = await store.one(
      'SELECT mode,epoch,seed_goal FROM studio_title_state WHERE artifact_id=?',
      id,
    );
    return {
      mode: (row?.mode ?? 'human') as 'human' | 'automatic',
      seedGoal: !!row?.seed_goal,
      available:
        !!this.options.provider &&
        (!this.options.available || (await this.options.available(user, id))),
    };
  }
  async exportState(id: string) {
    const row = await this.options.store.one(
      'SELECT mode,epoch,seed_goal FROM studio_title_state WHERE artifact_id=?',
      id,
    );
    return {
      mode: row?.mode ?? 'human',
      epoch: Number(row?.epoch ?? 0),
      seedGoal: !!row?.seed_goal,
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
        'SELECT mode,epoch,seed_goal FROM studio_title_state WHERE artifact_id=?',
        id,
      );
      if (row?.mode !== 'automatic') return null;
      if (allowed && !(await allowed(user, id))) return null;
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
        contentHash: sourceHash(current),
        seedGoal: !!row.seed_goal && hasEmptyDocumentBody(current),
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
        'SELECT mode,epoch,seed_goal FROM studio_title_state WHERE artifact_id=?',
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
          (!s.contentHash || sourceHash(artifact) === s.contentHash) &&
          (!s.seedGoal ||
            (!!row.seed_goal && hasEmptyDocumentBody(artifact))) &&
          latest?.id === s.latestId &&
          (!allowed || (await allowed(user, artifact.id))),
      };
    };
    await ctx.assertCurrent();
    const initial = await eligible();
    if (!provider || !initial.valid)
      return ctx.commit('title-result', async () => ({ skipped: true }), {
        requireCurrentVersion: false,
      });
    const generated = await ctx.step('model-title', async (idempotencyKey) => {
      const value = await provider({
        artifact: initial.artifact,
        messages: s.messages,
        signal: ctx.signal,
        idempotencyKey,
        profile: s.profile,
      });
      if (typeof value !== 'string') return titleGoalSchema.parse(value);
      const title = value.trim();
      if (
        !title ||
        title.length > 180 ||
        [...title].some((character) => character.charCodeAt(0) < 32)
      )
        throw new HttpError(
          502,
          'The title provider returned an invalid title',
        );
      if (s.seedGoal)
        throw new HttpError(
          502,
          'The title provider returned no structured goal',
        );
      return { title };
    });
    // Earlier deployments stored this step's receipt as a string. Replays must
    // retain that receipt without calling the provider again or seeding a body.
    const proposal: { title: string; goal?: string } =
      typeof generated === 'string'
        ? { title: z.string().trim().min(1).max(180).parse(generated) }
        : z
            .object({
              title: z.string().trim().min(1).max(180),
              goal: titleGoalSchema.shape.goal.optional(),
            })
            .strict()
            .parse(generated);
    // The locked callback checks the exact version/hash and naming epoch. A
    // superseded automatic request records a skip instead of a failed job;
    // current membership/lease checks still precede this callback.
    const result = await ctx.commit(
      'title-result',
      async () => {
        const current = await eligible();
        if (!current.valid) return { skipped: true };
        await store.artifactWriteGuard?.(current.artifact, user.id);
        const title = proposal.title;
        let seeded = false;
        if (s.seedGoal && 'goal' in proposal) {
          await store.updateArtifact(
            { ...user, name: 'Studio agent' },
            current.artifact.id,
            current.artifact.version,
            seedDocumentGoal(current.artifact, title, proposal.goal!),
            title,
            () =>
              this.options.onGoalSeed?.(
                { ...user, name: 'Studio agent' },
                current.artifact,
                current.artifact.content.doc,
              ),
          );
          seeded = true;
        } else
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
          'Studio agent',
          'artifact.title-maintained',
          JSON.stringify({ title, goalSeeded: seeded, requestedBy: user.id }),
        );
        return { title, goalSeeded: seeded };
      },
      { requireCurrentVersion: false },
    );
    if (!('skipped' in result))
      await notify?.(ctx.job.projectId, ctx.job.artifactId);
    return result;
  }
}
