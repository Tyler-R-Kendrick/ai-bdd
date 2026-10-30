// Explicit, bounded, model-free acceptance on the reviewed production or protected preview.
// Credentials stay in memory and are sent only to this exact host; redirects are never followed.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, rename, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
const selected = new URL(
  process.env.STUDIO_HOSTED_VIDEO_ORIGIN ?? 'https://invalid.example',
);
const production = selected.origin === 'https://ai-bdd-studio.vercel.app';
if (
  selected.protocol !== 'https:' ||
  selected.port ||
  selected.username ||
  selected.password ||
  selected.pathname !== '/' ||
  selected.search ||
  selected.hash ||
  (!production && !/^ai-bdd-studio-[a-z0-9]+-tyler-r-kendricks-projects\.vercel\.app$/.test(
    selected.hostname,
  ))
)
  throw new Error('An explicit approved canonical production or project preview origin is required');
const origin = selected.origin,
  source = process.env.STUDIO_HOSTED_VIDEO_SOURCE,
  deploymentId = process.env.STUDIO_HOSTED_VIDEO_DEPLOYMENT_ID;
if (
  !/^[a-f0-9]{7,40}$/.test(source ?? '') ||
  !/^dpl_[a-zA-Z0-9]+$/.test(deploymentId ?? '')
)
  throw new Error('Reviewed source and deployment identity are required');
if (process.env.STUDIO_HOSTED_VIDEO_ALLOW_USAGE !== '1')
  throw new Error('Hosted video acceptance requires explicit usage opt-in');
if (production && process.env.STUDIO_HOSTED_VIDEO_ALLOW_PRODUCTION_WRITE !== '1')
  throw new Error('Canonical production acceptance requires its separate production write opt-in');
if (
  (!production && !process.env.VERCEL_OIDC_TOKEN) ||
  !process.env.STUDIO_HOSTED_VIDEO_PASSWORD_FILE ||
  !process.env.STUDIO_HOSTED_VIDEO_EMAIL ||
  !process.env.STUDIO_HOSTED_VIDEO_REPORT
)
  throw new Error(
    'Protected identity, owner credential-file reference, email and report destination are required',
  );
