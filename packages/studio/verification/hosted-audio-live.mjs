// Explicit, bounded, model-free acceptance on the reviewed protected preview.
// Credentials stay in memory and are sent only to this exact host; redirects are never followed.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const selected = new URL(
  process.env.STUDIO_HOSTED_AUDIO_ORIGIN ?? 'https://invalid.example',
);
if (
  selected.protocol !== 'https:' ||
  selected.port ||
  selected.username ||
  selected.password ||
  selected.pathname !== '/' ||
  selected.search ||
  selected.hash ||
  !/^ai-bdd-studio-[a-z0-9]+-tyler-r-kendricks-projects\.vercel\.app$/.test(
    selected.hostname,
  )
)
  throw new Error('An explicit approved project preview origin is required');
const origin = selected.origin,
  source = process.env.STUDIO_HOSTED_AUDIO_SOURCE,
  deploymentId = process.env.STUDIO_HOSTED_AUDIO_DEPLOYMENT_ID;
if (
  !/^[a-f0-9]{7,40}$/.test(source ?? '') ||
  !/^dpl_[a-zA-Z0-9]+$/.test(deploymentId ?? '')
)
  throw new Error('Reviewed source and deployment identity are required');
if (process.env.STUDIO_HOSTED_AUDIO_ALLOW_USAGE !== '1')
  throw new Error('Hosted audio acceptance requires explicit usage opt-in');
if (
  !process.env.VERCEL_OIDC_TOKEN ||
  !process.env.STUDIO_HOSTED_AUDIO_PASSWORD_FILE ||
  !process.env.STUDIO_HOSTED_AUDIO_EMAIL ||
  !process.env.STUDIO_HOSTED_AUDIO_REPORT
)
  throw new Error(
    'Protected identity, owner credential-file reference, email and report destination are required',
  );
