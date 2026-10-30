// Runs against a real local release image, then removes only the resources it created.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const image = process.env.STUDIO_SMOKE_IMAGE ?? 'ai-bdd-studio:review';
const port = Number(process.env.STUDIO_SMOKE_PORT ?? '8898');
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid smoke-test port');
const identifier = 'studio-smoke-' + randomUUID();
const origin = 'https://studio.example.test';
const env = { ...process.env };
for (const name of [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
])
  delete env[name];
const docker = async (args, timeout = 60000) =>
  execute('docker', ['--host=unix:///var/run/docker.sock', ...args], {
    env,
    timeout,
    maxBuffer: 1024 * 1024,
  });
const results = [];
const pass = (label) => results.push(label);
if (process.env.STUDIO_SMOKE_REPORT) {
  await rm(process.env.STUDIO_SMOKE_REPORT, { force: true });
  await rm(process.env.STUDIO_SMOKE_REPORT + '.log', { force: true });
}
const imageId = (
  await docker(['image', 'inspect', '--format', '{{.Id}}', image])
).stdout.trim();
let cookie = '';
async function api(path, method = 'GET', body, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(
    response.status,
    expected,
    `${method} ${path} returned ${response.status}`,
  );
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    cookie = setCookie.split(';')[0];
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
  }
  return response.json();
}
async function ready() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await api('/health');
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Container did not become ready');
}