const report = {
  schemaVersion: 1,
  environment: production ? 'production' : 'preview',
  previewIdentityHeaderSent: !production,
  origin,
  startedAt: new Date().toISOString(),
  deploymentSourceProvidedByOperator: source,
  deploymentIdProvidedByOperator: deploymentId,
  kind: 'model-free hosted video durable publication',
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
await mkdir(dirname(process.env.STUDIO_HOSTED_VIDEO_REPORT), {
  recursive: true,
  mode: 0o700,
});
try {
  await lstat(process.env.STUDIO_HOSTED_VIDEO_REPORT);
  throw new Error(
    'Choose a fresh report destination before creating synthetic resources',
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
async function persistReport() {
  const path = process.env.STUDIO_HOSTED_VIDEO_REPORT,
    temp = path + '.tmp';
  await writeFile(temp, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temp, path);
}
await persistReport();
const password = (
  await readFile(process.env.STUDIO_HOSTED_VIDEO_PASSWORD_FILE, 'utf8')
).replace(/\r?\n$/, '');
assert(password.length >= 16, 'Owner credential file is invalid');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
class GateError extends Error {
  constructor(stage, status, code) {
    super('Hosted video acceptance did not pass');
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
      ...(!production ? { 'x-vercel-trusted-oidc-idp-token': process.env.VERCEL_OIDC_TOKEN } : {}),
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
    body: { email: process.env.STUDIO_HOSTED_VIDEO_EMAIL, password },
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .find((value) => value.startsWith('studio_session='));
  if (!cookie || !value.id)
    throw new GateError(stage, response.status, 'person-session-missing');
  return cookie;
}
async function inspectVideo(bytes) {
  assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
  const dir = await mkdtemp(join(tmpdir(), 'studio-hosted-video-check-'));
  const execute = promisify(execFile);
  try {
    const file = join(dir, 'published.mp4');
    await writeFile(file, bytes, {mode: 0o600});
    const {stdout} = await execute('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',file], {timeout:30000,maxBuffer:1024*1024});
    const probe = JSON.parse(stdout), stream = probe.streams.find(s => s.codec_type === 'video');
    assert(stream); assert.equal(stream.codec_name,'h264'); assert.equal(stream.width,128); assert.equal(stream.height,96);
    assert.equal(stream.r_frame_rate,'24/1'); assert.equal(Number(stream.nb_frames),24);
    assert(Math.abs(Number(probe.format.duration)-1)<0.05);
    const decoded = await execute('ffmpeg',['-v','error','-i',file,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'], {timeout:30000,maxBuffer:128*96*3+1024,encoding:'buffer'});
    const pixels = decoded.stdout; assert.equal(pixels.length,128*96*3);
    const corner = [...pixels.subarray(0,3)]; for(let i=0;i<3;i++) assert(Math.abs(corner[i]-[34,51,68][i])<=8);
    let brightPixels=0; for(let i=0;i<pixels.length;i+=3) if(pixels[i]>150&&pixels[i+1]>150&&pixels[i+2]>150) brightPixels++;
    assert(brightPixels>50);
    return {codec:stream.codec_name,width:stream.width,height:stream.height,frameRate:stream.r_frame_rate,frameCount:Number(stream.nb_frames),duration:Number(probe.format.duration),decodedFrameBytes:pixels.length,cornerRgb:corner,brightTextPixels:brightPixels,decodedFrameSha256:sha(pixels)};
  } finally { await rm(dir,{recursive:true,force:true}); }
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
  if (process.env.STUDIO_HOSTED_VIDEO_RESUME_FILE) {
    const previousBytes = await readFile(
        process.env.STUDIO_HOSTED_VIDEO_RESUME_FILE,
      ),
      previous = JSON.parse(previousBytes.toString('utf8')),
      ids = previous.resources;
    assert.equal(previous.kind, 'model-free hosted video durable publication');
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
    assert.equal(artifact.kind, 'video');
    assert.equal(artifact.title, 'Synthetic one-second title');
    assert.equal(artifact.content.duration, 1);
    assert.equal(artifact.content.clips.length, 1);
    assert.equal(artifact.content.clips[0].text, 'OK');
    ({ value: initial } = await request(
      'resume-existing-video-job',
      `/api/artifacts/${ids.artifactId}/video/renders/${ids.jobId}`,
      { cookie: session },
    ));
    assert.equal(initial.id, ids.jobId);
    assert.equal(initial.format, 'mp4');
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
    const project = {id:process.env.STUDIO_HOSTED_VIDEO_PROJECT_ID};
    assert.match(project.id ?? '', /^[a-f0-9-]{36}$/);
    report.resources.projectId = project.id;
    await persistReport();
    const content = {
      width:128,height:96,background:'#223344',duration:1,fps:24,
      clips:[{id:randomUUID(),type:'text',name:'Synthetic OK title',track:0,start:0,duration:1,mediaStart:0,animationOffset:0,x:8,y:28,width:112,height:40,rotation:0,scale:1,opacity:1,fill:'#ffffff',text:'OK',fontSize:24,fontFamily:'Inter',volume:1,muted:false,locked:false,keyframes:[]}],
    };
    ({ value: artifact } = await request(
      'create-synthetic-video',
      `/api/projects/${project.id}/artifacts`,
      {
        method: 'POST',
        cookie: session,
        expected: 201,
        body: {
          kind: 'video',
          title: 'Synthetic one-second title',
          content,
        },
      },
    ));
    assert.equal(artifact.kind, 'video');
    assert.equal(artifact.content.duration, 1);
    report.resources.artifactId = artifact.id;
    report.resources.artifactVersion = artifact.version;
    await persistReport();
    const idempotencyKey = randomUUID();
    ({ value: initial } = await request(
      'enqueue-video',
      `/api/artifacts/${artifact.id}/video/render`,
      {
        method: 'POST',
        cookie: session,
        expected: 202,
        body: { version: artifact.version, format: 'mp4', idempotencyKey },
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
          stage: 'video-job',
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
      throw new GateError('video-job', 200, 'terminal-job-failure');
    }
    if (Date.now() >= deadline)
      throw new GateError('video-job', 200, 'completion-timeout');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    ({ value: job } = await request(
      'poll-video',
      `/api/artifacts/${artifact.id}/video/renders/${initial.id}`,
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
    'download-published-mp4',
    job.downloadUrl,
    { cookie: session, binary: true },
  );
  assert((response.headers.get('content-type') ?? '').startsWith('video/'));
  const video = await inspectVideo(bytes),
    digest = sha(bytes);
  const { value: exported } = await request(
    'export-persisted-publication',
    `/api/artifacts/${artifact.id}/export`,
    { cookie: session },
  );
  const file = exported.files.find((file) => file.id === job.fileId),
    render = exported.videoRenders.find((render) => render.id === job.id);
  assert(file);
  assert.equal(file.sha256, digest);
  assert.equal(Number(file.byteSize), bytes.length);
  assert.equal(render.status, 'completed');
  assert.equal(render.sourceSnapshot.content.duration, 1);
  assert.equal(render.sourceSnapshot.content.width,128);
  assert.equal(render.sourceSnapshot.content.height,96);
  assert.equal(render.sourceSnapshot.content.clips.length,1);
  assert.equal(render.sourceSnapshot.content.clips[0].text,'OK');
  report.output = {
    byteSize: bytes.length,
    sha256: digest,
    matchesPublishedMetadata: true,
    video,
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
    `/api/artifacts/${artifact.id}/video/renders`,
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
if (
  !report.passed &&
  report.failure?.httpStatus !== 0 &&
  !(report.failure?.httpStatus >= 500)
) {
  report.failedAttemptSessionCleanup = true;
  for (const cookie of new Set([session, fresh].filter(Boolean))) {
    try {
      await request(
        'close-owned-session-after-incomplete-attempt',
        '/api/auth/logout',
        { method: 'POST', cookie, body: {} },
      );
    } catch {
      report.failedAttemptSessionCleanup = false;
      break;
    }
  }
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
