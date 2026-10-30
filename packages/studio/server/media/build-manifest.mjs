// Runs only while building the trusted image, never installs a runtime dependency.
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const execute = promisify(execFile);
const { fileDigest, mediaBinaryPaths } = await import(
  '/opt/studio-media/worker.mjs'
);
const files = {};
for (const [key, path] of Object.entries(mediaBinaryPaths))
  files[key] = await fileDigest(path);
const version = async (program, args) => {
  const output = await execute(program, args, {
    timeout: 15000,
    maxBuffer: 65536,
  });
  return output.stdout.trim().split('\n')[0].slice(0, 300);
};
const manifest = {
  workerVersion: 'studio-media-worker-v1',
  files,
  versions: {
    node: process.version,
    ffmpeg: await version('/usr/bin/ffmpeg', ['-version']),
    ffprobe: await version('/usr/bin/ffprobe', ['-version']),
    chromium: await version('/usr/bin/chromium', ['--version']),
  },
};
await writeFile('/opt/studio-media/manifest.json', JSON.stringify(manifest), {
  mode: 0o444,
});
const lock = await readFile('/opt/studio-media/pnpm-lock.yaml');
await writeFile(
  '/opt/studio-media/build-provenance.json',
  JSON.stringify({
    schemaVersion: 1,
    workerSha256: files.worker,
    lockSha256: createHash('sha256').update(lock).digest('hex'),
    sourceBuild: JSON.parse(
      await readFile('/opt/studio-media/source-build.json', 'utf8'),
    ),
    manifest,
  }),
  { mode: 0o444 },
);
