import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareGitHubSession } from '../dist/server/studio-github-session-fixture.mjs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const entry = resolve(import.meta.dirname, '../dist/server/vercel-main.js');
await access(entry);
const temporary = await mkdtemp(join(tmpdir(), 'studio-hosting-smoke-'));
const listener = createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise((resolve, reject) =>
  listener.close((error) => (error ? reject(error) : resolve())),
);
const origin = `http://127.0.0.1:${port}`;
const { cookie } = await prepareGitHubSession({ dataDirectory: temporary, email: 'hosting-smoke@example.test' });
let processHandle,
  logs = '';
async function start() {
  logs = '';
  processHandle = spawn(process.execPath, [entry], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'development',
      STUDIO_HOSTING_PROVIDER: 'node',
      STUDIO_ORIGIN: origin,
      STUDIO_PORT: String(port),
      STUDIO_HOST: '127.0.0.1',
      STUDIO_DATA_DIR: temporary,
      STUDIO_ADMIN_EMAIL: 'hosting-smoke@example.test',
      STUDIO_GITHUB_SIGNIN_CLIENT_ID: 'hosting-fixture-client',
      STUDIO_GITHUB_SIGNIN_CLIENT_SECRET: 'hosting-fixture-secret-never-live',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const output of [processHandle.stdout, processHandle.stderr])
    output.on('data', (data) => {
      logs = (logs + data.toString()).slice(-16_384);
    });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null)
      throw new Error('Built hosting entry exited: ' + logs);
    try {
      const response = await fetch(origin + '/api/hosting/readiness', {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return await response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Built hosting entry did not become ready: ' + logs);
}
async function stop() {
  if (!processHandle || processHandle.exitCode !== null) return;
  const child = processHandle;
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    if (code !== 0)
      throw new Error('Hosting entry did not drain cleanly: ' + logs);
  } finally {
    clearTimeout(timer);
    processHandle = undefined;
  }
}
try {
  const first = await start();
  if (first.database !== 'sqlite' || first.provider !== 'node')
    throw new Error('Incorrect local composition');
  const denied = await fetch(origin + '/api/auth/login', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'hosting-smoke@example.test', password: 'legacy-password-must-fail' }),
  });
  if (denied.status !== 403 || denied.headers.get('set-cookie')) throw new Error('Password sign-in must be disabled');
  const me = await fetch(origin + '/api/me', { headers: { cookie } });
  if (!me.ok || (await me.json()).email !== 'hosting-smoke@example.test') throw new Error('Controlled OAuth session was not restored by the actual hosting entry');
  const created = await fetch(origin + '/api/projects', {
    method: 'POST',
    headers: { origin, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Built entry restart',
      description: 'Verified HTTP deployment composition',
    }),
  });
  if (created.status !== 201)
    throw new Error('Built entry could not create a project');
  const project = await created.json();
  await stop();
  const second = await start();
  const projects = await fetch(origin + '/api/projects', {
    headers: { cookie },
  });
  if (
    !projects.ok ||
    !(await projects.json()).some((value) => value.id === project.id)
  )
    throw new Error('Built entry failed SQL/session restart persistence');
  await stop();
  console.log(
    JSON.stringify({
      status: 'passed',
      entry: 'dist/server/vercel-main.js',
      provider: second.provider,
      database: second.database,
      authenticatedProjectPersistence: true,
      identityEvidence: 'controlled-GitHub-OAuth-provider',
      passwordLoginRefused: true,
      cleanSigterm: true,
      cloudServices: 'not-provisioned-or-verified',
    }),
  );
} finally {
  await stop();
  await rm(temporary, { recursive: true, force: true });
}
