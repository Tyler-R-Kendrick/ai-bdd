/** Executed only inside the disposable release-image gate; starts the SHIPPING main.js. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepareGitHubSession } from './studio-github-session-fixture.mjs';

assert.equal(
  process.env.STUDIO_SMOKE_NATIVE_APP,
  '1',
  'Use the explicit disposable native App smoke gate',
);
assert.notEqual(
  process.getuid(),
  0,
  'The shipping model gate must run as the node user',
);
const modelDirectory = process.env.STUDIO_LOCAL_MODEL_DIR;
const toolsDirectory = process.env.STUDIO_T3_MANAGED_TOOLS_DIR;
assert.ok(modelDirectory && isAbsolute(modelDirectory));
assert.ok(toolsDirectory && isAbsolute(toolsDirectory));
const origin = 'https://native-studio.example.test',
  base = 'http://127.0.0.1:8787';
const email = 'native-smoke-owner@example.test';
const data = await mkdtemp(join(tmpdir(), 'studio-native-app-smoke-'));
const childEnv = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  NODE_ENV: 'production',
  STUDIO_HOSTING_PROVIDER: 'node',
  STUDIO_HOST: '127.0.0.1',
  STUDIO_PORT: '8787',
  STUDIO_ORIGIN: origin,
  STUDIO_DATA_DIR: data,
  STUDIO_ADMIN_EMAIL: email,
  STUDIO_GITHUB_SIGNIN_CLIENT_ID: 'native-smoke-fixture-client',
  STUDIO_GITHUB_SIGNIN_CLIENT_SECRET: 'native-smoke-fixture-secret-never-live',
  STUDIO_LOCAL_MODEL_DIR: modelDirectory,
  STUDIO_T3_MANAGED_TOOLS_DIR: toolsDirectory,
  STUDIO_T3_STATE_KEY:
    'synthetic-native-checkpoint-key-for-disposable-release-smoke',
  DO_NOT_TRACK: '1',
  SCARF_NO_ANALYTICS: 'true',
};
// No process.env spread, provider API keys, platform credentials, or pre-existing user homes.
let child,
  cookie = '';
const pauses = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(path, method = 'GET', body, expected = 200) {
  assert.ok(path.startsWith('/api/'));
  const response = await fetch(base + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, expected, `${method} ${path} failed`);
  const header = response.headers.get('set-cookie');
  if (header) {
    cookie = header.split(';')[0];
    assert.match(header, /Secure/i);
    assert.match(header, /HttpOnly/i);
  }
  const text = await response.text();
  assert.ok(text.length <= 2100000, 'Bounded synthetic API response');
  return JSON.parse(text);
}
async function start() {
  // The real OAuth Auth callback issues a session in this disposable SQL store.
  // Only the explicit verification helper selects a controlled identity provider.
  cookie = (await prepareGitHubSession({ dataDirectory: data, email })).cookie;
  child = spawn(
    process.execPath,
    [new URL('./main.js', import.meta.url).pathname],
    { env: childEnv, stdio: ['ignore', 'ignore', 'ignore'] },
  );
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('Shipping main.js exited before health');
    try {
      await api('/api/health');
      return;
    } catch {}
    await pauses(250);
  }
  throw new Error('Shipping main.js did not become healthy');
}
async function stop() {
  const current = child;
  child = undefined;
  if (!current) return;
  if (current.exitCode !== null || current.signalCode !== null) {
    assert.equal(current.exitCode, 0);
    return;
  }
  const exited = once(current, 'exit');
  const ceiling = setTimeout(() => current.kill('SIGKILL'), 15000);
  current.kill('SIGTERM');
  try {
    const [code, signal] = await exited;
    assert.equal(signal, null, 'Shipping main.js must drain on SIGTERM');
    assert.equal(code, 0);
  } finally {
    clearTimeout(ceiling);
  }
}
async function login() {
  await api('/api/auth/login', 'POST', { email, password: 'legacy-password-must-fail' }, 403);
  assert.equal((await api('/api/me')).email, email);
  const challenge = await fetch(base + '/api/auth/github', { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.equal(challenge.status, 302);
  assert.match(challenge.headers.get('location'), /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  assert.match(challenge.headers.get('set-cookie'), /Secure/i);
}
async function turn(artifact, threadId, body) {
  await api(
    `/api/artifacts/${artifact.id}/messages`,
    'POST',
    { threadId, body },
    201,
  );
  const admitted = await api(`/api/artifacts/${artifact.id}/agent`, 'POST', {
    threadId,
    intent: 'chat',
  });
  for (let i = 0; i < 150; i++) {
    const { jobs } = await api(
      `/api/artifacts/${artifact.id}/integrations/jobs`,
    );
    const job = jobs.find((value) => value.id === admitted.id);
    if (job?.status === 'completed') return admitted.id;
    if (job && ['failed', 'cancelled'].includes(job.status)) {
      const category = /fresh service account/.test(job.error ?? '')
        ? 'fresh-service-account-required'
        : /context/.test(job.error ?? '')
          ? 'bounded-context-refusal'
          : 'native-job-failed';
      throw new Error('Managed native T3 job did not complete: ' + category);
    }
    await pauses(500);
  }
  throw new Error('Managed native T3 job exceeded the smoke deadline');
}
async function countFiles(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  )) {
    if (entry.isDirectory())
      count += await countFiles(join(directory, entry.name));
    else if (entry.isFile()) count++;
  }
  return count;
}
function nativeLedger(artifactId) {
  const database = new DatabaseSync(join(data, 'studio.sqlite'), {
    readOnly: true,
    timeout: 5000,
  });
  try {
    return database
      .prepare(
        'SELECT COUNT(*) AS n,MAX(generation) AS generation FROM studio_native_t3_states WHERE artifact_id=? AND checkpoint_key IS NOT NULL AND checkpoint_sha256 IS NOT NULL AND owner IS NULL',
      )
      .get(artifactId);
  } finally {
    database.close();
  }
}
try {
  await start();
  await login();
  const project = await api(
    '/api/projects',
    'POST',
    {
      title: 'Native release model proof',
      description: 'Disposable offline native T3 acceptance',
      repository: '',
    },
    201,
  );
  const artifact = await api(
    `/api/projects/${project.id}/artifacts`,
    'POST',
    { kind: 'document', title: 'Native arithmetic discussion' },
    201,
  );
  const initial = await api(`/api/artifacts/${artifact.id}`);
  const threadId = initial.threads[0].id,
    adrId = initial.decisions[0].id;
  const profile = await api(`/api/artifacts/${artifact.id}/agent/profile`);
  assert.equal(profile.defaultHarness, 't3-code');
  assert.deepEqual(profile.profile, {
    harness: 't3-code',
    provider: 'studioLocal',
    model: 'studio-local/qwen2.5-0.5b-instruct-q4-k-m',
  });
  assert.equal(
    profile.harnesses.find((item) => item.id === 't3-code').configured,
    true,
  );
  const decisionProfile = await api(
    `/api/artifacts/${artifact.id}/decision/profile`,
  );
  assert.equal(decisionProfile.profile.provider, 'llama-cpp-cpu');
  assert.equal(
    decisionProfile.providers.find((item) => item.id === 'llama-cpp-cpu')
      .configured,
    true,
  );
  await turn(artifact, threadId, 'What is 2 + 2? Answer briefly.');
  const completed = await api(`/api/artifacts/${artifact.id}`);
  const reply = completed.messages.filter(
    (message) => message.role === 'assistant',
  );
  assert.equal(reply.length, 1);
  assert.match(reply[0].body, /\b4\b/);
  assert.equal(reply[0].threadId, threadId);
  assert.equal(completed.decisions[0].id, adrId);
  assert.deepEqual(completed.artifact.content, initial.artifact.content);
  await stop();
  const ledger = nativeLedger(artifact.id);
  assert.ok(
    Number(ledger.n) > 0,
    'Real native factory checkpoint ledger must exist and release its lease',
  );
  assert.ok(
    (await countFiles(join(data, 'objects'))) > 0,
    'Encrypted native checkpoint must use the shipping disk object adapter',
  );
  await start();
  await login();
  const restored = await api(`/api/artifacts/${artifact.id}`);
  assert.equal(
    restored.messages.filter((message) => message.role === 'assistant').length,
    1,
  );
  assert.equal(
    restored.messages.find((message) => message.role === 'assistant').body,
    reply[0].body,
  );
  assert.equal(restored.decisions[0].id, adrId);
  assert.equal(restored.threads[0].id, threadId);
  assert.deepEqual(
    (await api(`/api/artifacts/${artifact.id}/agent/profile`)).profile,
    profile.profile,
  );
  await turn(
    artifact,
    threadId,
    'What number did you give in your previous answer? Answer briefly.',
  );
  const resumed = await api(`/api/artifacts/${artifact.id}`),
    answers = resumed.messages.filter(
      (message) => message.role === 'assistant',
    );
  assert.equal(answers.length, 2);
  assert.match(answers[1].body, /\b4\b/);
  await api(`/api/artifacts/${artifact.id}`, 'PATCH', {
    version: resumed.artifact.version,
    content: {
      ...resumed.artifact.content,
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'The homepage must show a blue button labelled Start.',
              },
            ],
          },
        ],
      },
    },
  });
  const savedDesign = await api(`/api/artifacts/${artifact.id}`);
  await turn(
    artifact,
    threadId,
    'What color and label does this document specify for the button?',
  );
  const sourceAware = await api(`/api/artifacts/${artifact.id}`),
    sourceAnswers = sourceAware.messages.filter(
      (message) => message.role === 'assistant',
    );
  assert.equal(sourceAnswers.length, 3);
  assert.match(sourceAnswers[2].body, /\bblue\b/i);
  assert.match(sourceAnswers[2].body, /\bStart\b/);
  assert.equal(sourceAnswers[2].threadId, threadId);
  assert.equal(sourceAware.decisions[0].id, adrId);
  assert.deepEqual(sourceAware.artifact.content, savedDesign.artifact.content);
  await stop();
  assert.ok(Number(nativeLedger(artifact.id).n) > 0);
  console.log(
    JSON.stringify({
      scope: 'shipping-main-http-native-t3-local-cpu-controlled-github-oauth',
      checks: [
        'non-root production main.js with controlled OAuth-issued session',
        'password login refused; shipping GitHub authorization redirect',
        'default genuine native T3/OpenCode with pinned Qwen',
        'real completed HTTP chat and native checkpoint lease release',
        'SQLite and disk object persistence',
        'fresh-process authenticated reply/ADR/thread read',
        'second genuine native turn after restart',
        'third native turn uses saved design source: blue and Start',
        'canonical source, dedicated ADR and thread preserved',
        'graceful SIGTERM',
      ],
      passed: true,
    }),
  );
} finally {
  await stop().catch(() => {});
  await rm(data, { recursive: true, force: true });
}
