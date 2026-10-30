import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { User } from '../../shared/domain.ts';
import { Store, HttpError, hash } from '../store.ts';
import type { Collaboration } from '../collaboration.ts';
const now = () => new Date().toISOString();
const opaque = () => randomBytes(32).toString('base64url');
const publicWork = (row: any) => ({
  id: row.id,
  artifactId: row.artifact_id,
  version: row.artifact_version,
  kind: row.kind,
  brief: row.brief,
  status: row.status,
  machineId: row.machine_id,
  result: row.result ? JSON.parse(row.result) : null,
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
export class MachineService {
  constructor(
    readonly store: Store,
    readonly collab: Collaboration,
    readonly hooks: {
      otherWorkActive?: (machineId: string) => Promise<boolean>;
      onClaim?: (machine: any, work: any) => Promise<void>;
      onHeartbeat?: (
        machine: any,
        workId: string,
        leaseToken: string,
      ) => Promise<void>;
      onComplete?: (
        machine: any,
        work: any,
        result: Record<string, any>,
      ) => Promise<void>;
    } = {},
  ) {}
  async initialize() {
    const store = this.store;
    await store.tx(async () => {
      await store.lock('schema:studio.machines');
      await store.db.exec(`
      CREATE TABLE IF NOT EXISTS studio_machine_pairing(code_hash TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,label TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS studio_machines(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,label TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,expires INTEGER NOT NULL,last_seen INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS studio_machine_work(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),artifact_version INTEGER NOT NULL,kind TEXT NOT NULL,brief TEXT NOT NULL,status TEXT NOT NULL,machine_id TEXT REFERENCES studio_machines(id) ON DELETE SET NULL,lease_hash TEXT,lease_expires INTEGER,result TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS studio_machine_work_project ON studio_machine_work(project_id,status,created_at);
    `);
      await store.exec(
        'DELETE FROM studio_machine_pairing WHERE expires<?',
        Date.now(),
      );
    });
  }
  private async asUser<T>(
    user: User,
    projectId: string,
    action: 'write' | 'admin',
    operation: () => Promise<T>,
  ) {
    await this.store.role(projectId, user.id, action);
    return this.store.tx(async () => {
      await this.store.lock('project:' + projectId);
      await this.store.role(projectId, user.id, action);
      return operation();
    });
  }
  private async asMachine<T>(machine: any, operation: () => Promise<T>) {
    await this.store.role(machine.project_id, machine.user_id, 'write');
    return this.store.tx(async () => {
      await this.store.lock('project:' + machine.project_id);
      const current = await this.store.one(
        'SELECT id FROM studio_machines WHERE id=? AND project_id=? AND user_id=? AND token_hash=? AND expires>?',
        machine.id,
        machine.project_id,
        machine.user_id,
        machine.token_hash,
        Date.now(),
      );
      if (!current)
        throw new HttpError(
          401,
          'This machine credential is invalid or expired',
        );
      await this.store.role(machine.project_id, machine.user_id, 'write');
      await this.expire(machine.project_id);
      return operation();
    });
  }
  async pairing(user: User, projectId: string, label: string) {
    await this.store.role(projectId, user.id, 'admin');
    return this.asUser(user, projectId, 'admin', async () => {
      if (
        (
          await this.store.one(
            'SELECT count(*) AS n FROM studio_machines WHERE project_id=?',
            projectId,
          )
        ).n >= 20
      )
        throw new HttpError(
          409,
          'This project has reached its connected-machine limit',
        );
      const code = opaque(),
        expires = Date.now() + 10 * 60000;
      await this.store.exec(
        'INSERT INTO studio_machine_pairing VALUES(?,?,?,?,?)',
        hash(code),
        projectId,
        user.id,
        label,
        expires,
      );
      await this.store.audit(
        projectId,
        null,
        user.name,
        'machine.pairing.created',
        label,
      );
      return { code, expiresAt: new Date(expires).toISOString() };
    });
  }
  async pair(code: string) {
    const initial = await this.store.one(
      'SELECT * FROM studio_machine_pairing WHERE code_hash=? AND expires>?',
      hash(code),
      Date.now(),
    );
    if (!initial)
      throw new HttpError(
        401,
        'Pairing code is invalid, expired, or already used',
      );
    const user = await this.store.publicUser(initial.user_id);
    return this.asUser(user, initial.project_id, 'admin', async () => {
      const pairing = await this.store.one(
        'SELECT * FROM studio_machine_pairing WHERE code_hash=? AND expires>?',
        hash(code),
        Date.now(),
      );
      if (!pairing)
        throw new HttpError(
          401,
          'Pairing code is invalid, expired, or already used',
        );
      await this.store.role(pairing.project_id, pairing.user_id, 'admin');
      if (
        Number(
          (
            await this.store.one(
              'SELECT count(*) AS n FROM studio_machines WHERE project_id=?',
              pairing.project_id,
            )
          ).n,
        ) >= 20
      )
        throw new HttpError(
          409,
          'This project has reached its connected-machine limit',
        );
      const token = opaque(),
        id = randomUUID(),
        expires = Date.now() + 30 * 86400000;
      await this.store.exec(
        'DELETE FROM studio_machine_pairing WHERE code_hash=?',
        hash(code),
      );
      await this.store.exec(
        'INSERT INTO studio_machines VALUES(?,?,?,?,?,?,?,?)',
        id,
        pairing.project_id,
        pairing.user_id,
        pairing.label,
        hash(token),
        expires,
        Date.now(),
        now(),
      );
      await this.store.audit(
        pairing.project_id,
        null,
        pairing.label,
        'machine.connected',
      );
      return {
        id,
        token,
        projectId: pairing.project_id,
        expiresAt: new Date(expires).toISOString(),
      };
    });
  }
  async authenticate(request: FastifyRequest, id: string) {
    const token = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const machine = token
      ? await this.store.one(
          'SELECT * FROM studio_machines WHERE id=? AND token_hash=? AND expires>?',
          id,
          hash(token),
          Date.now(),
        )
      : null;
    if (!machine)
      throw new HttpError(401, 'This machine credential is invalid or expired');
    await this.store.role(machine.project_id, machine.user_id, 'write');
    return machine;
  }
  async machines(user: User, projectId: string) {
    await this.store.role(projectId, user.id);
    return (
      await this.store.all(
        'SELECT id,label,last_seen AS lastSeen,expires,created_at AS createdAt FROM studio_machines WHERE project_id=? ORDER BY created_at',
        projectId,
      )
    ).map((machine) => ({
      ...machine,
      connected:
        machine.expires > Date.now() && machine.lastSeen > Date.now() - 60000,
    }));
  }
  async revoke(user: User, projectId: string, id: string) {
    await this.store.role(projectId, user.id, 'admin');
    await this.asUser(user, projectId, 'admin', async () => {
      await this.store.exec(
        "UPDATE studio_machine_work SET status='interrupted',error='The connected machine was revoked',lease_hash=NULL,updated_at=? WHERE machine_id=? AND project_id=? AND status='running'",
        now(),
        id,
        projectId,
      );
      await this.store.exec(
        'DELETE FROM studio_machines WHERE id=? AND project_id=?',
        id,
        projectId,
      );
      await this.store.audit(projectId, null, user.name, 'machine.revoked', id);
    });
  }
  async queue(
    user: User,
    artifactId: string,
    input: {
      version: number;
      kind: 'implementation' | 'investigation';
      brief: string;
    },
  ) {
    const artifact = await this.store.artifact(artifactId, user.id, 'write');
    const output = await this.asUser(
      user,
      artifact.projectId,
      'write',
      async () => {
        const current = await this.store.artifact(artifactId, user.id, 'write');
        if (current.version !== input.version)
          throw new HttpError(409, 'The artifact changed before approval');
        if (artifact.version !== input.version)
          throw new HttpError(
            409,
            'The artifact changed. Review its current version before approving machine work.',
          );
        if (
          (
            await this.store.one(
              "SELECT count(*) AS n FROM studio_machine_work WHERE project_id=? AND status IN ('queued','running')",
              artifact.projectId,
            )
          ).n >= 20
        )
          throw new HttpError(409, 'The project machine-work queue is full');
        const id = randomUUID(),
          timestamp = now();
        await this.store.exec(
          'INSERT INTO studio_machine_work(id,artifact_id,project_id,user_id,artifact_version,kind,brief,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          id,
          artifactId,
          artifact.projectId,
          user.id,
          input.version,
          input.kind,
          input.brief,
          'queued',
          timestamp,
          timestamp,
        );
        await this.store.audit(
          artifact.projectId,
          artifactId,
          user.name,
          'machine.work.approved',
          JSON.stringify({ id, kind: input.kind, version: input.version }),
        );

        return publicWork(
          await this.store.one(
            'SELECT * FROM studio_machine_work WHERE id=?',
            id,
          ),
        );
      },
    );
    await this.collab.notify(artifact.projectId, artifactId);
    return output;
  }
  async list(user: User, artifactId: string) {
    await this.store.artifact(artifactId, user.id);
    return (
      await this.store.all(
        'SELECT * FROM studio_machine_work WHERE artifact_id=? ORDER BY rowid DESC LIMIT 100',
        artifactId,
      )
    ).map(publicWork);
  }
  private async expire(projectId: string) {
    await this.store.exec(
      "UPDATE studio_machine_work SET status='interrupted',error='The machine lease expired; execution is not automatically replayed',lease_hash=NULL,updated_at=? WHERE project_id=? AND status='running' AND lease_expires<?",
      now(),
      projectId,
      Date.now(),
    );
  }
  async heartbeat(machine: any, workId?: string, leaseToken?: string) {
    return this.asMachine(machine, async () => {
      await this.store.exec(
        'UPDATE studio_machines SET last_seen=? WHERE id=?',
        Date.now(),
        machine.id,
      );
      let leaseActive = false;
      if (workId && leaseToken) {
        leaseActive =
          (
            await this.store.exec(
              "UPDATE studio_machine_work SET lease_expires=? WHERE id=? AND machine_id=? AND lease_hash=? AND status='running'",
              Date.now() + 120000,
              workId,
              machine.id,
              hash(leaseToken),
            )
          ).changes === 1;
      }
      if (leaseActive && workId && leaseToken)
        await this.hooks.onHeartbeat?.(machine, workId, leaseToken);
      return { connected: true, leaseActive };
    });
  }
  async claim(machine: any) {
    return this.asMachine(machine, async () => {
      if (
        (await this.hooks.otherWorkActive?.(machine.id)) ||
        (await this.store.one(
          "SELECT id FROM studio_machine_work WHERE machine_id=? AND status='running'",
          machine.id,
        ))
      )
        return { work: null };
      const work = await this.store.one(
        "SELECT * FROM studio_machine_work WHERE project_id=? AND status='queued' ORDER BY rowid LIMIT 1",
        machine.project_id,
      );
      if (!work) return { work: null };
      try {
        await this.store.role(work.project_id, work.user_id, 'write');
      } catch {
        await this.store.exec(
          "UPDATE studio_machine_work SET status='interrupted',error='The requesting member no longer has write access',updated_at=? WHERE id=?",
          now(),
          work.id,
        );
        return { work: null };
      }
      const user = await this.store.publicUser(machine.user_id),
        artifact = await this.store.artifact(
          work.artifact_id,
          user.id,
          'write',
        );
      if (artifact.version !== work.artifact_version) {
        await this.store.exec(
          "UPDATE studio_machine_work SET status='interrupted',error='The artifact changed before a machine claimed this work',updated_at=? WHERE id=?",
          now(),
          work.id,
        );
        return { work: null };
      }
      await this.hooks.onClaim?.(machine, work);
      const leaseToken = opaque();
      await this.store.exec(
        "UPDATE studio_machine_work SET status='running',machine_id=?,lease_hash=?,lease_expires=?,updated_at=? WHERE id=? AND status='queued'",
        machine.id,
        hash(leaseToken),
        Date.now() + 120000,
        now(),
        work.id,
      );
      await this.store.exec(
        'UPDATE studio_machines SET last_seen=? WHERE id=?',
        Date.now(),
        machine.id,
      );
      return {
        work: {
          ...publicWork({
            ...work,
            status: 'running',
            machine_id: machine.id,
          }),
          artifact: {
            id: artifact.id,
            kind: artifact.kind,
            title: artifact.title,
            content: artifact.content,
            version: artifact.version,
          },
          repository: (
            await this.store.one(
              'SELECT repository FROM projects WHERE id=?',
              machine.project_id,
            )
          ).repository,
        },
        leaseToken,
      };
    });
  }
  async complete(
    machine: any,
    workId: string,
    leaseToken: string,
    result: {
      summary: string;
      content?: Record<string, any>;
      pullRequestUrl?: string;
    },
  ) {
    const output = await this.asMachine(machine, async () => {
      const work = await this.store.one(
        "SELECT * FROM studio_machine_work WHERE id=? AND machine_id=? AND lease_hash=? AND status='running'",
        workId,
        machine.id,
        hash(leaseToken),
      );
      if (!work)
        throw new HttpError(
          409,
          'This work lease ended; the result cannot be submitted',
        );
      await this.store.role(work.project_id, work.user_id, 'write');
      const user = await this.store.publicUser(machine.user_id),
        artifact = await this.store.artifact(
          work.artifact_id,
          user.id,
          'write',
        );
      const content = result.content
        ? await this.store.checkedContent(
            artifact.kind,
            result.content,
            artifact.projectId,
            artifact.id,
          )
        : undefined;
      await this.store.exec(
        "UPDATE studio_machine_work SET status='awaiting-review',result=?,lease_hash=NULL,lease_expires=NULL,updated_at=? WHERE id=?",
        JSON.stringify({
          summary: result.summary,
          ...(content ? { content } : {}),
          ...(result.pullRequestUrl
            ? { pullRequestUrl: result.pullRequestUrl }
            : {}),
          suppliedBy: machine.label,
          evidenceStatus: 'external-unverified',
        }),
        now(),
        work.id,
      );
      await this.hooks.onComplete?.(machine, work, result);
      await this.store.audit(
        artifact.projectId,
        artifact.id,
        machine.label,
        'machine.result.submitted',
        work.id,
      );

      return {
        ok: true,
        status: 'awaiting-review',
        stale: artifact.version !== work.artifact_version,
        artifactId: artifact.id,
      };
    });
    await this.collab.notify(machine.project_id, output.artifactId);
    return { ok: output.ok, status: output.status, stale: output.stale };
  }
  async fail(machine: any, workId: string, leaseToken: string) {
    return this.asMachine(machine, async () => {
      const changed = (
        await this.store.exec(
          "UPDATE studio_machine_work SET status='failed',error='The connected ACP worker could not complete this approved task',lease_hash=NULL,lease_expires=NULL,updated_at=? WHERE id=? AND machine_id=? AND lease_hash=? AND status='running'",
          now(),
          workId,
          machine.id,
          hash(leaseToken),
        )
      ).changes;
      if (changed !== 1)
        throw new HttpError(409, 'This work lease already ended');
      return { ok: true };
    });
  }
  async review(
    user: User,
    artifactId: string,
    workId: string,
    accept: boolean,
  ) {
    const artifact = await this.store.artifact(artifactId, user.id, 'write');
    const work = await this.store.one(
      "SELECT * FROM studio_machine_work WHERE id=? AND artifact_id=? AND status='awaiting-review'",
      workId,
      artifactId,
    );
    if (!work)
      throw new HttpError(404, 'Machine result is not awaiting review');
    const result = JSON.parse(work.result);
    if (accept && artifact.version !== work.artifact_version)
      throw new HttpError(
        409,
        'The artifact changed. Compare the machine result with the current version before applying it.',
      );
    const persist = async () => {
      const changed = await this.store.exec(
        "UPDATE studio_machine_work SET status=?,updated_at=? WHERE id=? AND status='awaiting-review'",
        accept ? 'accepted' : 'rejected',
        now(),
        work.id,
      );
      if (changed.changes !== 1)
        throw new HttpError(409, 'This result was already reviewed');
      await this.store.audit(
        artifact.projectId,
        artifact.id,
        user.name,
        accept ? 'machine.result.accepted' : 'machine.result.rejected',
        work.id,
      );
    };
    if (accept && result.content) {
      if (['design', 'document'].includes(artifact.kind))
        await this.collab.replace(
          artifact.id,
          user,
          result.content,
          work.artifact_version,
          persist,
        );
      else
        await this.store.updateArtifact(
          user,
          artifact.id,
          work.artifact_version,
          result.content,
          undefined,
          persist,
        );
    } else await this.asUser(user, artifact.projectId, 'write', persist);
    await this.collab.notify(artifact.projectId, artifact.id);
    return { ok: true };
  }
  async cancel(user: User, artifactId: string, workId: string) {
    const artifact = await this.store.artifact(artifactId, user.id, 'write');
    await this.asUser(user, artifact.projectId, 'write', async () => {
      await this.store.exec(
        "UPDATE studio_machine_work SET status='cancelled',lease_hash=NULL,updated_at=? WHERE id=? AND artifact_id=? AND status IN ('queued','running')",
        now(),
        workId,
        artifactId,
      );
      await this.store.audit(
        artifact.projectId,
        artifactId,
        user.name,
        'machine.work.cancelled',
        workId,
      );
    });
    await this.collab.notify(artifact.projectId, artifactId);
    return { ok: true };
  }
}