const report = {
  schemaVersion: 1,
  origin,
  startedAt: new Date().toISOString(),
  deploymentSourceProvidedByOperator: source,
  deploymentIdProvidedByOperator: deploymentId,
  kind: 'model-free hosted audio durable publication',
  passed: false,
  state: 'running',
  steps: [],
  resources: {},
  jobHistory: [],
  modelsInvokedByThisScript: 0,
  externalAssetSources: 0,
  redirectsFollowed: 0,
  credentialValuesRecorded: false,
};
await mkdir(dirname(process.env.STUDIO_HOSTED_AUDIO_REPORT), {
  recursive: true,
  mode: 0o700,
});
try {
  await lstat(process.env.STUDIO_HOSTED_AUDIO_REPORT);
  throw new Error(
    'Choose a fresh report destination before creating synthetic resources',
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
async function persistReport() {
  const path = process.env.STUDIO_HOSTED_AUDIO_REPORT,
    temp = path + '.tmp';
  await writeFile(temp, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temp, path);
}
await persistReport();
const password = (
  await readFile(process.env.STUDIO_HOSTED_AUDIO_PASSWORD_FILE, 'utf8')
).replace(/\r?\n$/, '');
assert(password.length >= 16, 'Owner credential file is invalid');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
class GateError extends Error {
  constructor(stage, status, code) {
    super('Hosted audio acceptance did not pass');
    this.stage = stage;
    this.httpStatus = status;
    this.code = code;
  }
}
async function bounded(response, limit) {
  const parts = [];
  let size = 0;
  for await (const part of response.body ?? []) {
    size += part.length;
    if (size > limit) {
      await response.body?.cancel().catch(() => {});
      throw new GateError(
        'response-budget',
        response.status,
        'oversized-response',
      );
    }
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}
async function request(
  stage,
  path,
  { method = 'GET', cookie = '', body, expected = 200, binary = false } = {},
) {
  const target = new URL(path, origin);
  if (
    target.origin !== origin ||
    target.username ||
    target.password ||
    !target.pathname.startsWith('/api/')
  )
    throw new GateError(stage, 0, 'foreign-target-refused');
  const started = Date.now(),
    headers = {
      'x-vercel-trusted-oidc-idp-token': process.env.VERCEL_OIDC_TOKEN,
      origin,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };
  let response;
  try {
    response = await fetch(target, {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(60000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new GateError(stage, 0, 'transport-failure');
  }
  report.steps.push({
    stage,
    method,
    path: target.pathname,
    httpStatus: response.status,
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  });
  await persistReport();
  const bytes = await bounded(
    response,
    binary ? 4 * 1024 * 1024 : 2 * 1024 * 1024,
  );
  if (response.status !== expected)
    throw new GateError(
      stage,
      response.status,
      response.status >= 500
        ? 'server-failure'
        : response.status >= 300 && response.status < 400
          ? 'redirect-refused'
          : 'unexpected-status',
    );
  if (binary) return { bytes, response };
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new GateError(stage, response.status, 'non-json-response');
  }
  return { value, response };
}
async function login(stage) {
  const { response, value } = await request(stage, '/api/auth/login', {
    method: 'POST',
    body: { email: process.env.STUDIO_HOSTED_AUDIO_EMAIL, password },
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .find((value) => value.startsWith('studio_session='));
  if (!cookie || !value.id)
    throw new GateError(stage, response.status, 'person-session-missing');
  return cookie;
}
function inspectWave(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
  let fmt, data;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const kind = bytes.toString('ascii', offset, offset + 4),
      size = bytes.readUInt32LE(offset + 4),
      next = offset + 8 + size;
    assert(next <= bytes.length, 'Malformed WAV chunk');
    if (kind === 'fmt ')
      fmt = {
        codec: bytes.readUInt16LE(offset + 8),
        channels: bytes.readUInt16LE(offset + 10),
        sampleRate: bytes.readUInt32LE(offset + 12),
        bitsPerSample: bytes.readUInt16LE(offset + 22),
      };
    if (kind === 'data') data = bytes.subarray(offset + 8, next);
    offset = next + (size % 2);
  }
  assert(fmt && data, 'WAV format and sample chunks required');
  assert.equal(fmt.channels, 2);
  assert.equal(fmt.sampleRate, 48000);
  assert.equal(fmt.bitsPerSample, 16);
  assert([1, 65534].includes(fmt.codec));
  assert(
    Math.abs(
      data.length / ((fmt.channels * fmt.sampleRate * fmt.bitsPerSample) / 8) -
        0.25,
    ) < 0.001,
  );
  assert(
    data.every((byte) => byte === 0),
    'Empty-track render must contain silence',
  );
  return {
    ...fmt,
    dataBytes: data.length,
    duration:
      data.length / ((fmt.channels * fmt.sampleRate * fmt.bitsPerSample) / 8),
    silent: true,
  };
}
let session = '',
  fresh = '';
try {
  const health = await request('health', '/api/health');
  assert.equal(health.value.ok, true);
  const { value: readiness } = await request(
    'readiness',
    '/api/hosting/readiness',
  );
  assert.equal(readiness.ready, true);
  report.readiness = { ready: readiness.ready, services: readiness.services };
  session = await login('owner-login');
  let artifact, initial;
  if (process.env.STUDIO_HOSTED_AUDIO_RESUME_FILE) {
    const previousBytes = await readFile(
        process.env.STUDIO_HOSTED_AUDIO_RESUME_FILE,
      ),
      previous = JSON.parse(previousBytes.toString('utf8')),
      ids = previous.resources;
    assert.equal(previous.kind, 'model-free hosted audio durable publication');
    for (const key of ['projectId', 'artifactId', 'jobId'])
      assert(
        /^[a-f0-9-]{36}$/.test(ids?.[key] ?? ''),
        'A prior task-owned UUID is required',
      );
    assert(Number.isInteger(ids.artifactVersion) && ids.artifactVersion > 0);
    const { value: bundle } = await request(
      'resume-exact-artifact',
      `/api/artifacts/${ids.artifactId}`,
      { cookie: session },
    );
    artifact = bundle.artifact;
    assert.equal(artifact.id, ids.artifactId);
    assert.equal(artifact.projectId, ids.projectId);
    assert.equal(artifact.version, ids.artifactVersion);
    assert.equal(artifact.kind, 'audio');
    assert.equal(artifact.title, 'Synthetic quarter-second silence');
    assert.equal(artifact.content.duration, 0.25);
    assert.deepEqual(artifact.content.tracks, []);
    ({ value: initial } = await request(
      'resume-existing-audio-job',
      `/api/artifacts/${ids.artifactId}/audio/renders/${ids.jobId}`,
      { cookie: session },
    ));
    assert.equal(initial.id, ids.jobId);
    assert.equal(initial.format, 'wav');
    report.resources = {
      projectId: ids.projectId,
      artifactId: ids.artifactId,
      artifactVersion: ids.artifactVersion,
      jobId: ids.jobId,
    };
    report.recovery = {
      noNewEnqueue: true,
      originalAdmissionSource: previous.deploymentSourceProvidedByOperator,
      originalAdmissionDeployment: previous.deploymentIdProvidedByOperator,
      originalAdmissionOrigin: previous.origin,
      originalQueuedAt: previous.jobHistory?.[0]?.at ?? null,
      priorTraceSha256: sha(previousBytes),
    };
    await persistReport();
  } else {
    const suffix = randomUUID(),
      { value: project } = await request(
        'create-synthetic-project',
        '/api/projects',
        {
          method: 'POST',
          cookie: session,
          expected: 201,
          body: {
            title: 'Hosted audio release acceptance ' + suffix.slice(0, 8),
            description:
              'Synthetic model-free preview acceptance. No external source assets.',
            repository: '',
          },
        },
      );
    assert(project.id);
    report.resources.projectId = project.id;
    await persistReport();
    const content = {
      schemaVersion: 1,
      sampleRate: 48000,
      duration: 0.25,
      masterGainDb: 0,
      tracks: [],
    };
    ({ value: artifact } = await request(
      'create-synthetic-audio',
      `/api/projects/${project.id}/artifacts`,
      {
        method: 'POST',
        cookie: session,
        expected: 201,
        body: {
          kind: 'audio',
          title: 'Synthetic quarter-second silence',
          content,
        },
      },
    ));
    assert.equal(artifact.kind, 'audio');
    assert.equal(artifact.content.duration, 0.25);
    report.resources.artifactId = artifact.id;
    report.resources.artifactVersion = artifact.version;
    await persistReport();
    const idempotencyKey = randomUUID();
    ({ value: initial } = await request(
      'enqueue-audio',
      `/api/artifacts/${artifact.id}/audio/render`,
      {
        method: 'POST',
        cookie: session,
        expected: 202,
        body: { version: artifact.version, format: 'wav', idempotencyKey },
      },
    ));
    assert(initial.id);
    report.resources.jobId = initial.id;
    await persistReport();
  }
  let job = initial;
  const deadline = Date.now() + 480000;
  let lastStatus = '',
    lastProgress = -1,
    lastNotice = 0;
  while (true) {
    if (job.status !== lastStatus || job.progress !== lastProgress) {
      report.jobHistory.push({
        at: new Date().toISOString(),
        status: job.status,
        progress: job.progress ?? null,
        finishedAt: job.finishedAt ?? null,
      });
      await persistReport();
      lastStatus = job.status;
      lastProgress = job.progress;
    }
    if (Date.now() - lastNotice >= 15000) {
      console.log(
        JSON.stringify({
          stage: 'audio-job',
          status: job.status,
          jobId: initial.id,
        }),
      );
      lastNotice = Date.now();
    }
    if (job.status === 'completed') break;
    if (['failed', 'cancelled', 'interrupted'].includes(job.status)) {
      report.jobFailure = {
        status: job.status,
        errorPresent: !!job.error,
        errorSha256: job.error ? sha(String(job.error)) : null,
      };
      throw new GateError('audio-job', 200, 'terminal-job-failure');
    }
    if (Date.now() >= deadline)
      throw new GateError('audio-job', 200, 'completion-timeout');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    ({ value: job } = await request(
      'poll-audio',
      `/api/artifacts/${artifact.id}/audio/renders/${initial.id}`,
      { cookie: session },
    ));
  }
  assert.equal(job.progress, 1);
  assert(job.fileId);
  assert.equal(job.artifactVersion, artifact.version);
  assert.equal(job.downloadUrl, `/api/files/${job.fileId}`);
  assert(
    String(job.runtimeFingerprint).includes(
      'studio-media@sha256:d7d38332686b625e0d8f04b74f16a483d75676023fadac148333d39a9c15c689',
    ),
  );
  report.resources.fileId = job.fileId;
  report.runtimeFingerprint = job.runtimeFingerprint;
  report.finishedAt = job.finishedAt;
  const { bytes, response } = await request(
    'download-published-wav',
    job.downloadUrl,
    { cookie: session, binary: true },
  );
  assert((response.headers.get('content-type') ?? '').startsWith('audio/'));
  const wave = inspectWave(bytes),
    digest = sha(bytes);
  const { value: exported } = await request(
    'export-persisted-publication',
    `/api/artifacts/${artifact.id}/export`,
    { cookie: session },
  );
  const file = exported.files.find((file) => file.id === job.fileId),
    render = exported.audioRenders.find((render) => render.id === job.id);
  assert(file);
  assert.equal(file.sha256, digest);
  assert.equal(Number(file.byteSize), bytes.length);
  assert.equal(render.status, 'completed');
  assert.equal(render.sourceSnapshot.content.duration, 0.25);
  assert.deepEqual(render.sourceSnapshot.content.tracks, []);
  report.output = {
    byteSize: bytes.length,
    sha256: digest,
    matchesPublishedMetadata: true,
    wave,
  };
  fresh = await login('fresh-owner-login');
  const { value: reloaded } = await request(
    'fresh-session-artifact',
    `/api/artifacts/${artifact.id}`,
    { cookie: fresh },
  );
  assert.equal(reloaded.artifact.version, artifact.version);
  assert.deepEqual(reloaded.artifact.content, artifact.content);
  const { value: renders } = await request(
    'fresh-session-render-list',
    `/api/artifacts/${artifact.id}/audio/renders`,
    { cookie: fresh },
  );
  assert.equal(
    renders.find((render) => render.id === job.id)?.status,
    'completed',
  );
  const { bytes: again } = await request(
    'fresh-session-file',
    job.downloadUrl,
    { cookie: fresh, binary: true },
  );
  assert.equal(sha(again), digest);
  report.freshSessionPersistence = true;
  const { value: anonymousFile } = await request(
    'anonymous-file-denial',
    job.downloadUrl,
    { expected: 401 },
  );
  assert.equal(anonymousFile.error, 'Sign in to continue');
  const { value: anonymousArtifact } = await request(
    'anonymous-artifact-denial',
    `/api/artifacts/${artifact.id}`,
    {
      expected: 401,
    },
  );
  assert.equal(anonymousArtifact.error, 'Sign in to continue');
  report.unauthorizedDenied = true;
  await request('close-first-owned-session', '/api/auth/logout', {
    method: 'POST',
    cookie: session,
    body: {},
  });
  await request('close-fresh-owned-session', '/api/auth/logout', {
    method: 'POST',
    cookie: fresh,
    body: {},
  });
  session = '';
  fresh = '';
  report.passed = true;
} catch (error) {
  report.failure = {
    stage: error instanceof GateError ? error.stage : 'assertion',
    httpStatus: error instanceof GateError ? error.httpStatus : null,
    code:
      error instanceof GateError ? error.code : 'acceptance-assertion-failed',
  };
  process.exitCode = 1;
}
report.completedAt = new Date().toISOString();
report.state = report.passed ? 'completed' : 'incomplete';
report.syntheticResourcesRetainedForReview = true;
await persistReport();
console.log(
  JSON.stringify({
    passed: report.passed,
    projectId: report.resources.projectId ?? null,
    artifactId: report.resources.artifactId ?? null,
    jobId: report.resources.jobId ?? null,
    fileId: report.resources.fileId ?? null,
    failure: report.failure ?? null,
  }),
);
