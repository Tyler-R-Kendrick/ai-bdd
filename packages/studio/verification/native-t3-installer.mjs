/** Whole controlled installer regression over an actual immutable public archive cache; no inference or account state. */
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { installNativeT3Tools } from '../scripts/install-native-t3-tools.mjs';
import manifest from '../server/local/native-t3-tools.json' with { type: 'json' };
const cache = process.argv[2];
if (!cache || !isAbsolute(cache)) throw new Error('Supply the absolute verified public archive cache (t3.tar.gz and opencode.tar.gz)');
const root = await mkdtemp('/tmp/studio-native-installer-');
const originalFetch = globalThis.fetch;
let downloads = 0, corrupt = false;
globalThis.fetch = async input => {
  const archive = manifest.archives.find(archive => archive.url === String(input));
  assert(archive, 'Installer may fetch only a pinned public archive URL');
  downloads++;
  const response = new Response(corrupt ? Buffer.from('deliberately invalid public archive') : Readable.toWeb(createReadStream(join(cache, archive.name + '.tar.gz'))));
  Object.defineProperty(response, 'url', { value: archive.url });
  return response;
};
try {
  const target = join(root, 'verified');
  await installNativeT3Tools(target);
  for (const file of manifest.files) assert.equal((await lstat(join(target, file.path))).size, file.bytes);
  assert.equal((await lstat(join(target, 't3/t3'))).isFile(), true);
  await assert.rejects(lstat(join(target, 't3/t3-0.1.5-linux-x64')), { code: 'ENOENT' });
  assert.equal(downloads, 2);
  await installNativeT3Tools(target);
  assert.equal(downloads, 2, 'An already verified install must not download or extract again');
  corrupt = true;
  await assert.rejects(installNativeT3Tools(join(root, 'corrupt')), /archive checksum failed/);
  console.log(JSON.stringify({ passed: true, t3Version: manifest.t3Version, openCodeVersion: manifest.openCodeVersion, actualPinnedArchives: 2, exactBinaryChecks: manifest.files.length, idempotentInstall: true, corruptArchiveRejectedBeforeExtraction: true }));
} finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
