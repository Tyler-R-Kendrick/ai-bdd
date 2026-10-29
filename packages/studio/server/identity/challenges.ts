import { createHash } from 'node:crypto';
import { HttpError } from '../store.ts';
import type { IdentityStore } from './ports.ts';
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
/** Shared SQL, atomic one-use challenges. No process-local Map is an authority. */
export class DurableChallenges {
  constructor(
    readonly store: Pick<IdentityStore, 'one' | 'exec'>,
    readonly now: () => number = Date.now,
  ) {}
  async initialize() {
    await this.store.exec(
      `CREATE TABLE IF NOT EXISTS identity_challenges(namespace TEXT NOT NULL,state_hash TEXT NOT NULL,binding_hash TEXT NOT NULL,payload TEXT NOT NULL,user_id TEXT,session_hash TEXT,expires_at BIGINT NOT NULL,PRIMARY KEY(namespace,state_hash))`,
    );
    await this.store.exec(
      'CREATE INDEX IF NOT EXISTS identity_challenges_expiry ON identity_challenges(expires_at)',
    );
  }
  async put(
    namespace: string,
    state: string,
    binding: string,
    payload: unknown,
    expiresAt: number,
    context: { userId?: string; sessionHash?: string } = {},
  ) {
    const data = JSON.stringify(payload);
    if (
      !/^[a-z0-9_-]{1,30}$/.test(namespace) ||
      state.length < 20 ||
      state.length > 512 ||
      binding.length < 20 ||
      binding.length > 512 ||
      data.length > 16000 ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= this.now() ||
      expiresAt > this.now() + 600000
    )
      throw new Error('Invalid authentication challenge');
    await this.store.exec(
      'DELETE FROM identity_challenges WHERE expires_at<=?',
      this.now(),
    );
    const inserted = await this.store.one(
      'INSERT INTO identity_challenges(namespace,state_hash,binding_hash,payload,user_id,session_hash,expires_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM identity_challenges WHERE namespace=?)<1000 RETURNING state_hash',
      namespace,
      digest(state),
      digest(binding),
      data,
      context.userId ?? null,
      context.sessionHash ?? null,
      expiresAt,
      namespace,
    );
    if (!inserted)
      throw new HttpError(429, 'Too many sign-in attempts. Try again shortly.');
  }
  async consume<T>(
    namespace: string,
    state: string,
    binding: string,
  ): Promise<{
    payload: T;
    userId: string | null;
    sessionHash: string | null;
  } | null> {
    if (state.length > 512 || binding.length > 512 || !state || !binding)
      return null;
    const row = await this.store.one(
      'DELETE FROM identity_challenges WHERE namespace=? AND state_hash=? AND binding_hash=? AND expires_at>? RETURNING payload,user_id,session_hash',
      namespace,
      digest(state),
      digest(binding),
      this.now(),
    );
    if (!row) return null;
    return {
      payload: JSON.parse(row.payload) as T,
      userId: row.user_id ?? null,
      sessionHash: row.session_hash ?? null,
    };
  }
}
