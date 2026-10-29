import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const upstream = JSON.parse(
  await readFile(new URL('./upstream.json', import.meta.url)),
);
const destination = resolve(process.argv[2] ?? 'work/open-magnetar');
await mkdir(destination, { recursive: true });
const response = await fetch(
  `https://codeload.github.com/Lulzx/open-magnetar/tar.gz/${upstream.commit}`,
  { signal: AbortSignal.timeout(60000) },
);
if (!response.ok)
  throw new Error(`Pinned source download failed (${response.status})`);
const data = Buffer.from(await response.arrayBuffer());
if (
  createHash('sha256').update(data).digest('hex') !== upstream.archiveSha256
)
  throw new Error('Pinned public source archive checksum mismatch');
const archive = join(destination, 'verified-source.tar.gz');
await writeFile(archive, data);
await promisify(execFile)('tar', [
  '-xzf',
  archive,
  '--directory',
  destination,
  '--strip-components=1',
  '--no-same-owner',
  '--no-same-permissions',
]);
process.stdout.write(
  `Verified independent research implementation ${upstream.commit}\n`,
);
