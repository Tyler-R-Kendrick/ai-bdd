// Actual network-denied OCI worker acceptance. This does not simulate a Vercel account or VM creation.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { observeCompletion } from './observe-completion.mjs';
const execute = promisify(execFile),
  image = process.env.STUDIO_MEDIA_TEST_IMAGE ?? 'ai-bdd-studio-media:review',
  reportPath = process.env.STUDIO_MEDIA_TEST_REPORT;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const env = {
  ...process.env,
  DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? '/tmp/studio-media-docker',
};
for (const name of [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
])
  delete env[name];
const docker = (args) =>
  execute('docker', ['--host=unix:///var/run/docker.sock', ...args], {
    env,
    timeout: 240000,
    maxBuffer: 1024 * 1024,
  });
const imageId = (
  await docker(['image', 'inspect', '--format', '{{.Id}}', image])
).stdout.trim();
const checks = [],
  workerReceipts = [];
let count = 0;
function tone() {
  const rate = 48000,
    frames = rate / 2,
    bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let n = 0; n < frames; n++)
    bytes.writeInt16LE(
      Math.round(Math.sin((n * 2 * Math.PI * 440) / rate) * 0.2 * 32767),
      44 + n * 2,
    );
  return bytes;
}
const src = '/api/files/' + randomUUID(),
  source = tone();
