import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Auth } from '../auth.ts';
import { HttpError, hash, type Store } from '../store.ts';
import type { User } from '../../shared/domain.ts';
import type { AgentProfiles } from './agent-profiles.ts';
import type { AccountMachines, AccountPrincipal } from './account-machines.ts';
import { readPlanSource } from '../plan-source.ts';
import {
  plannerAssignmentRequestSchema,
  plannerAssignmentSchema,
  plannerClaimRequestSchema,
  plannerClaimSchema,
  plannerIdleMs,
  plannerLeaseMs,
  plannerPollRequestSchema,
  plannerReleaseRequestSchema,
  plannerRenewRequestSchema,
  plannerProfileSchema,
  type PlannerAssignment,
  type PlannerScope,
  type PlannerView,
} from '../../shared/account-planners.ts';
import type { CheckoutRegistration } from '../../shared/account-machines.ts';

type Row = {
  id: string;
  artifact_id: string;
  project_id: string;
  user_id: string;
  device_id: string;
  repository: string;
  checkout_key: string;
  checkout_commit: string;
  artifact_version: number;
  source_hash: string;
  profile_json: string;
  epoch: number;
  status: PlannerAssignment['status'];
  token_hash: string | null;
  expires: number | null;
  idle_expires: number;
  created_at: string;
  updated_at: string;
  reason: string | null;
};
export type AccountPlannerDependencies = {
  store: Store;
  auth: Auth;
  accounts: AccountMachines;
  profiles: Pick<AgentProfiles, 'selected' | 'assertAvailable'>;
  enabled: boolean;
  hasLiveActivity: (
    artifactId: string,
    userId: string,
    scope: { assignmentId: string; epoch: number },
  ) => Promise<boolean>;
  notify?: (projectId: string, artifactId: string) => void;
  now?: () => number;
};
const uuid = z.string().uuid();
const active = (row: Row) =>
  row.status === 'queued' || row.status === 'claimed';
const sameRepo = (a: string, b: string) =>
  a.toLowerCase().replace(/\/$/, '') === b.toLowerCase().replace(/\/$/, '');
const iso = (time: number) => new Date(time).toISOString();

