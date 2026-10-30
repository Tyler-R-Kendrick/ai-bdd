import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Store, HttpError, hash } from '../store.ts';
import type { Auth } from '../auth.ts';
import type { User } from '../../shared/domain.ts';
import type { ImplementationGraphs } from './implementation.ts';
import {
  checkoutRegistrationSchema,
  accountMachineTrust,
  type CheckoutRegistration,
} from '../../shared/account-machines.ts';
const opaque = () => randomBytes(32).toString('base64url'),
  now = () => new Date().toISOString(),
  uuid = z.string().uuid();
const sameRepo = (a: string, b: string) =>
  a.replace(/\/$/, '').toLowerCase() === b.replace(/\/$/, '').toLowerCase();
export type AccountPrincipal = {
  id: string;
  user_id: string;
  token_hash: string;
  expires: number;
  token: string;
};
export type AccountMachineDependencies = {
  store: Store;
  auth: Auth;
  graphs?: ImplementationGraphs;
  notify?: (projectId: string, artifactId?: string) => void;
  plannerAssignments?: boolean;
};
export class AccountMachines {
  readonly ready: Promise<void>;
  private readonly presentTables = new Set<string>();
  constructor(readonly dependencies: AccountMachineDependencies) {
    this.ready = this.initialize();
  }
  get store() {
    return this.dependencies.store;
  }
  private async initialize() {
    await this.store.tx(async () => {
      await this.store.db.lock('schema:studio.account-machines');
      await this.store.db.exec(
        `CREATE TABLE IF NOT EXISTS studio_account_machine_pairing(code_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,label TEXT NOT NULL,expires BIGINT NOT NULL,trust_version TEXT NOT NULL,trusted_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS studio_account_machines(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,label TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,expires BIGINT NOT NULL,last_seen BIGINT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,trust_version TEXT NOT NULL,trusted_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS studio_account_machine_bindings(account_machine_id TEXT NOT NULL REFERENCES studio_account_machines(id) ON DELETE CASCADE,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,child_machine_id TEXT NOT NULL UNIQUE,checkout_key TEXT NOT NULL,repository TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(account_machine_id,project_id));`,
      );
      await this.store.exec(
        'DELETE FROM studio_account_machine_pairing WHERE expires<?',
        Date.now(),
      );
    });
  }
  private async table(name: string) {
    if (this.presentTables.has(name)) return true;
    const row =
      this.store.db.dialect === 'sqlite'
        ? await this.store.one(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            name,
          )
        : await this.store.one(
            'SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=?',
            name,
          );
    if (row) this.presentTables.add(name);
    return !!row;
  }
  private async fresh(principal: AccountPrincipal) {
    const row = await this.store.one(
      "SELECT * FROM studio_account_machines WHERE id=? AND user_id=? AND token_hash=? AND expires>? AND status='active'",
      principal.id,
      principal.user_id,
      principal.token_hash,
      Date.now(),
    );
    if (!row)
      throw new HttpError(401, 'This account machine was revoked or expired');
    await this.store.publicUser(row.user_id);
    return row;
  }
  async authenticate(
    request: FastifyRequest,
    id: string,
  ): Promise<AccountPrincipal> {
    await this.ready;
    const token = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1],
      row = token
        ? await this.store.one(
            "SELECT * FROM studio_account_machines WHERE id=? AND token_hash=? AND expires>? AND status='active'",
            uuid.parse(id),
            hash(token),
            Date.now(),
          )
        : null;
    if (!row)
      throw new HttpError(
        401,
        'This account machine credential was revoked or expired',
      );
    await this.store.publicUser(row.user_id);
    return { ...row, token: token! };
  }
  async pairing(user: User, label: string) {
    await this.ready;
    return this.store.tx(async () => {
      await this.store.db.lock('account-machine-owner:' + user.id);
      await this.store.publicUser(user.id);
      if (
        (
          await this.store.one(
            "SELECT count(*) AS n FROM studio_account_machines WHERE user_id=? AND status='active'",
            user.id,
          )
        ).n >= 20
      )
        throw new HttpError(
          409,
          'Your account has reached its 20-machine limit',
        );
      const code = opaque(),
        expires = Date.now() + 600000;
      await this.store.exec(
        'INSERT INTO studio_account_machine_pairing(code_hash,user_id,label,expires,trust_version,trusted_at) VALUES(?,?,?,?,?,?)',
        hash(code),
        user.id,
        label,
        expires,
        'account-v1',
        now(),
      );
      return {
        code,
        expiresAt: new Date(expires).toISOString(),
        scope: 'account',
        trust: accountMachineTrust,
      };
    });
  }
  async pair(code: string) {
    await this.ready;
    return this.store.tx(async () => {
      await this.store.db.lock('account-machine-pair:' + hash(code));
      const pairing = await this.store.one(
        'SELECT * FROM studio_account_machine_pairing WHERE code_hash=? AND expires>?',
        hash(code),
        Date.now(),
      );
      if (!pairing)
        throw new HttpError(
          401,
          'The account pairing code expired or was already used',
        );
      await this.store.db.lock('account-machine-owner:' + pairing.user_id);
      await this.store.publicUser(pairing.user_id);
      if (
        (
          await this.store.one(
            "SELECT count(*) AS n FROM studio_account_machines WHERE user_id=? AND status='active'",
            pairing.user_id,
          )
        ).n >= 20
      )
        throw new HttpError(
          409,
          'Your account has reached its 20-machine limit',
        );
      const id = randomUUID(),
        token = opaque(),
        expires = Date.now() + 30 * 86400000;
      await this.store.exec(
        'DELETE FROM studio_account_machine_pairing WHERE code_hash=?',
        hash(code),
      );
      await this.store.exec(
        'INSERT INTO studio_account_machines(id,user_id,label,token_hash,expires,last_seen,status,created_at,trust_version,trusted_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        id,
        pairing.user_id,
        pairing.label,
        hash(token),
        expires,
        Date.now(),
        'active',
        now(),
        pairing.trust_version,
        pairing.trusted_at,
      );
      return {
        scope: 'account' as const,
        id,
        token,
        expiresAt: new Date(expires).toISOString(),
      };
    });
  }
  async list(user: User) {
    await this.ready;
    return this.store.all(
      'SELECT id,label,status,expires,last_seen AS lastSeen,created_at AS createdAt FROM studio_account_machines WHERE user_id=? ORDER BY created_at DESC LIMIT 100',
      user.id,
    );
  }
  /** Called inside every project mutation after its project lock. Legacy unbound credentials keep their original scope. */
  async assertCurrentMachine(machine: {
    id: string;
    project_id: string;
    user_id: string;
  }) {
    await this.ready;
    let binding = await this.store.one(
      'SELECT * FROM studio_account_machine_bindings WHERE child_machine_id=?',
      machine.id,
    );
    if (!binding) return;
    if (this.store.db.inTransaction())
      await this.store.db.lock('account-machine:' + binding.account_machine_id);
    binding = await this.store.one(
      'SELECT b.*,m.user_id,m.status AS machine_status,m.expires FROM studio_account_machine_bindings b JOIN studio_account_machines m ON m.id=b.account_machine_id WHERE b.child_machine_id=?',
      machine.id,
    );
    if (
      !binding ||
      binding.status !== 'active' ||
      binding.machine_status !== 'active' ||
      binding.expires <= Date.now() ||
      binding.user_id !== machine.user_id ||
      binding.project_id !== machine.project_id
    )
      throw new HttpError(
        401,
        'The account machine or this project assignment was revoked',
      );
  }
  async otherWorkActive(machineId: string) {
    await this.ready;
    const binding = await this.store.one(
      "SELECT account_machine_id FROM studio_account_machine_bindings WHERE child_machine_id=? AND status='active'",
      machineId,
    );
    if (!binding) return false;
    const children = (
      await this.store.all(
        "SELECT child_machine_id FROM studio_account_machine_bindings WHERE account_machine_id=? AND status='active'",
        binding.account_machine_id,
      )
    ).map((row) => row.child_machine_id);
    if (!children.length) return false;
    const marks = children.map(() => '?').join(',');
    for (const [table, statuses] of [
      ['studio_machine_work', "'running'"],
      ['studio_investigations', "'running'"],
      ['studio_implementation_machine_queue', "'launching','running'"],
      ['studio_rebuild_runs', "'running'"],
    ] as const) {
      if (
        (await this.table(table)) &&
        (await this.store.one(
          `SELECT id FROM ${table} WHERE machine_id IN (${marks}) AND status IN (${statuses}) LIMIT 1`,
          ...children,
        ))
      )
        return true;
    }
    return false;
  }
  private childToken(
    principal: AccountPrincipal,
    projectId: string,
    childId: string,
  ) {
    return createHmac('sha256', principal.token)
      .update(
        'studio-project-machine-v1\0' +
          principal.id +
          '\0' +
          projectId +
          '\0' +
          childId,
      )
      .digest('base64url');
  }
  async assignments(
    principal: AccountPrincipal,
    input: CheckoutRegistration[],
  ) {
    await this.ready;
    await this.fresh(principal);
    if (
      new Set(input.map((c) => c.checkoutKey)).size !== input.length ||
      new Set(input.map((c) => c.repository.toLowerCase())).size !==
        input.length
    )
      throw new HttpError(
        400,
        'Each explicit checkout key and repository must be unique',
      );
    const projects = await this.store.projects(principal.user_id),
      assignments = [],
      blocked = [];
    for (const project of projects) {
      const checkout = input.find((c) =>
        sameRepo(c.repository, project.repository),
      );
      if (!checkout) continue;
      try {
        await this.store.role(project.id, principal.user_id, 'write');
      } catch (error) {
        blocked.push({
          projectId: project.id,
          code:
            (error as HttpError).statusCode === 403
              ? 'permission-denied'
              : 'authorization-unavailable',
        });
        continue;
      }
      const result = await this.store.tx(async () => {
        await this.store.db.lock('project:' + project.id);
        await this.store.db.lock('account-machine:' + principal.id);
        const account = await this.fresh(principal);
        await this.store.role(project.id, principal.user_id, 'write');
        const current = await this.store.one(
          'SELECT repository FROM projects WHERE id=?',
          project.id,
        );
        if (!sameRepo(current.repository, checkout.repository))
          throw new HttpError(
            409,
            'The project repository changed while this machine registered',
          );
        let binding = await this.store.one(
          'SELECT * FROM studio_account_machine_bindings WHERE account_machine_id=? AND project_id=?',
          account.id,
          project.id,
        );
        if (binding?.status === 'revoked')
          return { blocked: 'project-device-revoked' };
        let child = binding
          ? await this.store.one(
              'SELECT * FROM studio_machines WHERE id=?',
              binding.child_machine_id,
            )
          : null;
        if (binding && !child) {
          await this.store.exec(
            "UPDATE studio_account_machine_bindings SET status='revoked',updated_at=? WHERE account_machine_id=? AND project_id=?",
            now(),
            account.id,
            project.id,
          );
          return { blocked: 'project-device-revoked' };
        }
        if (!binding) {
          if (
            (
              await this.store.one(
                'SELECT count(*) AS n FROM studio_account_machine_bindings WHERE account_machine_id=?',
                account.id,
              )
            ).n >= 100
          )
            throw new HttpError(
              409,
              'This account machine has reached its 100-project assignment limit',
            );
          if (
            (
              await this.store.one(
                'SELECT count(*) AS n FROM studio_machines WHERE project_id=?',
                project.id,
              )
            ).n >= 20
          )
            return { blocked: 'project-device-limit' };
          const childId = randomUUID(),
            at = now(),
            derived = this.childToken(principal, project.id, childId);
          await this.store.exec(
            'INSERT INTO studio_machines(id,project_id,user_id,label,token_hash,expires,last_seen,created_at) VALUES(?,?,?,?,?,?,?,?)',
            childId,
            project.id,
            principal.user_id,
            account.label,
            hash(derived),
            account.expires,
            Date.now(),
            at,
          );
          await this.store.exec(
            'INSERT INTO studio_account_machine_bindings(account_machine_id,project_id,child_machine_id,checkout_key,repository,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
            account.id,
            project.id,
            childId,
            checkout.checkoutKey,
            checkout.repository,
            'active',
            at,
            at,
          );
          binding = { child_machine_id: childId };
        } else {
          await this.store.exec(
            "UPDATE studio_account_machine_bindings SET status='active',checkout_key=?,repository=?,updated_at=? WHERE account_machine_id=? AND project_id=?",
            checkout.checkoutKey,
            checkout.repository,
            now(),
            account.id,
            project.id,
          );
          await this.store.exec(
            'UPDATE studio_machines SET expires=?,last_seen=? WHERE id=?',
            account.expires,
            Date.now(),
            binding.child_machine_id,
          );
        }
        await this.store.exec(
          'INSERT INTO studio_investigation_checkouts(machine_id,repository,source_commit,branch,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(machine_id) DO UPDATE SET repository=excluded.repository,source_commit=excluded.source_commit,branch=excluded.branch,updated_at=excluded.updated_at',
          binding.child_machine_id,
          checkout.repository,
          checkout.sourceCommit,
          checkout.branch,
          Date.now(),
        );
        return {
          projectId: project.id,
          projectTitle: project.title,
          checkoutKey: checkout.checkoutKey,
          repository: checkout.repository,
          credential: {
            id: binding.child_machine_id,
            token: this.childToken(
              principal,
              project.id,
              binding.child_machine_id,
            ),
            projectId: project.id,
            expiresAt: new Date(account.expires).toISOString(),
          },
        };
      });
      if ('blocked' in result)
        blocked.push({ projectId: project.id, code: result.blocked });
      else assignments.push(result);
    }
    // A removed explicit checkout pauses the assignment and invalidates its derived credential. It is never replaced by a clone or another path.
    const live = new Set(assignments.map((a) => a.projectId));
    for (const binding of await this.store.all(
      "SELECT * FROM studio_account_machine_bindings WHERE account_machine_id=? AND status='active'",
      principal.id,
    )) {
      if (live.has(binding.project_id)) continue;
      await this.store.tx(async () => {
        await this.store.db.lock('project:' + binding.project_id);
        await this.store.db.lock('account-machine:' + principal.id);
        await this.fresh(principal);
        await this.interruptChildren(
          [binding.child_machine_id],
          'The explicit checkout was removed or project authorization became unavailable',
        );
        await this.store.exec(
          "UPDATE studio_account_machine_bindings SET status='paused',updated_at=? WHERE account_machine_id=? AND project_id=? AND status='active'",
          now(),
          principal.id,
          binding.project_id,
        );
        await this.store.exec(
          'UPDATE studio_machines SET expires=0 WHERE id=?',
          binding.child_machine_id,
        );
      });
    }
    await this.heartbeat(principal);
    return {
      assignments,
      blocked,
      ...(this.dependencies.plannerAssignments
        ? { capabilities: ['planner-assignments-v1'] }
        : {}),
    };
  }
  /** An opt-in connector catalogue: no paths, credentials or executable input. */
  async repositories(principal: AccountPrincipal) {
    await this.ready;
    await this.fresh(principal);
    const projects = await this.store.projects(principal.user_id);
    if (projects.length > 100)
      throw new HttpError(
        409,
        'Choose explicit clone URLs when more than 100 projects are attached',
      );
    const repositories = new Set<string>();
    for (const project of projects) {
      if (
        !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(
          project.repository,
        )
      )
        continue;
      try {
        await this.store.role(project.id, principal.user_id, 'write');
      } catch (error) {
        if (![403, 404].includes((error as HttpError).statusCode))
          throw new HttpError(
            503,
            'Attached repository authorization is unavailable; no clone catalogue was returned',
          );
        continue;
      }
      const repository = await this.store.tx(async () => {
        await this.store.db.lock('project:' + project.id);
        await this.store.db.lock('account-machine:' + principal.id);
        await this.fresh(principal);
        try {
          await this.store.role(project.id, principal.user_id, 'write');
        } catch (error) {
          if (![403, 404].includes((error as HttpError).statusCode))
            throw new HttpError(
              503,
              'Attached repository authorization is unavailable; no clone catalogue was returned',
            );
          return null;
        }
        const current = await this.store.one(
          'SELECT repository FROM projects WHERE id=?',
          project.id,
        );
        if (!current || !sameRepo(current.repository, project.repository))
          return null;
        const binding = await this.store.one(
          'SELECT b.status,m.id AS child_id FROM studio_account_machine_bindings b LEFT JOIN studio_machines m ON m.id=b.child_machine_id WHERE b.account_machine_id=? AND b.project_id=?',
          principal.id,
          project.id,
        );
        if (binding && (binding.status === 'revoked' || !binding.child_id))
          return null;
        return current.repository
          .replace(/\.git\/?$/i, '')
          .replace(/\/$/, '')
          .toLowerCase();
      });
      if (repository) repositories.add(repository);
      if (repositories.size > 16)
        throw new HttpError(
          409,
          'Choose explicit clone URLs when more than sixteen repositories are attached',
        );
    }
    // Revocation while authorizing any repository fences the whole response.
    await this.fresh(principal);
    return { repositories: [...repositories].sort() };
  }
  async heartbeat(principal: AccountPrincipal) {
    await this.ready;
    return this.store.tx(async () => {
      await this.store.db.lock('account-machine:' + principal.id);
      await this.fresh(principal);
      await this.store.exec(
        'UPDATE studio_account_machines SET last_seen=? WHERE id=?',
        Date.now(),
        principal.id,
      );
      await this.store.exec(
        "UPDATE studio_machines SET last_seen=? WHERE id IN (SELECT child_machine_id FROM studio_account_machine_bindings WHERE account_machine_id=? AND status='active')",
        Date.now(),
        principal.id,
      );
      return { connected: true };
    });
  }
  private async interruptChildren(children: string[], reason: string) {
    if (!children.length) return;
    const marks = children.map(() => '?').join(',');
    if (await this.table('studio_implementation_machine_queue'))
      for (const queue of await this.store.all(
        `SELECT id,artifact_id,run_id FROM studio_implementation_machine_queue WHERE machine_id IN (${marks}) AND status IN ('queued','launching','running')`,
        ...children,
      )) {
        if (queue.run_id) {
          if (!this.dependencies.graphs)
            throw new Error(
              'Account machine revocation requires the graph lifecycle service',
            );
          await this.dependencies.graphs.interruptInTransaction(
            queue.artifact_id,
            queue.run_id,
            reason,
          );
        }
        await this.store.exec(
          "UPDATE studio_implementation_machine_queue SET status='interrupted',generation=generation+1,lease_hash=NULL,verifier_hash=NULL,error=?,updated_at=? WHERE id=?",
          reason,
          now(),
          queue.id,
        );
      }
    if (await this.table('studio_rebuild_runs'))
      await this.store.exec(
        `UPDATE studio_rebuild_runs SET status='failed',generation=generation+1,lease_hash=NULL,verifier_hash=NULL,error=?,updated_at=? WHERE machine_id IN (${marks}) AND status IN ('queued','running')`,
        reason,
        now(),
        ...children,
      );
    if (await this.table('studio_investigations'))
      await this.store.exec(
        `UPDATE studio_investigations SET status='interrupted',generation=generation+1,lease_hash=NULL,error=?,updated_at=? WHERE machine_id IN (${marks}) AND status='running'`,
        reason,
        now(),
        ...children,
      );
    if (await this.table('studio_machine_work'))
      await this.store.exec(
        `UPDATE studio_machine_work SET status='interrupted',lease_hash=NULL,error=?,updated_at=? WHERE machine_id IN (${marks}) AND status='running'`,
        reason,
        now(),
        ...children,
      );
  }
  private async finishRevocation(accountId: string) {
    const bindings = await this.store.all(
      'SELECT * FROM studio_account_machine_bindings WHERE account_machine_id=? ORDER BY project_id',
      accountId,
    );
    await this.store.tx(async () => {
      for (const binding of bindings)
        await this.store.db.lock('project:' + binding.project_id);
      await this.store.db.lock('account-machine:' + accountId);
      const current = await this.store.one(
        'SELECT status FROM studio_account_machines WHERE id=?',
        accountId,
      );
      if (current?.status !== 'revoking') return;
      const children = (
        await this.store.all(
          'SELECT child_machine_id FROM studio_account_machine_bindings WHERE account_machine_id=?',
          accountId,
        )
      ).map((row) => row.child_machine_id);
      await this.interruptChildren(
        children,
        'The device owner revoked this account machine',
      );
      await this.store.exec(
        "UPDATE studio_account_machine_bindings SET status='revoked',updated_at=? WHERE account_machine_id=?",
        now(),
        accountId,
      );
      for (const child of children)
        await this.store.exec('DELETE FROM studio_machines WHERE id=?', child);
      await this.store.exec(
        "UPDATE studio_account_machines SET status='revoked' WHERE id=? AND status='revoking'",
        accountId,
      );
    });
    for (const binding of bindings)
      try {
        this.dependencies.notify?.(binding.project_id);
      } catch {}
  }
  /** Device authority is fenced before cleanup; a failed/dead process leaves a durable revoking intent for maintenance. */
  async revoke(user: User, accountId: string) {
    await this.ready;
    await this.store.tx(async () => {
      await this.store.db.lock('account-machine:' + accountId);
      const current = await this.store.one(
        'SELECT status FROM studio_account_machines WHERE id=? AND user_id=?',
        accountId,
        user.id,
      );
      if (!current)
        throw new HttpError(404, 'Your active account machine was not found');
      if (current.status === 'revoked') return;
      await this.store.exec(
        "UPDATE studio_account_machines SET status='revoking',expires=0 WHERE id=?",
        accountId,
      );
      await this.store.exec(
        'UPDATE studio_machines SET expires=0 WHERE id IN (SELECT child_machine_id FROM studio_account_machine_bindings WHERE account_machine_id=?)',
        accountId,
      );
    });
    await this.finishRevocation(accountId);
    return { ok: true };
  }
  async cleanupRevoked(limit = 5) {
    await this.ready;
    const rows = await this.store.all(
      "SELECT id FROM studio_account_machines WHERE status='revoking' ORDER BY created_at LIMIT ?",
      Math.max(1, Math.min(20, limit)),
    );
    for (const row of rows) await this.finishRevocation(row.id);
    return { recovered: rows.length };
  }
}
export async function registerAccountMachineRoutes(
  app: FastifyInstance,
  dependencies: AccountMachineDependencies,
) {
  const service = new AccountMachines(dependencies);
  await service.ready;
  const browser = async (request: FastifyRequest) => {
    await dependencies.auth.assertOrigin(request);
    return dependencies.auth.user(request);
  };
  app.get('/api/account-machines', async (request) => ({
    machines: await service.list(await dependencies.auth.user(request)),
    trust: accountMachineTrust,
  }));
  app.post('/api/account-machines/pairing', async (request) =>
    service.pairing(
      await browser(request),
      z
        .object({
          label: z.string().trim().min(1).max(100),
          acceptedTrust: z.literal(true),
        })
        .strict()
        .parse(request.body).label,
    ),
  );
  app.post('/api/account-machines/pair', async (request) =>
    service.pair(
      z
        .object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
        .strict()
        .parse(request.body).code,
    ),
  );
  app.delete<{ Params: { id: string } }>(
    '/api/account-machines/:id',
    async (request) =>
      service.revoke(await browser(request), uuid.parse(request.params.id)),
  );
  app.post<{ Params: { id: string } }>(
    '/api/account-machines/:id/assignments',
    async (request) =>
      service.assignments(
        await service.authenticate(request, request.params.id),
        z
          .object({
            checkouts: z.array(checkoutRegistrationSchema).max(16),
          })
          .strict()
          .parse(request.body).checkouts,
      ),
  );
  app.get<{ Params: { id: string } }>(
    '/api/account-machines/:id/repositories',
    async (request) =>
      service.repositories(
        await service.authenticate(request, request.params.id),
      ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/account-machines/:id/heartbeat',
    async (request) =>
      service.heartbeat(await service.authenticate(request, request.params.id)),
  );
  return service;
}
