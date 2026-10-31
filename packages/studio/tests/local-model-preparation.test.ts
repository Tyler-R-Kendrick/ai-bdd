import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp('/tmp/studio-operator-preparation-');
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('Owned operator asset fixture, not model weights.');
  const file = { path: 'owned.bin', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const manifest = { id: 'owned', files: [file], alternatives: [{ id: 'owned-mapped', useMmap: true, files: [file] }] };
  await mkdir(join(root, 'scripts')); await mkdir(join(root, 'server/local'), { recursive: true });
  await copyFile(new URL('../server/local/MODEL-LICENSE.txt', import.meta.url), join(root, 'server/local/MODEL-LICENSE.txt'));
  const output = join(root, 'scripts/prepare.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../scripts/download-local-model.mjs', import.meta.url))], outfile: output,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'owned-small-asset-registry', setup(builder) {
      builder.onLoad({ filter: /model-manifest\.json$/ }, () => ({ contents: JSON.stringify(manifest), loader: 'json' }));
    } }],
  });
  const { downloadLocalModel } = await import(pathToFileURL(output).href);
  const directory = join(root, 'assets'); await mkdir(directory);
  return { root, bytes, file, directory, downloadLocalModel };
}

describe('operator asset preparation without model weights', () => {
  it('makes verified mapped cache assets read-only without changing bytes or rewriting already read-only metadata', async () => {
    const f = await fixture(), path = join(f.directory, f.file.path);
    await writeFile(path, f.bytes, { mode: 0o600 });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
    await f.downloadLocalModel(f.directory, 'owned-mapped');
    const before = await lstat(path);
    expect(before.mode & 0o222).toBe(0); expect(await readFile(path)).toEqual(f.bytes);
    await f.downloadLocalModel(f.directory, 'owned-mapped');
    const after = await lstat(path);
    expect(after.ctimeMs).toBe(before.ctimeMs); expect(after.mtimeMs).toBe(before.mtimeMs); expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps existing non-mapped operator-cache permissions unchanged', async () => {
    const f = await fixture(), path = join(f.directory, f.file.path);
    await writeFile(path, f.bytes, { mode: 0o600 });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
    await f.downloadLocalModel(f.directory);
    expect((await lstat(path)).mode & 0o777).toBe(0o600); expect(fetch).not.toHaveBeenCalled();
  });
  it('makes a newly verified mapped asset read-only before exposing it to inference', async () => {
    const f = await fixture();
    const response = new Response(f.bytes, { status: 200, headers: { 'content-length': String(f.bytes.length) } });
    Object.defineProperty(response, 'url', { value: 'https://owned-download.example.test/asset' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    await f.downloadLocalModel(f.directory, 'owned-mapped');
    const path = join(f.directory, f.file.path);
    expect((await lstat(path)).mode & 0o222).toBe(0); expect(await readFile(path)).toEqual(f.bytes); expect(fetch).toHaveBeenCalledOnce();
  });
});