try {
  await docker(['volume', 'create', identifier]);
  await docker([
    'run',
    '-d',
    '--name',
    identifier,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--shm-size=256m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '-p',
    `127.0.0.1:${port}:8787`,
    '-v',
    `${identifier}:/data`,
    '-e',
    `STUDIO_ORIGIN=${origin}`,
    '-e',
    'STUDIO_ADMIN_EMAIL=owner@example.test',
    '-e',
    'STUDIO_ADMIN_PASSWORD=ci-only-strong-bootstrap-password',
    image,
  ]);
  await ready();
  await docker([
    'exec',
    identifier,
    'node',
    '-e',
    'if(process.getuid()===0)process.exit(1)',
  ]);
  pass(
    'production starts as non-root with read-only filesystem and dropped capabilities',
  );
  await docker([
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--memory=2g',
    '--cpus=2',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    image,
    'node',
    '--input-type=module',
    '-e',
    "import assert from 'node:assert/strict';import{generateText,Output}from'ai';import{z}from'zod';import{createLocalLanguageModel,closeLocalModels}from'./dist/server/local-model.js';assert.notEqual(process.getuid(),0);try{const model=createLocalLanguageModel({directory:process.env.STUDIO_LOCAL_MODEL_DIR});const chat=await generateText({model,system:'You are a helpful assistant. Answer briefly.',prompt:'What is 2 + 2?',maxOutputTokens:64,maxRetries:0});assert.match(chat.text,/4/);const json=await generateText({model,system:'You are a helpful assistant. Answer briefly.',prompt:'What is 2 + 2? Return JSON with integer answer.',output:Output.object({schema:z.object({answer:z.number().int()}).strict()}),maxOutputTokens:64,maxRetries:0});assert.deepEqual(json.output,{answer:4});assert.equal(json.providerMetadata['llama-cpp-cpu'].device,'cpu');assert.ok(json.providerMetadata['llama-cpp-cpu'].processRssBytes<1073741824)}finally{await closeLocalModels()}",
  ]);
  pass(
    'packaged pinned CPU model generates chat and schema JSON as non-root with no network',
  );
  await docker(
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp',
      '--memory=2g',
      '--cpus=2',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '-e',
      'STUDIO_SMOKE_NATIVE_APP=1',
      image,
      'node',
      'dist/server/studio-native-app-smoke.mjs',
    ],
    240000,
  );
  pass(
    'shipping App defaults to genuine local native T3, completes HTTP chat and a fresh-process turn with persisted checkpoints offline',
  );

  await api('/auth/demo', 'POST', undefined, 404);
  pass('demo access is unavailable in production');
  await api('/auth/login', 'POST', {
    email: 'owner@example.test',
    password: 'ci-only-strong-bootstrap-password',
  });
  pass('password login issues Secure HttpOnly session cookies');
  const project = await api(
    '/projects',
    'POST',
    {
      title: 'Container persistence proof',
      description: 'Release test fixture',
      repository: '',
    },
    201,
  );
  const artifact = await api(
    `/projects/${project.id}/artifacts`,
    'POST',
    { kind: 'code', title: 'Persistent preview' },
    201,
  );
  const bundle = await api(`/artifacts/${artifact.id}`);
  assert.equal(bundle.decisions.length, 1);
  assert.equal(bundle.threads.length, 1);
  await api(
    `/artifacts/${artifact.id}/messages`,
    'POST',
    {
      threadId: bundle.threads[0].id,
      body: 'Keep this context after restart.',
    },
    201,
  );
  const decision = bundle.decisions[0];
  await api(`/artifacts/${artifact.id}/decisions/${decision.id}`, 'PUT', {
    title: decision.title,
    context: 'Release fixture',
    decision: 'Persist the artifact context',
    consequences: 'A restart keeps it attached',
    status: 'accepted',
    version: decision.version,
  });
  const afterDecision = (await api(`/artifacts/${artifact.id}`)).artifact;
  assert.equal(afterDecision.version, artifact.version + 1);
  assert.deepEqual(afterDecision.content, artifact.content);
  pass('accepted ADR advances semantic source version without rewriting code');
  const content = {
    ...afterDecision.content,
    files: {
      ...afterDecision.content.files,
      'index.html': '<h1>Persisted release fixture</h1>',
    },
  };
  await api(
    `/artifacts/${artifact.id}`,
    'PATCH',
    { version: artifact.version, content },
    409,
  );
  const updated = await api(`/artifacts/${artifact.id}`, 'PATCH', {
    version: afterDecision.version,
    content,
  });
  await api(
    `/artifacts/${artifact.id}`,
    'PATCH',
    { version: afterDecision.version, content },
    409,
  );
  pass('artifact/chat/ADR creation is durable and stale writes fail');
  await docker(['restart', identifier]);
  await ready();
  const restored = await api(`/artifacts/${artifact.id}`);
  assert.equal(restored.artifact.version, updated.version);
  assert.equal(
    restored.artifact.content.files['index.html'],
    '<h1>Persisted release fixture</h1>',
  );
  assert(
    restored.messages.some(
      (message) => message.body === 'Keep this context after restart.',
    ),
  );
  assert.equal(restored.decisions[0].status, 'accepted');
  pass(
    'artifact content, session, chat, and accepted ADR survive a real process restart',
  );
  // This is the packaged browser driver, not a host-installed test browser.
  await docker([
    'exec',
    identifier,
    'node',
    '--input-type=module',
    '-e',
    "import{createRequire}from'node:module';if(process.env.XDG_CONFIG_HOME!=='/tmp/studio-config'||process.env.XDG_CACHE_HOME!=='/tmp/studio-cache')throw new Error('Chromium needs writable XDG paths under /tmp');const require=createRequire(import.meta.resolve('@ai-bdd/driver-playwright'));const{chromium}=require('playwright-core');const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});const page=await browser.newPage();await page.goto('http://127.0.0.1:8787/');if(!(await page.title()).includes('Studio'))process.exitCode=1;await browser.close()",
  ]);
  pass(
    'packaged Chromium launches under the production container restrictions and loads Studio',
  );
  const refusal = await docker([
    'run',
    '--rm',
    '-e',
    'STUDIO_DEMO=1',
    '-e',
    `STUDIO_ORIGIN=${origin}`,
    '-e',
    'STUDIO_ADMIN_PASSWORD=ci-only-strong-bootstrap-password',
    image,
  ]).then(
    () => false,
    () => true,
  );
  assert.equal(refusal, true);
  pass('production bootstrap rejects demo mode');
  const report = {
    image,
    imageId,
    checks: results,
    passed: true,
    scope:
      'Actual local release-image models and native T3 with synthetic accounts and durable data; hosted identity has separate acceptance.',
  };
  if (process.env.STUDIO_SMOKE_REPORT) {
    await writeFile(
      process.env.STUDIO_SMOKE_REPORT,
      JSON.stringify(report, null, 2) + '\n',
    );
    await rm(process.env.STUDIO_SMOKE_REPORT + '.log', { force: true });
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} catch (error) {
  // Container output may contain artifact content. It remains local diagnostic evidence.
  const logs = await docker(['logs', identifier]).catch(() => ({
    stdout: '',
    stderr: '',
  }));
  if (process.env.STUDIO_SMOKE_REPORT)
    await writeFile(
      process.env.STUDIO_SMOKE_REPORT + '.log',
      logs.stdout + logs.stderr,
    );
  throw error;
} finally {
  await docker(['rm', '-f', identifier]).catch(() => {});
  await docker(['volume', 'rm', identifier]).catch(() => {});
}
