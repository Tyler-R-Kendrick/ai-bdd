/** Controlled image-build download only. Native inference never installs or updates executables. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm, rename, lstat, copyFile, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join } from 'node:path';
import manifest from '../server/local/native-t3-tools.json' with { type: 'json' };
const execute = promisify(execFile);
async function verified(directory) {
  for (const file of manifest.files) {
    const path = join(directory, file.path);
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== file.sha256) return false;
  }
  return true;
}
export async function installNativeT3Tools(directory) {
  if (!isAbsolute(directory) || directory === '/' || process.platform + '-' + process.arch !== manifest.platform)
    throw new Error('Native T3 tools require a dedicated absolute directory on pinned linux-x64');
  if (await verified(directory)) return;
  if (await lstat(directory).catch(() => null)) throw new Error('Refusing to replace an unverified native tools directory');
  const staging = directory + '.staging-' + randomUUID();
  await mkdir(staging, { recursive: true, mode: 0o755 });
  try {
    for (const archive of manifest.archives) {
      const path = join(staging, archive.name + '.tar.gz');
      const response = await fetch(archive.url, { signal: AbortSignal.timeout(900000) });
      if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:') throw new Error('Pinned native tool download failed');
      const file = await open(path, 'wx', 0o600);
      const hash = createHash('sha256'); let bytes = 0;
      try {
        for await (const chunk of response.body) {
          if ((bytes += chunk.length) > archive.maxBytes) throw new Error('Pinned native archive exceeded its byte bound');
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const write = await file.write(chunk, offset, chunk.length - offset);
            if (!write.bytesWritten) throw new Error('Incomplete native tool write');
            offset += write.bytesWritten;
          }
        }
      } finally { await file.close(); }
      if (hash.digest('hex') !== archive.sha256) throw new Error('Pinned native archive checksum failed');
      const target = join(staging, archive.name);
      await mkdir(target, { mode: 0o755 });
      // Archives are immutable and checksum verified before extraction into a fresh, private staging root.
      await execute('tar', ['-xzf', path, '-C', target, '--strip-components=' + archive.stripComponents], { timeout: 120000 });
      await rm(path);
    }
    if (!await verified(staging)) throw new Error('Pinned native executable checksum failed');
    for (const file of manifest.files) await chmod(join(staging, file.path), 0o755);
    await copyFile(new URL('../server/local/licenses/T3-MIT.txt', import.meta.url), join(staging, 'T3-MIT.txt'));
    await copyFile(new URL('../server/local/licenses/OPENCODE-MIT.txt', import.meta.url), join(staging, 'OPENCODE-MIT.txt'));
    await rename(staging, directory);
    console.log('Verified native T3 ' + manifest.t3Version + ' and OpenCode ' + manifest.openCodeVersion + ' (linux-x64, MIT)');
  } finally { await rm(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) await installNativeT3Tools(process.argv[2] ?? '');
