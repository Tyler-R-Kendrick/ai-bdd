import { randomUUID } from 'node:crypto';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { z } from 'zod';
import { HttpError, type Store } from '../store.ts';
import type { User } from '../../shared/domain.ts';
import { uploadedMediaType } from '../media-files.ts';
import type { ObjectStore } from './ports.ts';

const MB = 1024 * 1024;
const uploadSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(250)
      .refine(
        (v) =>
          !v.includes('/') &&
          !v.includes('\\') &&
          !Array.from(v).some(
            (character) =>
              character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ),
      ),
    byteSize: z
      .number()
      .int()
      .positive()
      .max(100 * MB),
    contentType: z.string().max(200),
  })
  .strict();
export type UploadGrant = {
  id: string;
  pathname: string;
  token: string;
  expiresAt: number;
  maximumSizeInBytes: number;
};
export type AssetValidator = (input: {
  bytes: Buffer;
  mime: string;
  name: string;
}) => Promise<void>;
export class UploadAdmission {
  /** Application-owned format validation, including bounded compressed-media inspection. */
  validateAsset?: AssetValidator;
  readonly #token: string;
  constructor(
    readonly store: Store,
    readonly objects: ObjectStore,
    token: string,
    readonly clock: () => number = Date.now,
  ) {
    this.#token = token;
  }
  async initialize() {
    await this.store.tx(async () => {
      await this.store.db.lock('schema:hosting-uploads');
      await this.store.db.exec(
        `CREATE TABLE IF NOT EXISTS studio_uploads(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,declared_type TEXT NOT NULL,storage_key TEXT NOT NULL UNIQUE,byte_size BIGINT NOT NULL,expires_at BIGINT NOT NULL,status TEXT NOT NULL,lease_until BIGINT NOT NULL DEFAULT 0);CREATE INDEX IF NOT EXISTS studio_uploads_expiry ON studio_uploads(status,expires_at);`,
      );
    });
    this.store.fileQuotaReservations = async (projectId, exemptFileId) =>
      Number(
        (
          await this.store.one(
            "SELECT coalesce(sum(byte_size),0) AS n FROM studio_uploads WHERE project_id=? AND id<>? AND status IN ('reserved','deleting')",
            projectId,
            exemptFileId,
          )
        ).n,
      );
    return this;
  }
  async grant(
    user: User,
    artifactId: string,
    input: unknown,
  ): Promise<UploadGrant> {
    const value = uploadSchema.parse(input),
      initial = await this.store.artifact(artifactId, user.id, 'write');
    if (value.byteSize > 10 * MB && !/^(audio|video)\//.test(value.contentType))
      throw new HttpError(
        413,
        'Images, fonts, and models are limited to 10 MB; audio and video to 100 MB.',
      );
    const id = randomUUID(),
      pathname = `studio/v1/uploads/${initial.projectId}/${id}`,
      expiresAt = this.clock() + 10 * 60_000;
    await this.store.tx(async () => {
      await this.store.db.lock('project:' + initial.projectId);
      await this.store.artifact(artifactId, user.id, 'write');
      const used = Number(
        (
          await this.store.one(
            'SELECT coalesce(sum(byte_size),0) AS n FROM files WHERE project_id=?',
            initial.projectId,
          )
        ).n,
      );
      // Expiration never frees quota until the corresponding private object has been deleted.
      const reserved = Number(
        (
          await this.store.one(
            "SELECT coalesce(sum(byte_size),0) AS n FROM studio_uploads WHERE project_id=? AND status IN ('reserved','deleting')",
            initial.projectId,
          )
        ).n,
      );
      if (used + reserved + value.byteSize > 512 * MB)
        throw new HttpError(
          413,
          'This project has reached its 512 MB asset quota, including pending uploads.',
        );
      await this.store.exec(
        'INSERT INTO studio_uploads(id,project_id,artifact_id,user_id,name,declared_type,storage_key,byte_size,expires_at,status,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        id,
        initial.projectId,
        artifactId,
        user.id,
        value.name,
        value.contentType,
        pathname,
        value.byteSize,
        expiresAt,
        'reserved',
        0,
      );
    });
    // The grant can only create this exact immutable object. It cannot read/list/delete other blobs.
    const token = await generateClientTokenFromReadWriteToken({
      token: this.#token,
      pathname,
      maximumSizeInBytes: value.byteSize,
      validUntil: expiresAt,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    return {
      id,
      pathname,
      token,
      expiresAt,
      maximumSizeInBytes: value.byteSize,
    };
  }
  private async ticket(user: User, id: string) {
    if (!z.string().uuid().safeParse(id).success)
      throw new HttpError(404, 'Upload not found');
    const row = await this.store.one(
      'SELECT * FROM studio_uploads WHERE id=? AND user_id=?',
      id,
      user.id,
    );
    if (!row) throw new HttpError(404, 'Upload not found');
    await this.store.artifact(row.artifact_id, user.id, 'write');
    return row;
  }
  async complete(user: User, id: string) {
    const ticket = await this.ticket(user, id);
    if (ticket.status === 'complete')
      return this.fileResult(await this.store.file(id, user.id));
    if (
      ticket.status !== 'reserved' ||
      Number(ticket.expires_at) <= this.clock()
    )
      throw new HttpError(409, 'Upload expired. Select the file again.');
    const object = await this.objects.get(ticket.storage_key, {
      maxBytes: Number(ticket.byte_size),
    });
    if (!object)
      throw new HttpError(409, 'Upload has not reached private storage yet.');
    if (object.byteSize !== Number(ticket.byte_size))
      throw new HttpError(
        400,
        'Uploaded file size differs from its admission.',
      );
    const bytes = Buffer.from(object.bytes);
    const mime = uploadedMediaType(bytes, ticket.name, ticket.declared_type);
    if (object.byteSize > 10 * MB && !/^(audio|video)\//.test(mime))
      throw new HttpError(413, 'This media type is limited to 10 MB.');
    await this.validateAsset?.({ bytes, mime, name: ticket.name });
    return this.store.tx(async () => {
      await this.store.db.lock('project:' + ticket.project_id);
      const current = await this.ticket(user, id);
      if (current.status === 'complete')
        return this.fileResult(await this.store.file(id, user.id));
      if (
        current.status !== 'reserved' ||
        Number(current.expires_at) <= this.clock()
      )
        throw new HttpError(409, 'Upload expired. Select the file again.');
      const file = await this.store.registerFile(user, ticket.artifact_id, {
        id,
        name: ticket.name,
        mime,
        sha256: object.sha256,
        storageKey: ticket.storage_key,
        byteSize: object.byteSize,
      });
      await this.store.exec(
        "UPDATE studio_uploads SET status='complete' WHERE id=? AND status='reserved'",
        id,
      );
      return this.fileResult(file);
    });
  }
  private fileResult(file: {
    id: string;
    name: string;
    mime: string;
    sha256: string;
    byteSize: number;
  }) {
    return {
      id: file.id,
      url: `/api/files/${file.id}`,
      name: file.name,
      mime: file.mime,
      sha256: file.sha256,
      byteSize: file.byteSize,
    };
  }
  /** Bounded recovery: deletion is leased; only successful deletion releases the reservation. */
  async cleanup(limit = 20) {
    const rows = await this.store.all(
      "SELECT * FROM studio_uploads WHERE expires_at<? AND (status='reserved' OR (status='deleting' AND lease_until<?)) ORDER BY expires_at LIMIT ?",
      this.clock() - 60_000,
      this.clock(),
      Math.min(50, Math.max(1, limit)),
    );
    for (const row of rows) {
      const claimed = await this.store.tx(async () => {
        await this.store.db.lock('project:' + row.project_id);
        const leaseUntil = this.clock() + 120_000;
        const result = await this.store.db.run(
          "UPDATE studio_uploads SET status='deleting',lease_until=? WHERE id=? AND expires_at<? AND (status='reserved' OR (status='deleting' AND lease_until<?))",
          [leaseUntil, row.id, this.clock() - 60_000, this.clock()],
        );
        return result.changes === 1 ? leaseUntil : undefined;
      });
      if (!claimed) continue;
      try {
        await this.objects.delete(row.storage_key);
        await this.store.exec(
          "UPDATE studio_uploads SET status='deleted',lease_until=0 WHERE id=? AND status='deleting' AND lease_until=?",
          row.id,
          claimed,
        );
      } catch {
        /* Reservation remains charged; a later durable maintenance tick retries. */
      }
    }
  }
}