/** Own-account control plane. Its credential is deliberately absent from Auth.user. */
export class AccountPlanners {
  readonly ready: Promise<void>;
  constructor(readonly dependencies: AccountPlannerDependencies) {
    this.ready = this.initialize();
  }
  private get store() {
    return this.dependencies.store;
  }
  private clock() {
    return this.dependencies.now?.() ?? Date.now();
  }
  private async initialize() {
    await this.dependencies.accounts.ready;
    await this.store.tx(async () => {
      await this.store.db.lock('schema:studio.account-planners');
      await this.store.db
        .exec(`CREATE TABLE IF NOT EXISTS studio_account_planner_assignments(
        id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES studio_account_machines(id) ON DELETE CASCADE,
        repository TEXT NOT NULL,checkout_key TEXT NOT NULL,checkout_commit TEXT NOT NULL,
        artifact_version BIGINT NOT NULL,source_hash TEXT NOT NULL,profile_json TEXT NOT NULL,
        epoch BIGINT NOT NULL,status TEXT NOT NULL,token_hash TEXT UNIQUE,expires BIGINT,
        idle_expires BIGINT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,reason TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS studio_account_planner_artifact_active ON studio_account_planner_assignments(artifact_id) WHERE status IN ('queued','claimed');
        CREATE UNIQUE INDEX IF NOT EXISTS studio_account_planner_device_active ON studio_account_planner_assignments(device_id) WHERE status IN ('queued','claimed');`);
      if (this.store.db.dialect === 'postgres')
        await this.store.exec(
          'ALTER TABLE studio_account_planner_assignments ADD COLUMN IF NOT EXISTS checked_at BIGINT NOT NULL DEFAULT 0',
        );
      else if (
        !(
          await this.store.all(
            'PRAGMA table_info(studio_account_planner_assignments)',
          )
        ).some((column) => column.name === 'checked_at')
      )
        await this.store.exec(
          'ALTER TABLE studio_account_planner_assignments ADD COLUMN checked_at BIGINT NOT NULL DEFAULT 0',
        );
    });
  }
  private enabled() {
    if (!this.dependencies.enabled)
      throw new HttpError(
        503,
        'Account Planner assignments are not enabled in this workspace',
      );
  }
  private value(row: Row): PlannerAssignment {
    return plannerAssignmentSchema.parse({
      id: row.id,
      deviceId: row.device_id,
      artifactId: row.artifact_id,
      projectId: row.project_id,
      repository: row.repository,
      checkoutKey: row.checkout_key,
      epoch: Number(row.epoch),
      status: row.status,
      artifactVersion: Number(row.artifact_version),
      sourceHash: row.source_hash,
      profile: JSON.parse(row.profile_json),
      expiresAt: row.expires === null ? null : iso(Number(row.expires)),
      idleExpiresAt:
        Number(row.idle_expires) === 0 ? null : iso(Number(row.idle_expires)),
    });
  }
  private async row(id: string): Promise<Row> {
    const row = await this.store.one(
      'SELECT * FROM studio_account_planner_assignments WHERE id=?',
      uuid.parse(id),
    );
    if (!row) throw new HttpError(404, 'Planner assignment not found');
    return row;
  }
  private async lock(row: Row) {
    await this.store.db.lock('project:' + row.project_id);
    await this.store.db.lock('account-machine:' + row.device_id);
    return this.row(row.id);
  }
  private async fresh(principal: AccountPrincipal) {
    const row = await this.store.one(
      "SELECT * FROM studio_account_machines WHERE id=? AND user_id=? AND token_hash=? AND expires>? AND status='active'",
      principal.id,
      principal.user_id,
      principal.token_hash,
      this.clock(),
    );
    if (!row)
      throw new HttpError(401, 'This account machine was revoked or expired');
    return this.store.publicUser(principal.user_id);
  }
  private async binding(deviceId: string, projectId: string, userId: string) {
    const row = await this.store.one(
      `SELECT b.*,c.source_commit,m.last_seen FROM studio_account_machine_bindings b
      JOIN studio_machines m ON m.id=b.child_machine_id
      JOIN studio_investigation_checkouts c ON c.machine_id=b.child_machine_id
      WHERE b.account_machine_id=? AND b.project_id=? AND b.status='active' AND m.user_id=?`,
      deviceId,
      projectId,
      userId,
    );
    if (!row)
      throw new HttpError(
        409,
        'This device has no currently authorized explicit checkout for this project',
      );
    return row;
  }
  private async fence(row: Row, user: User, includeIdle = true) {
    this.enabled();
    if (row.user_id !== user.id)
      throw new HttpError(
        403,
        'This Planner assignment belongs to another account',
      );
    if (!active(row))
      throw new HttpError(410, `This Planner assignment is ${row.status}`);
    if (row.status === 'claimed' && Number(row.expires) <= this.clock())
      throw new HttpError(
        410,
        'The Planner lease expired; explicitly assign a new Planner',
      );
    if (
      includeIdle &&
      row.status === 'claimed' &&
      Number(row.idle_expires) <= this.clock()
    )
      throw new HttpError(410, 'This Planner assignment became idle');
    const account = await this.store.one(
      "SELECT id FROM studio_account_machines WHERE id=? AND user_id=? AND status='active' AND expires>?",
      row.device_id,
      user.id,
      this.clock(),
    );
    if (!account)
      throw new HttpError(401, 'This account machine was revoked or expired');
    const artifact = await this.store.artifact(
      row.artifact_id,
      user.id,
      'write',
    );
    const project = await this.store.one(
      'SELECT repository FROM projects WHERE id=?',
      row.project_id,
    );
    const binding = await this.binding(row.device_id, row.project_id, user.id);
    if (
      artifact.projectId !== row.project_id ||
      artifact.version !== Number(row.artifact_version) ||
      !project ||
      !sameRepo(project.repository, row.repository) ||
      !sameRepo(binding.repository, row.repository) ||
      binding.checkout_key !== row.checkout_key ||
      binding.source_commit !== row.checkout_commit ||
      hash(JSON.stringify(await readPlanSource(this.store, artifact))) !==
        row.source_hash
    )
      throw new HttpError(
        409,
        'The document, accepted decisions, repository, or explicit checkout changed; assign a new Planner',
      );
    const profile = await this.dependencies.profiles.selected(row.artifact_id);
    if (JSON.stringify(profile) !== row.profile_json)
      throw new HttpError(
        409,
        'The selected Planner profile changed; assign a new Planner',
      );
    this.dependencies.profiles.assertAvailable(profile);
    return artifact;
  }
  private async terminal(row: Row, status: Row['status'], reason: string) {
    await this.store.exec(
      'UPDATE studio_account_planner_assignments SET status=?,token_hash=NULL,expires=NULL,reason=?,updated_at=? WHERE id=? AND epoch=?',
      status,
      reason,
      iso(this.clock()),
      row.id,
      row.epoch,
    );
    row.status = status;
    row.token_hash = null;
    row.expires = null;
    row.reason = reason;
  }
  /** Refresh outside SQL; a temporary identity outage does not prove revocation. */
  private async entitlement(row: Row) {
    try {
      await this.store.artifact(row.artifact_id, row.user_id, 'write');
      return true;
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return [401, 403, 404, 409].includes(error.statusCode);
    }
  }
  private async expiredLease(row: Row) {
    if (
      row.status === 'claimed' &&
      (Number(row.expires) <= this.clock() ||
        Number(row.idle_expires) <= this.clock())
    )
      await this.terminal(row, 'stale', 'The scoped Planner lease expired');
    return row;
  }
  /** Project/device locks are held. Fence failures are retained as terminal state. */
  private async reconcile(row: Row) {
    if (!active(row)) return row;
    try {
      await this.fence(row, await this.store.publicUser(row.user_id));
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      const status =
        row.status === 'claimed' && Number(row.idle_expires) <= this.clock()
          ? 'idle'
          : [401, 403, 404].includes(error.statusCode)
            ? 'revoked'
            : 'stale';
      await this.terminal(row, status, error.message);
    }
    return row;
  }
  private notify(row: Pick<Row, 'project_id' | 'artifact_id'>) {
    try {
      this.dependencies.notify?.(row.project_id, row.artifact_id);
    } catch {}
  }
  /** SQL-only busy hook; never acquire a second project's locks from a claim. */
  async activeOnDevice(deviceId: string) {
    await this.ready;
    if (!this.dependencies.enabled) return false;
    return !!(await this.store.one(
      `SELECT a.id FROM studio_account_planner_assignments a
      JOIN studio_account_machines d ON d.id=a.device_id
      JOIN artifacts t ON t.id=a.artifact_id JOIN projects p ON p.id=a.project_id
      JOIN memberships m ON m.project_id=a.project_id AND m.user_id=a.user_id
      JOIN studio_account_machine_bindings b ON b.account_machine_id=a.device_id AND b.project_id=a.project_id
      JOIN studio_investigation_checkouts c ON c.machine_id=b.child_machine_id
      JOIN studio_agent_profiles f ON f.artifact_id=a.artifact_id
      WHERE a.device_id=? AND a.status IN ('queued','claimed') AND (a.status='queued' OR a.idle_expires>?)
      AND (a.status='queued' OR a.expires>?) AND d.status='active' AND d.expires>?
      AND d.user_id=a.user_id AND t.version=a.artifact_version AND t.archived=0
      AND m.role IN ('owner','editor') AND b.status='active'
      AND b.checkout_key=a.checkout_key AND c.source_commit=a.checkout_commit
      AND lower(p.repository)=lower(a.repository) AND lower(b.repository)=lower(a.repository)
      AND f.harness='remote-planner' AND a.profile_json=? LIMIT 1`,
      deviceId,
      this.clock(),
      this.clock(),
      this.clock(),
      JSON.stringify(await this.profileForDevice(deviceId)),
    ));
  }
  private async profileForDevice(deviceId: string) {
    const row = await this.store.one(
      "SELECT artifact_id FROM studio_account_planner_assignments WHERE device_id=? AND status IN ('queued','claimed') LIMIT 1",
      deviceId,
    );
    return row ? this.dependencies.profiles.selected(row.artifact_id) : null;
  }
  async view(user: User, id: string): Promise<PlannerView> {
    await this.ready;
    const artifact = await this.store.artifact(id, user.id);
    const initial: Row | undefined = await this.store.one(
      "SELECT * FROM studio_account_planner_assignments WHERE artifact_id=? AND status IN ('queued','claimed')",
      id,
    );
    const entitlement = initial ? await this.entitlement(initial) : false;
    return this.store.tx(async () => {
      await this.store.db.lock('project:' + artifact.projectId);
      await this.store.artifact(id, user.id);
      let row: Row | null = await this.store.one(
        "SELECT * FROM studio_account_planner_assignments WHERE artifact_id=? AND status IN ('queued','claimed')",
        id,
      );
      if (row) {
        row = await this.lock(row);
        row =
          initial?.id === row.id && entitlement
            ? await this.reconcile(row)
            : await this.expiredLease(row);
      }
      if (row && !active(row)) row = null;
      let writable = true;
      try {
        await this.store.role(artifact.projectId, user.id, 'write');
      } catch (error) {
        if (
          !(error instanceof HttpError) ||
          ![403, 404].includes(error.statusCode)
        )
          throw error;
        writable = false;
      }
      const project = await this.store.one(
        'SELECT repository FROM projects WHERE id=?',
        artifact.projectId,
      );
      const devices: PlannerView['devices'] = [];
      for (const device of await this.store.all(
        `SELECT d.id,d.label,d.status,d.expires,d.last_seen,b.checkout_key,b.repository,b.child_machine_id,b.status AS binding_status
        FROM studio_account_machines d LEFT JOIN studio_account_machine_bindings b ON b.account_machine_id=d.id AND b.project_id=?
        WHERE d.user_id=? ORDER BY d.created_at DESC LIMIT 100`,
        artifact.projectId,
        user.id,
      )) {
        let status: PlannerView['devices'][number]['status'] = 'available',
          reason: string | null = null;
        if (
          !this.dependencies.enabled ||
          !writable ||
          !project.repository ||
          device.status !== 'active' ||
          device.expires <= this.clock() ||
          device.binding_status !== 'active' ||
          !sameRepo(device.repository ?? '', project.repository)
        ) {
          status = 'unavailable';
          reason = !this.dependencies.enabled
            ? 'Account Planner assignments are not enabled'
            : !writable
              ? 'Write access is required to assign a Planner'
              : 'Register an authorized explicit checkout for this project on this device';
        } else if (device.last_seen < this.clock() - 90_000) {
          status = 'offline';
          reason = 'This device has not polled recently';
        } else if (
          await this.dependencies.accounts.otherWorkActive(
            device.child_machine_id,
          )
        ) {
          status = 'busy';
          reason = 'This device is reserved by another approved workflow';
        }
        devices.push({
          id: device.id,
          label: device.label,
          status,
          reason,
          checkoutKey: device.checkout_key ?? null,
        });
      }
      const own = row?.user_id === user.id ? row : null;
      const latest =
        own ??
        (await this.store.one(
          'SELECT * FROM studio_account_planner_assignments WHERE artifact_id=? AND user_id=? ORDER BY epoch DESC LIMIT 1',
          id,
          user.id,
        ));
      return {
        enabled: this.dependencies.enabled,
        devices,
        assignment: latest ? this.value(latest) : null,
        blockedByOtherWriter: !!row && !own,
      };
    });
  }
  async assign(
    user: User,
    id: string,
    input: z.infer<typeof plannerAssignmentRequestSchema>,
  ) {
    await this.ready;
    this.enabled();
    const artifact = await this.store.artifact(id, user.id, 'write');
    // Release expired reservations in their own project's transaction before
    // acquiring the new project's/device locks. Never lock a second project
    // while holding a device used by ordinary machine claims.
    if (
      !(await this.store.one(
        'SELECT id FROM studio_account_machines WHERE id=? AND user_id=?',
        input.deviceId,
        user.id,
      ))
    )
      throw new HttpError(404, 'Your active account device was not found');
    for (const initial of await this.store.all(
      "SELECT * FROM studio_account_planner_assignments WHERE device_id=? AND status IN ('queued','claimed')",
      input.deviceId,
    )) {
      const entitled = await this.entitlement(initial);
      await this.store.tx(async () =>
        entitled
          ? this.reconcile(await this.lock(initial))
          : this.expiredLease(await this.lock(initial)),
      );
    }
    const prior: Row | undefined = await this.store.one(
      "SELECT * FROM studio_account_planner_assignments WHERE artifact_id=? AND status IN ('queued','claimed')",
      id,
    );
    const priorEntitlement = prior ? await this.entitlement(prior) : false;
    const result = await this.store.tx(async () => {
      await this.store.db.lock('project:' + artifact.projectId);
      await this.store.db.lock('account-machine:' + input.deviceId);
      const current = await this.store.artifact(id, user.id, 'write');
      await this.store.artifactWriteGuard?.(current, user.id);
      if (current.version !== input.artifactVersion)
        throw new HttpError(
          409,
          'The document changed before this Planner assignment',
        );
      const profile = plannerProfileSchema.safeParse(
        await this.dependencies.profiles.selected(id),
      );
      if (!profile.success)
        throw new HttpError(
          409,
          'Select the attached remote Planner harness explicitly before assigning a device',
        );
      this.dependencies.profiles.assertAvailable(profile.data);
      const device = await this.store.one(
        "SELECT * FROM studio_account_machines WHERE id=? AND user_id=? AND status='active' AND expires>?",
        input.deviceId,
        user.id,
        this.clock(),
      );
      if (!device)
        throw new HttpError(404, 'Your active account device was not found');
      if (device.last_seen < this.clock() - 90_000)
        throw new HttpError(
          409,
          'This device is offline; wait for it to poll before assigning work',
        );
      const binding = await this.binding(
        input.deviceId,
        current.projectId,
        user.id,
      );
      const project = await this.store.one(
        'SELECT repository FROM projects WHERE id=?',
        current.projectId,
      );
      if (
        !project.repository ||
        !sameRepo(project.repository, binding.repository)
      )
        throw new HttpError(
          409,
          'The device checkout does not match the attached project repository',
        );
      let previous: Row | null = await this.store.one(
        "SELECT * FROM studio_account_planner_assignments WHERE artifact_id=? AND status IN ('queued','claimed')",
        id,
      );
      if (previous) {
        // The project lock serializes this artifact's assignment replacements.
        previous =
          previous.user_id === user.id ||
          (prior?.id === previous.id && priorEntitlement)
            ? await this.reconcile(previous)
            : await this.expiredLease(previous);
        if (active(previous) && previous.user_id !== user.id)
          throw new HttpError(
            409,
            'Another writer owns the current Planner assignment',
          );
        if (active(previous) && previous.device_id === input.deviceId)
          return previous;
        if (active(previous))
          await this.terminal(
            previous,
            'stopped',
            'The owner explicitly selected another device',
          );
      }
      for (const stale of await this.store.all(
        "SELECT * FROM studio_account_planner_assignments WHERE device_id=? AND status IN ('queued','claimed')",
        input.deviceId,
      )) {
        if (stale.project_id !== current.projectId)
          throw new HttpError(
            409,
            'This device is already reserved by another Planner assignment',
          );
        if (stale.project_id === current.projectId) await this.reconcile(stale);
      }
      if (
        (
          await this.store.one(
            'SELECT count(*) AS n FROM studio_account_planner_assignments WHERE project_id=?',
            current.projectId,
          )
        ).n >= 5000
      )
        throw new HttpError(
          429,
          'This project has reached its 5,000 Planner assignment history limit',
        );
      const epoch =
        Number(
          (
            await this.store.one(
              'SELECT max(epoch) AS n FROM studio_account_planner_assignments WHERE artifact_id=?',
              id,
            )
          ).n ?? 0,
        ) + 1;
      const at = this.clock();
      const row: Row = {
        id: randomUUID(),
        artifact_id: id,
        project_id: current.projectId,
        user_id: user.id,
        device_id: device.id,
        repository: project.repository,
        checkout_key: binding.checkout_key,
        checkout_commit: binding.source_commit,
        artifact_version: current.version,
        source_hash: hash(
          JSON.stringify(await readPlanSource(this.store, current)),
        ),
        profile_json: JSON.stringify(profile.data),
        epoch,
        status: 'queued',
        token_hash: null,
        expires: null,
        idle_expires: 0,
        created_at: iso(at),
        updated_at: iso(at),
        reason: null,
      };
      await this.store.exec(
        'INSERT INTO studio_account_planner_assignments(id,artifact_id,project_id,user_id,device_id,repository,checkout_key,checkout_commit,artifact_version,source_hash,profile_json,epoch,status,token_hash,expires,idle_expires,created_at,updated_at,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ...Object.values(row),
      );
      await this.store.audit(
        row.project_id,
        id,
        user.name,
        'planner.assigned',
        JSON.stringify({
          assignmentId: row.id,
          deviceId: row.device_id,
          epoch,
        }),
      );
      return row;
    });
    this.notify(result);
    return this.value(result);
  }
  async poll(principal: AccountPrincipal, checkouts: CheckoutRegistration[]) {
    await this.ready;
    this.enabled();
    await this.fresh(principal);
    await this.dependencies.accounts.assignments(principal, checkouts);
    const assignments: PlannerAssignment[] = [];
    for (const initial of await this.store.all(
      "SELECT * FROM studio_account_planner_assignments WHERE device_id=? AND user_id=? AND status IN ('queued','claimed') ORDER BY created_at LIMIT 100",
      principal.id,
      principal.user_id,
    )) {
      const value = await this.store.tx(async () => {
        const row = await this.lock(initial);
        await this.fresh(principal);
        const current = await this.reconcile(row);
        if (!active(current)) return null;
        const checkout = checkouts.find(
          (c) =>
            c.checkoutKey === row.checkout_key &&
            sameRepo(c.repository, row.repository) &&
            c.sourceCommit === row.checkout_commit,
        );
        if (!checkout) {
          await this.terminal(
            row,
            'stale',
            'The explicitly registered source checkout changed',
          );
          return null;
        }
        const binding = await this.binding(
          row.device_id,
          row.project_id,
          row.user_id,
        );
        if (
          row.status === 'queued' &&
          (await this.dependencies.accounts.otherWorkActive(
            binding.child_machine_id,
            { excludePlanner: true },
          ))
        )
          return null;
        return this.value(row);
      });
      if (value) assignments.push(value);
    }
    return { assignments };
  }
  private token(principal: AccountPrincipal, row: Row) {
    return createHmac('sha256', principal.token)
      .update('studio-artifact-planner-v1\0' + row.id + '\0' + row.epoch)
      .digest('base64url');
  }
  async claim(principal: AccountPrincipal, id: string, epoch: number) {
    await this.ready;
    this.enabled();
    const initial = await this.row(id);
    if (
      initial.device_id !== principal.id ||
      initial.user_id !== principal.user_id
    )
      throw new HttpError(404, 'Your Planner assignment was not found');
    await this.fresh(principal);
    // Repository identity can refresh outside SQL; the transaction below then
    // rechecks its current entitlement lease and all frozen source fences.
    await this.store.artifact(initial.artifact_id, principal.user_id, 'write');
    const result = await this.store.tx(async () => {
      const row = await this.lock(initial),
        user = await this.fresh(principal);
      if (row.device_id !== principal.id || row.user_id !== principal.user_id)
        throw new HttpError(404, 'Your Planner assignment was not found');
      if (Number(row.epoch) !== epoch)
        throw new HttpError(409, 'The Planner assignment epoch changed');
      await this.fence(row, user);
      const binding = await this.binding(
        row.device_id,
        row.project_id,
        user.id,
      );
      if (
        await this.dependencies.accounts.otherWorkActive(
          binding.child_machine_id,
          { excludePlanner: true },
        )
      )
        throw new HttpError(
          409,
          'This device is already running another approved workflow',
        );
      const token = this.token(principal, row);
      if (row.status === 'queued') {
        row.status = 'claimed';
        row.expires = this.clock() + plannerLeaseMs;
        row.idle_expires = this.clock() + plannerIdleMs;
        row.token_hash = hash(token);
        await this.store.exec(
          "UPDATE studio_account_planner_assignments SET status='claimed',token_hash=?,expires=?,idle_expires=?,updated_at=? WHERE id=? AND epoch=?",
          row.token_hash,
          row.expires,
          row.idle_expires,
          iso(this.clock()),
          id,
          epoch,
        );
      }
      const {
        id: assignmentId,
        status: _status,
        deviceId: _deviceId,
        ...value
      } = this.value(row);
      return plannerClaimSchema.parse({ ...value, assignmentId, token });
    });
    this.notify(initial);
    return result;
  }
  async renew(principal: AccountPrincipal, id: string, epoch: number) {
    await this.ready;
    this.enabled();
    const initial = await this.row(id);
    if (
      initial.device_id !== principal.id ||
      initial.user_id !== principal.user_id
    )
      throw new HttpError(404, 'Your Planner assignment was not found');
    await this.fresh(principal);
    await this.store.artifact(initial.artifact_id, principal.user_id, 'write');
    const result = await this.store.tx(async () => {
      const row = await this.lock(initial),
        user = await this.fresh(principal);
      if (row.device_id !== principal.id || row.user_id !== user.id)
        throw new HttpError(404, 'Your Planner assignment was not found');
      if (Number(row.epoch) !== epoch)
        throw new HttpError(409, 'The Planner assignment epoch changed');
      await this.fence(row, user, false);
      if (row.status !== 'claimed')
        throw new HttpError(
          409,
          'Claim this Planner assignment before renewing it',
        );
      const live = await this.dependencies.hasLiveActivity(
        row.artifact_id,
        row.user_id,
        { assignmentId: row.id, epoch: Number(row.epoch) },
      );
      // The callback may await storage. Recheck current account/source/ACL before extending authority.
      await this.fresh(principal);
      await this.fence(await this.row(id), user, false);
      if (live) row.idle_expires = this.clock() + plannerIdleMs;
      if (Number(row.idle_expires) <= this.clock()) {
        await this.terminal(
          row,
          'idle',
          'No active, waiting, or paused Planner workflow remains',
        );
        return { expiresAt: iso(this.clock()), idle: true };
      }
      row.expires = this.clock() + plannerLeaseMs;
      await this.store.exec(
        'UPDATE studio_account_planner_assignments SET expires=?,idle_expires=?,updated_at=? WHERE id=? AND epoch=?',
        row.expires,
        row.idle_expires,
        iso(this.clock()),
        id,
        epoch,
      );
      return { expiresAt: iso(row.expires), idle: false };
    });
    this.notify(initial);
    return result;
  }
  async release(
    principal: AccountPrincipal,
    id: string,
    epoch: number,
    reason: 'idle' | 'stopped' | 'failed',
  ) {
    await this.ready;
    const initial = await this.row(id);
    await this.store.tx(async () => {
      const row = await this.lock(initial);
      await this.fresh(principal);
      if (row.device_id !== principal.id || row.user_id !== principal.user_id)
        throw new HttpError(404, 'Your Planner assignment was not found');
      if (Number(row.epoch) !== epoch)
        throw new HttpError(409, 'The Planner assignment epoch changed');
      if (active(row))
        await this.terminal(
          row,
          reason,
          'The assigned device released this Planner',
        );
    });
    this.notify(initial);
    return { ok: true as const };
  }
  async stop(user: User, artifactId: string, id: string, epoch: number) {
    await this.ready;
    const initial = await this.row(id);
    if (initial.artifact_id !== artifactId || initial.user_id !== user.id)
      throw new HttpError(404, 'Your Planner assignment was not found');
    await this.store.artifact(artifactId, user.id, 'write');
    await this.store.tx(async () => {
      const row = await this.lock(initial);
      await this.store.artifact(artifactId, user.id, 'write');
      if (row.artifact_id !== artifactId || row.user_id !== user.id)
        throw new HttpError(404, 'Your Planner assignment was not found');
      if (Number(row.epoch) !== epoch)
        throw new HttpError(409, 'The Planner assignment epoch changed');
      if (active(row))
        await this.terminal(
          row,
          'stopped',
          'The document owner stopped this Planner assignment',
        );
    });
    this.notify(initial);
    return { ok: true as const };
  }
  async authenticatePlanner(
    request: FastifyRequest,
  ): Promise<PlannerScope | null> {
    await this.ready;
    const token = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (!token) return null;
    const row: Row | null = await this.store.one(
      'SELECT * FROM studio_account_planner_assignments WHERE token_hash=?',
      hash(token),
    );
    if (!row) return null;
    const scope = {
      user: await this.store.publicUser(row.user_id),
      artifactId: row.artifact_id,
      assignmentId: row.id,
      epoch: Number(row.epoch),
    };
    await this.assertPlanner(scope);
    return scope;
  }
  async assertPlanner(scope: PlannerScope) {
    await this.ready;
    const initial = await this.row(scope.assignmentId);
    if (
      initial.artifact_id !== scope.artifactId ||
      initial.user_id !== scope.user.id ||
      Number(initial.epoch) !== scope.epoch ||
      initial.status !== 'claimed'
    )
      throw new HttpError(
        401,
        'This scoped Planner assignment is no longer current',
      );
    await this.store.artifact(initial.artifact_id, scope.user.id, 'write');
    await this.store.tx(async () => {
      const row = await this.lock(initial);
      if (
        row.artifact_id !== scope.artifactId ||
        row.user_id !== scope.user.id ||
        Number(row.epoch) !== scope.epoch ||
        row.status !== 'claimed'
      )
        throw new HttpError(
          401,
          'This scoped Planner assignment is no longer current',
        );
      await this.fence(row, await this.store.publicUser(scope.user.id));
    });
  }
  async exportState(artifactId: string) {
    await this.ready;
    return (
      await this.store.all(
        'SELECT * FROM studio_account_planner_assignments WHERE artifact_id=? ORDER BY epoch',
        artifactId,
      )
    ).map((row: Row) => ({
      ...this.value(row),
      userId: row.user_id,
      checkoutCommit: row.checkout_commit,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      reason: row.reason,
    }));
  }
  /** Bounded fair maintenance; pending owner requests retain their queue intent. */
  async expire(limit = 5) {
    await this.ready;
    const rows = await this.store.all(
      "SELECT * FROM studio_account_planner_assignments WHERE status IN ('queued','claimed') ORDER BY checked_at,created_at LIMIT ?",
      Math.max(1, Math.min(20, Math.trunc(limit) || 5)),
    );
    let expired = 0;
    for (const initial of rows) {
      const entitled = await this.entitlement(initial);
      const changed = await this.store
        .tx(async () => {
          const row = await this.lock(initial),
            before = row.status;
          if (entitled) await this.reconcile(row);
          else await this.expiredLease(row);
          await this.store.exec(
            'UPDATE studio_account_planner_assignments SET checked_at=? WHERE id=?',
            this.clock(),
            row.id,
          );
          return before !== row.status;
        })
        .catch((error) => {
          if (error instanceof HttpError && error.statusCode === 404)
            return false;
          throw error;
        });
      if (changed) {
        expired++;
        this.notify(initial);
      }
    }
    return { examined: rows.length, expired };
  }
}

