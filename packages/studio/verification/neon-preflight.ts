/** Live, opt-in Neon application/restore smoke. Database credentials arrive only over stdin/private IPC. */
import { createInterface } from 'node:readline';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { readPlanSource } from '../server/plan-source.ts';
import { paragraph } from '../shared/domain.ts';
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeError = (error: unknown) => ({
  name: error instanceof Error ? error.name : 'Error',
  code:
    typeof (error as any)?.code === 'string'
      ? (error as any).code
      : 'unspecified',
});
const emit = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + '\n');
type Config = {
  url: string;
  schema: string;
  expectedHost: string;
  port: number;
  dataDir: string;
  password: string;
};
function validate(config: Config) {
  const uri = new URL(config.url);
  if (
    !['postgres:', 'postgresql:'].includes(uri.protocol) ||
    uri.hostname !== config.expectedHost ||
    !uri.hostname.endsWith('.neon.tech') ||
    !/^release_smoke_[a-z0-9_]{1,40}$/.test(config.schema)
  )
    throw new Error('Invalid isolated preflight scope');
}
if (process.argv.includes('--server')) {
  let studio: Awaited<ReturnType<typeof createApp>> | undefined;
  process.on('message', async (message: any) => {
    if (message?.action === 'start')
      try {
        const config = message.config as Config;
        validate(config);
        const database = await openDatabase({
          adapter: 'postgres',
          url: config.url,
          schema: config.schema,
          max: 2,
        });
        studio = await createApp(
          {
            origin: `http://127.0.0.1:${config.port}`,
            production: false,
            demo: false,
            dataDir: config.dataDir,
            adminEmail: 'neon-release-smoke@example.test',
            adminPassword: config.password,
            integrations: {},
          },
          { database, logger: false },
        );
        if (
          studio.agent.profiles
            .catalog()
            .some((provider) => provider.configured)
        )
          throw new Error('Live inference is forbidden in this preflight');
        await studio.app.listen({ host: '127.0.0.1', port: config.port });
        const metadata = await studio.store.one(
          "SELECT current_schema() AS schema,current_setting('server_version_num') AS version",
        );
        process.send?.({
          kind: 'ready',
          pid: process.pid,
          metadata,
          providersConfigured: 0,
        });
      } catch (error) {
        process.send?.({ kind: 'error', ...safeError(error) });
        await studio?.app.close().catch(() => {});
        process.exit(1);
      }
    else if (message?.action === 'checkpoint')
      try {
        if (!studio) throw new Error('Application not running');
        const row = await studio.store.one(
          'SELECT pg_current_wal_lsn() AS lsn,clock_timestamp()::text AS timestamp',
        );
        process.send?.({ kind: 'checkpoint', ...row });
      } catch (error) {
        process.send?.({ kind: 'error', ...safeError(error) });
      }
    else if (message?.action === 'marker')
      try {
        if (!studio) throw new Error('Application not running');
        await studio.store.db.exec(
          'CREATE TABLE IF NOT EXISTS release_probe_marker(id TEXT PRIMARY KEY,payload TEXT NOT NULL)',
        );
        await studio.store.exec(
          'INSERT INTO release_probe_marker(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
          'source',
          message.payload,
        );
        process.send?.({ kind: 'marker-written' });
      } catch (error) {
        process.send?.({ kind: 'error', ...safeError(error) });
      }
    else if (message?.action === 'inspect')
      try {
        if (!studio) throw new Error('Application not running');
        const user = await studio.store.userByEmail(
            'neon-release-smoke@example.test',
          ),
          artifact = await studio.store.artifact(message.artifactId, user.id);
        const canonical = await studio.store.tx(async () => {
          await studio!.store.lock('project:' + artifact.projectId);
          return readPlanSource(studio!.store, artifact);
        });
        const marker = await studio.store.one(
          'SELECT payload FROM release_probe_marker WHERE id=?',
          'source',
        );
        process.send?.({
          kind: 'inspection',
          canonicalSha256: digest(canonical),
          sourceSha256: digest(artifact.content),
          sourceVersion: artifact.version,
          marker: marker?.payload ?? null,
        });
      } catch (error) {
        process.send?.({ kind: 'error', ...safeError(error) });
      }
    else if (message?.action === 'close') {
      try {
        await studio?.app.close();
        process.send?.({ kind: 'closed' });
        process.disconnect();
        process.exitCode = 0;
      } catch (error) {
        process.send?.({ kind: 'error', ...safeError(error) });
        process.exit(1);
      }
    }
  });
} else {
  const rl = createInterface({ input: process.stdin, terminal: false }),
    lines = rl[Symbol.asyncIterator]();
  let child: ChildProcess | undefined,
    temporary = '',
    phase = 'input';
  const children: number[] = [];
  const deadline = setTimeout(() => {
    emit({ stage: 'failed', phase, error: { code: 'PREFLIGHT_DEADLINE' } });
    child?.kill('SIGKILL');
    process.exitCode = 1;
    rl.close();
    process.stdin.pause();
  }, 15 * 60000);
  deadline.unref();
  const receive = async () => {
    const next = await lines.next();
    if (next.done) throw new Error('Preflight control channel ended');
    return JSON.parse(next.value);
  };
  async function requestChild(
    message: Record<string, any>,
    kind: string,
    timeout = 180000,
  ) {
    if (!child) throw new Error('No application child');
    const current = child;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Application child timed out'));
      }, timeout);
      const onMessage = (reply: any) => {
        if (reply?.kind === 'error') {
          cleanup();
          reject(
            Object.assign(
              new Error('Application child rejected preflight step'),
              reply,
            ),
          );
        } else if (reply?.kind === kind) {
          cleanup();
          resolve(reply);
        }
      };
      const onExit = () => {
        cleanup();
        reject(new Error('Application child exited'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        current.off('message', onMessage);
        current.off('exit', onExit);
      };
      current.on('message', onMessage);
      current.on('exit', onExit);
      current.send(message);
    });
  }
  async function start(config: Config) {
    validate(config);
    child = fork(fileURLToPath(import.meta.url), ['--server'], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    });
    const reply = await requestChild({ action: 'start', config }, 'ready');
    children.push(reply.pid);
    return reply;
  }
  async function stop() {
    if (!child) return;
    const current = child;
    await requestChild({ action: 'close' }, 'closed', 30000);
    if (current.exitCode === null)
      await Promise.race([
        once(current, 'exit'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Application did not exit')), 5000),
        ),
      ]);
    child = undefined;
  }
  async function main() {
    emit({ stage: 'ready-for-database-input' });
    const input = await receive();
    temporary = await mkdtemp(join(tmpdir(), 'studio-neon-live-'));
    const config: Config = {
      url: input.url,
      expectedHost: input.expectedHost,
      schema: input.schema,
      port: 8901,
      dataDir: temporary,
      password: randomBytes(24).toString('base64url'),
    };
    validate(config);
    const origin = `http://127.0.0.1:${config.port}`;
    let cookie = '';
    const http = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(origin + path, {
        method,
        headers: {
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok)
        throw Object.assign(new Error('Application HTTP operation rejected'), {
          code: 'HTTP_' + response.status,
        });
      if (path === '/api/auth/login')
        cookie = response.headers.get('set-cookie')!.split(';')[0]!;
      return response.json() as Promise<any>;
    };
    phase = 'migrate-and-http-create';
    emit({ stage: 'starting', phase });
    const first = await start(config);
    await http('/api/auth/login', 'POST', {
      email: 'neon-release-smoke@example.test',
      password: config.password,
    });
    const project = await http('/api/projects', 'POST', {
        title: 'Neon isolated release restore smoke',
        description: 'Synthetic preflight data only',
        repository: '',
      }),
      id = project.mainArtifactId;
    let full = await http('/api/artifacts/' + id);
    const marker = 'before-neon-checkpoint-20261030';
    await http('/api/artifacts/' + id, 'PATCH', {
      version: full.artifact.version,
      content: { doc: { type: 'doc', content: [paragraph(marker)] } },
    });
    full = await http('/api/artifacts/' + id);
    const thread =
      full.threads.find((item: any) => item.anchor === null) ?? full.threads[0];
    await http('/api/artifacts/' + id + '/messages', 'POST', {
      threadId: thread.id,
      body: 'Synthetic retained artifact-bound chat before provider snapshot.',
    });
    const adr = full.decisions[0];
    await http(`/api/artifacts/${id}/decisions/${adr.id}`, 'PUT', {
      title: 'Synthetic accepted boundary',
      context: 'Neon restore preflight',
      decision: 'Use the exact before-checkpoint source.',
      consequences: 'Retain source, accepted ADR and discussion.',
      status: 'accepted',
      version: adr.version,
    });
    await requestChild({ action: 'marker', payload: marker }, 'marker-written');
    const original = await requestChild(
      { action: 'inspect', artifactId: id },
      'inspection',
    );
    phase = 'real-process-restart';
    await stop();
    const second = await start(config);
    if (first.pid === second.pid)
      throw new Error('Application process did not restart');
    const verify = async (
      expected: any,
      expectedMarker: string,
      excludeAfter = false,
    ) => {
      const [projects, artifact, messages] = await Promise.all([
        http('/api/projects'),
        http('/api/artifacts/' + id),
        http(`/api/artifacts/${id}/messages?threadId=${thread.id}`),
      ]);
      if (
        !projects.some((item: any) => item.id === project.id) ||
        !messages.messages.some((item: any) =>
          item.body.includes('before provider snapshot'),
        ) ||
        !artifact.decisions.some(
          (item: any) =>
            item.id === adr.id &&
            item.status === 'accepted' &&
            item.decision === 'Use the exact before-checkpoint source.',
        )
      )
        throw new Error('Persisted application state differs');
      if (
        excludeAfter &&
        messages.messages.some((item: any) =>
          item.body.includes('after provider snapshot'),
        )
      )
        throw new Error('Restored branch retained post-snapshot history');
      const state = await requestChild(
        { action: 'inspect', artifactId: id },
        'inspection',
      );
      if (
        state.sourceSha256 !== expected.sourceSha256 ||
        state.canonicalSha256 !== expected.canonicalSha256 ||
        state.sourceVersion !== expected.sourceVersion ||
        state.marker !== expectedMarker
      )
        throw new Error('Database source/ADR/marker digest differs');
      return state;
    };
    await verify(original, marker);
    const checkpoint = await requestChild(
      { action: 'checkpoint' },
      'checkpoint',
    );
    await stop();
    emit({
      stage: 'snapshot-ready',
      schema: config.schema,
      projectId: project.id,
      artifactId: id,
      sourceVersion: original.sourceVersion,
      sourceSha256: original.sourceSha256,
      canonicalSha256: original.canonicalSha256,
      lsn: checkpoint.lsn,
      timestamp: checkpoint.timestamp,
      postgresVersion: first.metadata.version,
      processIds: children,
      boundedHttpConcurrency: 3,
      postgresPoolMax: 2,
      checks: [
        'actual-App-migrations',
        'authenticated-HTTP-writes',
        'accepted-ADR-source',
        'artifact-chat',
        'real-process-restart',
        'persisted-session',
        'three-concurrent-reads',
      ],
    });
    const resume = await receive();
    if (resume.action !== 'reconnect')
      throw new Error('Expected reconnect control');
    phase = 'compute-suspend-reconnect';
    const third = await start(config);
    await verify(original, marker);
    emit({ stage: 'reconnect-verified', pid: third.pid });
    phase = 'mutate-after-snapshot';
    full = await http('/api/artifacts/' + id);
    await http('/api/artifacts/' + id, 'PATCH', {
      version: full.artifact.version,
      content: {
        doc: {
          type: 'doc',
          content: [paragraph('after-neon-checkpoint-20261030')],
        },
      },
    });
    await http('/api/artifacts/' + id + '/messages', 'POST', {
      threadId: thread.id,
      body: 'Synthetic extra chat after provider snapshot.',
    });
    await requestChild(
      { action: 'marker', payload: 'after-neon-checkpoint-20261030' },
      'marker-written',
    );
    const mutated = await requestChild(
      { action: 'inspect', artifactId: id },
      'inspection',
    );
    if (mutated.sourceSha256 === original.sourceSha256)
      throw new Error('Post-snapshot mutation was not durable');
    await stop();
    emit({
      stage: 'mutated',
      sourceVersion: mutated.sourceVersion,
      sourceSha256: mutated.sourceSha256,
    });
    const restored = await receive();
    if (restored.action !== 'verify-restored')
      throw new Error('Expected restored branch control');
    phase = 'restored-branch-http';
    const restoredConfig = {
      ...config,
      url: restored.url,
      expectedHost: restored.expectedHost,
    };
    const fourth = await start(restoredConfig);
    await verify(original, marker, true);
    await stop();
    emit({
      stage: 'restored-verified',
      sourceVersion: original.sourceVersion,
      sourceSha256: original.sourceSha256,
      canonicalSha256: original.canonicalSha256,
      restoredProcessId: fourth.pid,
      processIds: children,
      boundedHttpConcurrency: 3,
      postgresPoolMax: 2,
      scope:
        'database application state; excludes object storage, live identity/providers, load/SLO and production deployment',
    });
  }
  await main()
    .catch((error) => {
      emit({ stage: 'failed', phase, error: safeError(error) });
      process.exitCode = 1;
    })
    .finally(async () => {
      clearTimeout(deadline);
      child?.kill('SIGTERM');
      if (temporary) await rm(temporary, { recursive: true, force: true });
      rl.close();
      process.stdin.pause();
    });
}
