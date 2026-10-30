// Explicit paid-provider gate. No credentials belong in arguments, source files, reports, or chat.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  VercelSandboxMediaRuntime,
  mediaSandboxConfigFromEnv,
} from '../server/media/vercel-sandbox.ts';
if (process.env.STUDIO_MEDIA_LIVE_ALLOW_USAGE !== '1')
  throw new Error(
    'Real Sandbox acceptance requires explicit STUDIO_MEDIA_LIVE_ALLOW_USAGE=1 and the approved operator credential binding',
  );
const runtime = new VercelSandboxMediaRuntime(
  mediaSandboxConfigFromEnv(process.env),
);
const signal = AbortSignal.timeout(240000),
  verified = await runtime.verify(signal);
const audio = await runtime.audioRenderDriver.render({
  content: {
    schemaVersion: 1,
    sampleRate: 48000,
    duration: 0.25,
    masterGainDb: 0,
    tracks: [],
  },
  assets: new Map(),
  format: 'wav',
  signal,
});
const probe = await runtime.audioSourceProbe(audio, { signal });
assert(Math.abs(probe.duration - 0.25) < 0.01);
const video = await runtime.videoRenderDriver.render({
  content: {
    width: 128,
    height: 96,
    background: '#243448',
    duration: 1,
    fps: 24,
    clips: [],
  },
  title: 'Synthetic real Sandbox acceptance',
  assets: new Map(),
  format: 'mp4',
  signal,
});
assert.equal(video.toString('ascii', 4, 8), 'ftyp');
const report = {
  schemaVersion: 1,
  provider: 'vercel-sandbox',
  verifiedAt: new Date().toISOString(),
  runtime: verified,
  audio: {
    byteSize: audio.length,
    sha256: createHash('sha256').update(audio).digest('hex'),
    probe,
  },
  video: {
    byteSize: video.length,
    sha256: createHash('sha256').update(video).digest('hex'),
  },
  passed: true,
};
if (process.env.STUDIO_MEDIA_LIVE_REPORT)
  await writeFile(
    process.env.STUDIO_MEDIA_LIVE_REPORT,
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
console.log(
  JSON.stringify({
    passed: true,
    provider: report.provider,
    image: runtime.config.image,
    report: process.env.STUDIO_MEDIA_LIVE_REPORT ?? null,
  }),
);
