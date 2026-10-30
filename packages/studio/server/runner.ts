import {
  mkdir,
  writeFile,
  readFile,
  realpath,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createEngine,
  createPlanStore,
  loadConfig,
  type Engine,
} from '@ai-bdd/sdk';
import { docText, type User, type Artifact } from '../shared/domain.ts';
import { HttpError, type Store, hash } from './store.ts';
import type { Settings } from './auth.ts';
import type { Collaboration } from './collaboration.ts';
import type {
  DurableJobContext,
  DurableJobRuntime,
} from './runtime/contracts.ts';
import type { HostingServices, WorkspaceReference } from './hosting/ports.ts';

type Snapshot = {
  runId: string;
  source: string;
  workspace: WorkspaceReference | null;
  workspaceRevision: number;
  actor: string;
};
/** Operator code is executable; document/chat text is always data. All worker inputs are immutable durable references. */
export class Runner {
  readonly active = new Map<string, AbortController>();
  readonly engines = new Map<string, Engine>();
  constructor(
    readonly store: Store,
    readonly settings: Settings,
    readonly collab: Collaboration,
    readonly options: { runtime: DurableJobRuntime; hosting: HostingServices },
  ) {}
  async initialize() {
    await this.store.tx(async () => {
      await this.store.lock('schema:studio.runner');
      await this.store.db.exec(
        `CREATE TABLE IF NOT EXISTS studio_runner_workspaces(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,artifact_version INTEGER NOT NULL,reference_json TEXT,revision INTEGER NOT NULL DEFAULT 0,task_token TEXT,task_expires BIGINT);`,
      );
    });
    this.options.runtime.register('runner.run', (context) =>
      this.execute(context),
    );
  }
  private configured() {
    if (!this.settings.runnerConfig)
      throw new HttpError(
        503,
        'The workspace owner has not configured a trusted ai-bdd runner',
      );
  }
  private async directory(prefix: string) {
    const base = resolve(this.settings.dataDir, 'runner-staging');
    await mkdir(base, { recursive: true, mode: 0o700 });
    return mkdtemp(join(base, prefix + '-'));
  }
  private async engineAt(root: string, source: string) {
    this.configured();
    await mkdir(resolve(root, 'docs'), { recursive: true, mode: 0o700 });
    await writeFile(resolve(root, 'docs/design.md'), source, { mode: 0o600 });
    const trusted = await loadConfig({
      cwd: resolve(this.settings.runnerConfig!, '..'),
      configPath: resolve(this.settings.runnerConfig!),
    });
    return createEngine({
      ...trusted,
      projectRoot: root,
      docs: ['docs/design.md'],
      planDir: resolve(root, 'plans'),
      recordingsDir: resolve(root, 'recordings'),
      runsDir: resolve(root, 'runs'),
      cacheDir: resolve(root, 'cache'),
    });
  }
  private async workspace(id: string) {
    return this.store.one(
      'SELECT * FROM studio_runner_workspaces WHERE artifact_id=?',
      id,
    );
  }
  private async busy(id: string) {
    return !!(await this.store.one(
      "SELECT j.id FROM studio_runner_jobs r JOIN runs r0 ON r0.id=r.run_id JOIN studio_durable_jobs j ON j.id=r.job_id WHERE r0.artifact_id=? AND j.status IN ('queued','running') LIMIT 1",
      id,
    ));
  }
  private async begin(user: User, id: string) {
    this.configured();
    const initial = await this.store.artifact(id, user.id, 'write'),
      token = randomUUID();
    if (!['design', 'document'].includes(initial.kind))
      throw new HttpError(400, 'Run acceptance tests from a document artifact');
    return this.store.tx(async () => {
      await this.store.lock('project:' + initial.projectId);
      const artifact = await this.store.artifact(id, user.id, 'write'),
        old = await this.workspace(id);
      if (
        (await this.busy(id)) ||
        (old?.task_token && Number(old.task_expires) > Date.now())
      )
        throw new HttpError(409, 'A test task is already running');
      await this.store.exec(
        'INSERT INTO studio_runner_workspaces(artifact_id,artifact_version,task_token,task_expires) VALUES(?,?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET task_token=excluded.task_token,task_expires=excluded.task_expires',
        id,
        artifact.version,
        token,
        Date.now() + 180000,
      );
      return { artifact, token, old };
    });
  }
  private async mutate(
    user: User,
    id: string,
    operation: (engine: Engine, signal: AbortSignal) => Promise<any>,
  ) {
    const { artifact, token, old } = await this.begin(user, id),
      root = await this.directory(id),
      controller = new AbortController();
    this.active.set(id, controller);
    const timer = setTimeout(() => controller.abort(), 120000);
    let engine: Engine | undefined;
    try {
      if (old?.reference_json)
        await this.options.hosting.workspaces.restore(
          JSON.parse(old.reference_json),
          root,
        );
      engine = await this.engineAt(root, docText(artifact.content.doc));
      this.engines.set(id, engine);
      const result = await operation(engine, controller.signal);
      const reference = await this.options.hosting.workspaces.save(id, root);
      await this.store.tx(async () => {
        await this.store.lock('project:' + artifact.projectId);
        const current = await this.store.artifact(id, user.id, 'write');
        if (current.version !== artifact.version || controller.signal.aborted)
          throw new HttpError(
            409,
            'The source changed while the test workspace was prepared',
          );
        const updated = await this.store.exec(
          'UPDATE studio_runner_workspaces SET reference_json=?,artifact_version=?,revision=revision+1,task_token=NULL,task_expires=NULL WHERE artifact_id=? AND task_token=?',
          JSON.stringify(reference),
          artifact.version,
          id,
          token,
        );
        if (updated.changes !== 1)
          throw new HttpError(409, 'The workspace task lease changed');
        await this.store.audit(
          artifact.projectId,
          id,
          user.name,
          'tests.workspace.updated',
        );
      });
      return result;
    } finally {
      clearTimeout(timer);
      this.active.delete(id);
      this.engines.delete(id);
      await engine?.close();
      await rm(root, { recursive: true, force: true });
      await this.store.exec(
        'UPDATE studio_runner_workspaces SET task_token=NULL,task_expires=NULL WHERE artifact_id=? AND task_token=?',
        id,
        token,
      );
    }
  }
  async compile(user: User, id: string) {
    return this.mutate(user, id, async (engine, signal) => ({
      result: await engine.compile({ signal }),
      plans: await engine.plans(),
    }));
  }
  async plans(user: User, id: string) {
    await this.store.artifact(id, user.id);
    const row = await this.workspace(id);
    if (!row?.reference_json) return [];
    const root = await this.directory(id);
    try {
      await this.options.hosting.workspaces.restore(
        JSON.parse(row.reference_json),
        root,
      );
      await this.store.artifact(id, user.id);
      return await createPlanStore({
        dir: resolve(root, 'plans'),
        readOnly: true,
      }).loadAll();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  async review(
    user: User,
    id: string,
    target: string,
    action: 'accept' | 'reject' | 'pin' | 'unpin',
  ) {
    return this.mutate(user, id, async (engine) => {
      await engine.review(target, action);
      return { ok: true };
    });
  }
  async run(user: User, id: string) {
    this.configured();
    const initial = await this.store.artifact(id, user.id, 'write');
    if (!['design', 'document'].includes(initial.kind))
      throw new HttpError(400, 'Run acceptance tests from a document artifact');
    const runId = randomUUID();
    await this.store.tx(async () => {
      await this.store.lock('admission:runner.run');
      await this.store.lock('project:' + initial.projectId);
      const artifact = await this.store.artifact(id, user.id, 'write'),
        workspace = await this.workspace(id);
      if (
        (await this.busy(id)) ||
        (workspace?.task_token && Number(workspace.task_expires) > Date.now())
      )
        throw new HttpError(409, 'A test task is already running');
      const count = await this.store.one(
        "SELECT count(*) AS n FROM studio_durable_jobs WHERE kind='runner.run' AND status IN ('queued','running')",
      );
      if (Number(count.n) >= 4)
        throw new HttpError(
          429,
          'The workspace is at its four-run execution limit',
        );
      const snapshot: Snapshot = {
        runId,
        source: docText(artifact.content.doc),
        workspace: workspace?.reference_json
          ? JSON.parse(workspace.reference_json)
          : null,
        workspaceRevision: Number(workspace?.revision ?? 0),
        actor: user.name,
      };
      const job = await this.options.runtime.enqueue({
        kind: 'runner.run',
        projectId: artifact.projectId,
        artifactId: id,
        principalId: user.id,
        artifactVersion: artifact.version,
        snapshot,
        idempotencyKey: 'runner:' + runId,
        maxAttempts: 3,
      });
      await this.store.exec(
        'INSERT INTO runs(id,artifact_id,artifact_version,status,created_at) VALUES(?,?,?,?,?)',
        runId,
        id,
        artifact.version,
        'queued',
        new Date().toISOString(),
      );
      await this.store.exec(
        'INSERT INTO studio_runner_jobs(run_id,job_id) VALUES(?,?)',
        runId,
        job.id,
      );
    });
    await this.collab.notify(initial.projectId, id);
    await this.options.runtime.flushOutbox();
    return { id: runId };
  }
  private async execute(context: DurableJobContext) {
    const snapshot = context.snapshot as Snapshot,
      job = context.job;
    await context.assertCurrent({ requireCurrentVersion: true });
    const receipt = await context.step('execute-and-capture', async () => {
      const root = await this.directory(job.id);
      let engine: Engine | undefined;
      try {
        if (snapshot.workspace)
          await this.options.hosting.workspaces.restore(
            snapshot.workspace,
            root,
          );
        await context.assertCurrent({ requireCurrentVersion: true });
        engine = await this.engineAt(root, snapshot.source);
        await context.progress({
          percent: 10,
          label: 'Executing reviewed acceptance plans',
        });
        const result = await engine.run({
          signal: context.signal,
          frozen: true,
          compile: false,
          strict: true,
        });
        const verification = await engine.verifyRun(
          resolve(engine.config.runsDir, result.runId),
        );
        await context.assertCurrent({ requireCurrentVersion: true });
        const evidenceWorkspace = await this.options.hosting.workspaces.save(
          job.id,
          resolve(engine.config.runsDir, result.runId),
        );
        await rm(resolve(root, 'runs'), { recursive: true, force: true });
        const workspace = await this.options.hosting.workspaces.save(
          job.artifactId,
          root,
        );
        const passed =
          result.exitCode === 0 &&
          verification.ok &&
          result.scenarios.length > 0 &&
          result.scenarios.every(
            (s) => s.status === 'passed' || s.status === 'healed',
          );
        return {
          status: passed ? 'passed' : 'failed',
          result: { ...result, integrity: verification, evidenceWorkspace },
          workspace,
          error:
            result.scenarios.length === 0
              ? 'No acceptance scenarios were executed'
              : result.scenarios.every((s) => s.status === 'skipped')
                ? 'All acceptance scenarios were skipped'
                : null,
        };
      } finally {
        await engine?.close();
        await rm(root, { recursive: true, force: true });
      }
    });
    const publication = await context.commit(
      'publish-run-and-evidence',
      async () => {
        await this.store.exec(
          'UPDATE runs SET status=?,result=?,error=?,finished_at=? WHERE id=? AND artifact_id=?',
          receipt.status,
          JSON.stringify(receipt.result),
          receipt.error,
          new Date().toISOString(),
          snapshot.runId,
          job.artifactId,
        );
        await this.store.exec(
          'UPDATE studio_runner_workspaces SET reference_json=?,artifact_version=?,revision=revision+1 WHERE artifact_id=? AND revision=? AND task_token IS NULL',
          JSON.stringify(receipt.workspace),
          job.artifactVersion,
          job.artifactId,
          snapshot.workspaceRevision,
        );
        await this.store.audit(
          job.projectId,
          job.artifactId,
          snapshot.actor,
          'tests.completed',
          `run ${snapshot.runId}, exit ${receipt.result.exitCode}`,
        );
        return { id: snapshot.runId, status: receipt.status };
      },
      { requireCurrentVersion: true },
    );
    await this.collab.notify(job.projectId, job.artifactId);
    return publication;
  }
  async cancel(user: User, id: string) {
    const artifact = await this.store.artifact(id, user.id, 'write');
    const jobs = await this.store.all(
      "SELECT j.id FROM studio_runner_jobs r JOIN runs r0 ON r0.id=r.run_id JOIN studio_durable_jobs j ON j.id=r.job_id WHERE r0.artifact_id=? AND j.status IN ('queued','running')",
      id,
    );
    for (const job of jobs) await this.options.runtime.cancel(job.id, user);
    this.active.get(id)?.abort();
    await this.collab.notify(artifact.projectId, id);
  }
  async isActive(id: string) {
    return this.active.has(id) || (await this.busy(id));
  }
  async evidence(user: User, id: string, runId: string, evidenceId: string) {
    await this.store.artifact(id, user.id);
    const run = await this.store.run(runId, id);
    const refs =
      run?.result?.scenarios?.flatMap((scenario: any) =>
        scenario.steps.flatMap((step: any) => step.evidence),
      ) ?? [];
    const ref = refs.find(
      (entry: any) => entry.id === evidenceId || entry.path === evidenceId,
    );
    if (!ref) throw new HttpError(404, 'Evidence not found');
    let directory: string | undefined;
    try {
      if (run!.result.evidenceWorkspace) {
        directory = await this.directory(runId);
        await this.options.hosting.workspaces.restore(
          run!.result.evidenceWorkspace,
          directory,
        );
      }
      const root = await realpath(
        directory ??
          resolve(
            this.settings.dataDir,
            'workspaces',
            id,
            'runs',
            run!.result.runId,
          ),
      );
      const target = await realpath(resolve(root, ref.path)),
        rel = relative(root, target);
      if (rel.startsWith('..') || isAbsolute(rel))
        throw new HttpError(403, 'Evidence path is outside the run');
      const bytes = await readFile(target);
      if (hash(bytes) !== ref.sha256)
        throw new HttpError(409, 'Evidence integrity check failed');
      await this.store.artifact(id, user.id);
      return {
        bytes,
        mime:
          ref.kind === 'screenshot'
            ? 'image/png'
            : ref.path.endsWith('.json')
              ? 'application/json'
              : /\.(txt|md)$/.test(ref.path)
                ? 'text/plain; charset=utf-8'
                : 'application/octet-stream',
      };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  async close() {
    for (const controller of this.active.values()) controller.abort();
  }
}