export async function registerAccountPlannerRoutes(
  app: FastifyInstance,
  dependencies: AccountPlannerDependencies,
) {
  const service = new AccountPlanners(dependencies);
  await service.ready;
  dependencies.accounts.dependencies.plannerAssignments = dependencies.enabled;
  dependencies.accounts.dependencies.plannerWorkActive = (id) =>
    service.activeOnDevice(id);
  const browser = async (request: FastifyRequest) => {
    await dependencies.auth.assertOrigin(request);
    return dependencies.auth.user(request);
  };
  app.get<{ Params: { id: string } }>(
    '/api/artifacts/:id/planners',
    async (request) =>
      service.view(
        await dependencies.auth.user(request),
        uuid.parse(request.params.id),
      ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/artifacts/:id/planners',
    async (request) =>
      service.assign(
        await browser(request),
        uuid.parse(request.params.id),
        plannerAssignmentRequestSchema.parse(request.body),
      ),
  );
  app.post<{ Params: { id: string; assignmentId: string } }>(
    '/api/artifacts/:id/planners/:assignmentId/stop',
    async (request) =>
      service.stop(
        await browser(request),
        uuid.parse(request.params.id),
        uuid.parse(request.params.assignmentId),
        plannerClaimRequestSchema.parse(request.body).epoch,
      ),
  );
  for (const action of ['poll', 'claim', 'renew', 'release'] as const) {
    if (action === 'poll')
      app.post<{ Params: { id: string } }>(
        '/api/account-machines/:id/planners/poll',
        async (request) =>
          service.poll(
            await dependencies.accounts.authenticate(
              request,
              request.params.id,
            ),
            plannerPollRequestSchema.parse(request.body).checkouts,
          ),
      );
    else
      app.post<{ Params: { id: string; assignmentId: string } }>(
        `/api/account-machines/:id/planners/:assignmentId/${action}`,
        async (request) => {
          const principal = await dependencies.accounts.authenticate(
              request,
              request.params.id,
            ),
            id = uuid.parse(request.params.assignmentId);
          if (action === 'claim')
            return service.claim(
              principal,
              id,
              plannerClaimRequestSchema.parse(request.body).epoch,
            );
          if (action === 'renew')
            return service.renew(
              principal,
              id,
              plannerRenewRequestSchema.parse(request.body).epoch,
            );
          const input = plannerReleaseRequestSchema.parse(request.body);
          return service.release(principal, id, input.epoch, input.reason);
        },
      );
  }
  return service;
}
