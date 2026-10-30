/** Controlled build/operator download only. Inference never calls this script. */
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  rename,
  rm,
  lstat,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import manifest from '../server/local/model-manifest.json' with { type: 'json' };
export async function verifyLocalModelFile(path, file) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes)
    return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === file.sha256;
}
export async function downloadLocalModel(directory) {
  if (!isAbsolute(directory))
    throw new Error('Choose an absolute local model directory');
  for (const file of manifest.files) {
    const target = join(directory, file.path);
    if (await verifyLocalModelFile(target, file).catch(() => false)) continue;
    const temporary = target + '.' + randomUUID() + '.partial';
    await mkdir(join(target, '..'), { recursive: true });
    let handle;
    try {
      const url = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${file.path}`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(900000),
      });
      if (
        !response.ok ||
        !response.body ||
        new URL(response.url).protocol !== 'https:'
      )
        throw new Error('The pinned public model download failed');
      const length = response.headers.get('content-length');
      if (length && Number(length) !== file.bytes)
        throw new Error('Unexpected model download size');
      handle = await open(temporary, 'wx', 0o600);
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > file.bytes)
          throw new Error('Pinned model download exceeded its byte limit');
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const written = await handle.write(
            chunk,
            offset,
            chunk.byteLength - offset,
          );
          if (!written.bytesWritten)
            throw new Error('Pinned model write failed');
          offset += written.bytesWritten;
        }
      }
      if (bytes !== file.bytes || hash.digest('hex') !== file.sha256)
        throw new Error('Pinned model checksum verification failed');
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
    // Public IDs and artifact sizes only; no runtime prompts, headers or credentials.
    console.log(`Verified ${manifest.id}: ${file.path} (${file.bytes} bytes)`);
  }
  await writeFile(
    join(directory, 'MODEL-LICENSE.txt'),
    await readFile(
      new URL('../server/local/MODEL-LICENSE.txt', import.meta.url),
    ),
  );
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  await downloadLocalModel(process.argv[2] ?? '');
}