async function run(payload, assets = [], options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-media-container-')),
    name = 'studio-media-worker-' + randomUUID();
  const request = {
    protocolVersion: 1,
    id: randomUUID(),
    ...payload,
    assets: assets.map((a, index) => ({
      src: a.src,
      file: 'asset-' + index + '.bin',
      byteSize: a.bytes.length,
      sha256: hash(a.bytes),
      mime: a.mime,
    })),
  };
  const raw = Buffer.from(JSON.stringify(request));
  await writeFile(join(directory, 'request.json'), raw, { mode: 0o600 });
  for (const [index, asset] of assets.entries())
    await writeFile(join(directory, 'asset-' + index + '.bin'), asset.bytes, {
      mode: 0o600,
    });
  let created = false;
  try {
    const args = [
      'create',
      '--name',
      name,
      '--network=none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,size=512m',
      '--shm-size=256m',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--user',
      process.getuid() + ':' + process.getgid(),
      '--mount',
      'type=bind,src=' + directory + ',dst=/vercel/sandbox',
    ];
    if (options.tamper) {
      await writeFile(
        join(directory, 'corrupt-font'),
        Buffer.from('bad-font'),
      );
      args.push(
        '--mount',
        'type=bind,src=' +
          join(directory, 'corrupt-font') +
          ',dst=/opt/studio-media/inter.woff2,readonly',
      );
    }
    args.push(image, '/usr/local/bin/node', '/opt/studio-media/worker.mjs');
    await docker(args);
    created = true;
    const inspection = JSON.parse(
      (await docker(['inspect', name])).stdout,
    )[0];
    assert.equal(inspection.HostConfig.NetworkMode, 'none');
    assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(inspection.HostConfig.CapDrop, ['ALL']);
    const completion = docker(['start', '--attach', name]);
    // docker start can reject before the separate kill command resolves. Observe
    // it now so Node does not terminate on an expected cancellation rejection.
    const cancelled = options.cancel ? observeCompletion(completion) : undefined;
    if (options.cancel) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await docker(['kill', name]);
      const outcome = await cancelled;
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error.code, 137);
      await assert.rejects(readFile(join(directory, 'result.json')));
      checks.push('cancel kills actual worker container before publication');
      return;
    }
    if (options.tamper) {
      await assert.rejects(completion);
      await assert.rejects(readFile(join(directory, 'result.json')));
      checks.push('packaged binary/font integrity rejects changed runtime');
      return;
    }
    await completion;
    const result = JSON.parse(
      await readFile(join(directory, 'result.json'), 'utf8'),
    );
    assert.equal(result.id, request.id);
    assert.equal(result.requestSha256, hash(raw));
    assert.equal(result.worker.workerVersion, 'studio-media-worker-v1');
    for (const value of Object.values(result.worker.files))
      assert.match(value, /^[a-f0-9]{64}$/);
    workerReceipts.push({
      kind: request.kind,
      format: request.format ?? null,
      status: result.status,
      ...(result.output ? { output: result.output } : {}),
      worker: result.worker,
    });
    let output;
    if (result.output) {
      output = await readFile(join(directory, 'output.bin'));
      assert.equal(output.length, result.output.byteSize);
      assert.equal(hash(output), result.output.sha256);
    }
    count++;
    return { result, output };
  } finally {
    if (created) await docker(['rm', '--force', name]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
const content = {
  schemaVersion: 1,
  sampleRate: 48000,
  duration: 0.5,
  masterGainDb: 0,
  tracks: [
    {
      id: 'track',
      title: 'Synthetic source',
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      effects: { highpassHz: 20, lowpassHz: 20000, compressor: false },
      clips: [
        {
          id: 'clip',
          title: 'Synthetic tone',
          src,
          start: 0,
          offset: 0,
          duration: 0.5,
          gainDb: 0,
          fadeIn: 0,
          fadeOut: 0,
          reverse: false,
        },
      ],
    },
  ],
};
let failure;
try {
  const verified = await run({ kind: 'verify' });
  assert.equal(verified.result.status, 'completed');
  checks.push('actual packaged runtime hashes and versions verified');
  const probe = await run({ kind: 'audio.probe' }, [
    { src, bytes: source, mime: 'audio/wav' },
  ]);
  assert.equal(probe.result.status, 'completed');
  assert.equal(probe.result.probe.sampleRate, 48000);
  assert(Math.abs(probe.result.probe.duration - 0.5) < 1 / 48000);
  checks.push('actual owned WAV completely decoded and probed');
  for (const format of ['wav', 'flac', 'mp3', 'm4a', 'ogg']) {
    const rendered = await run({ kind: 'audio.render', content, format }, [
      { src, bytes: source, mime: 'audio/wav' },
    ]);
    assert.equal(rendered.result.status, 'completed');
    assert(rendered.output.length > 44);
    const decoded = await run({ kind: 'audio.probe' }, [
      {
        src,
        bytes: rendered.output,
        mime: format === 'm4a' ? 'audio/mp4' : 'audio/' + format,
      },
    ]);
    assert.equal(decoded.result.status, 'completed');
    assert(Math.abs(decoded.result.probe.duration - 0.5) < 0.05);
    checks.push(
      'actual ' + format + ' mixdown encoded and completely decoded',
    );
  }
  const video = {
    width: 128,
    height: 96,
    background: '#243448',
    duration: 1,
    fps: 24,
    layers: [
      {
        id: randomUUID(),
        type: 'text',
        x: 8,
        y: 20,
        width: 112,
        height: 50,
        fill: '#ffffff',
        text: 'Studio',
        fontSize: 24,
        fontFamily: 'Inter',
        start: 0,
        duration: 1,
        rotation: 0,
      },
    ],
  };
  for (const format of ['mp4', 'webm']) {
    const rendered = await run({
      kind: 'video.render',
      title: 'Synthetic bounded font fixture',
      content: video,
      format,
    });
    assert.equal(rendered.result.status, 'completed');
    assert(rendered.output.length > 100);
    if (format === 'mp4')
      assert.equal(rendered.output.toString('ascii', 4, 8), 'ftyp');
    else
      assert.equal(
        rendered.output.subarray(0, 4).toString('hex'),
        '1a45dfa3',
      );
    checks.push(
      'actual Chromium Inter frames and FFmpeg ' +
        format +
        ' duration validated',
    );
  }
  const invalid = await run({ kind: 'audio.probe' }, [
    { src, bytes: Buffer.alloc(100), mime: 'audio/wav' },
  ]);
  assert.equal(invalid.result.status, 'error');
  assert.equal(invalid.result.error.statusCode, 400);
  checks.push('malformed audio source rejected by actual decoder');
  await run({ kind: 'verify' }, [], { tamper: true });
  await run(
    {
      kind: 'video.render',
      title: 'Cancellation fixture',
      content: { ...video, duration: 120, fps: 60 },
      format: 'mp4',
    },
    [],
    { cancel: true },
  );
} catch (error) {
  failure = error;
}
const report = {
  schemaVersion: 1,
  provider: 'local-OCI-worker-acceptance',
  image,
  imageId,
  verifiedAt: new Date().toISOString(),
  vmsCreatedOnVercel: false,
  passed: !failure,
  checks,
  workerRequestsCompleted: count,
  workerReceipts,
  ...(failure ? { error: failure.message } : {}),
};
if (reportPath) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    passed: report.passed,
    imageId,
    checks: checks.length,
    workerRequestsCompleted: count,
    report: reportPath ?? null,
  }),
);
if (failure) throw failure;
