// Google Chrome supplies the proprietary H.264 decoder absent from bundled Chromium.
// Keep the exact official archive pinned; only the MP4 acceptance file uses it.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const version = '156.0.8078.80';
const archiveSha256 =
  'b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7';
const executableSha256 =
  '1bcad71ad1bff85955db13c6d8dd9f32374934d5a5cb079b526c46fb51f9bd97';
const url = `https://storage.googleapis.com/chrome-for-testing-public/${version}/linux64/chrome-linux64.zip`;
if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('The pinned MP4 acceptance browser requires Linux x64.');
const folder = resolve(
  process.env.STUDIO_MP4_BROWSER_CACHE ??
    join(homedir(), '.cache/studio-mp4-chrome'),
  version,
);
const archive = join(folder, 'chrome-linux64.zip');
const executable = join(folder, 'chrome-linux64/chrome');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
await mkdir(folder, { recursive: true });
let bytes = await readFile(archive).catch(() => null);
if (!bytes || hash(bytes) !== archiveSha256) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (
    !response.ok ||
    Number(response.headers.get('content-length')) > 300_000_000
  )
    throw new Error('Unable to download the pinned official Chrome archive.');
  bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 300_000_000 || hash(bytes) !== archiveSha256)
    throw new Error(
      'Official Chrome archive SHA-256 does not match the checked-in pin.',
    );
  await writeFile(archive, bytes, { mode: 0o600 });
}
const execute = promisify(execFile);
// Verify the archive before extraction, including when a CI cache is restored.
await execute('unzip', ['-q', '-o', archive, '-d', folder]);
for (const name of [
  'chrome',
  'chrome_crashpad_handler',
  'chrome_sandbox',
  'chrome-wrapper',
])
  await chmod(join(folder, 'chrome-linux64', name), 0o755);
if (hash(await readFile(executable)) !== executableSha256)
  throw new Error(
    'Extracted Chrome executable SHA-256 does not match the checked-in pin.',
  );
const reportedVersion = (
  await execute(executable, ['--version'])
).stdout.trim();
if (!reportedVersion.includes(version))
  throw new Error('Unexpected Chrome version.');
if (process.env.GITHUB_ENV)
  await appendFile(
    process.env.GITHUB_ENV,
    `STUDIO_MP4_CHROMIUM_PATH=${executable}\n`,
  );
console.log(
  JSON.stringify({
    version: reportedVersion,
    url,
    archiveSha256,
    executableSha256,
    executable,
  }),
);
