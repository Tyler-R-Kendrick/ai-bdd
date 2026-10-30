import { it, expect } from 'vitest';
import {
  cp,
  mkdir,
  copyFile,
  readFile,
  realpath,
  symlink,
  mkdtemp,
  rm,
  access,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
const execute = promisify(execFile);
it('prepares the real worker from a clean install with no workspace driver dist entry', async () => {
  const source = resolve(import.meta.dirname, '..'),
    repository = resolve(source, '../..'),
    directory = await mkdtemp(join(tmpdir(), 'studio-clean-media-'));
  try {
    const studio = join(directory, 'packages/studio'),
      driver = join(directory, 'packages/driver-playwright');
    await mkdir(join(studio, 'verification'), { recursive: true });
    await mkdir(join(driver, 'node_modules'), { recursive: true });
    for (const name of ['server', 'shared', 'client'])
      await cp(join(source, name), join(studio, name), { recursive: true });
    for (const name of [
      'package.json',
      'media.Dockerfile',
      'media.Dockerfile.dockerignore',
    ])
      await copyFile(join(source, name), join(studio, name));
    await copyFile(
      join(source, 'verification/prepare-media-image.mjs'),
      join(studio, 'verification/prepare-media-image.mjs'),
    );
    for (const name of ['LICENSE', 'pnpm-lock.yaml'])
      await copyFile(join(repository, name), join(directory, name));
    const metadata = await realpath(
      join(source, 'node_modules/@ai-bdd/driver-playwright/package.json'),
    );
    const core = dirname(
      createRequire(metadata).resolve('playwright-core/package.json'),
    );
    await copyFile(metadata, join(driver, 'package.json'));
    await symlink(core, join(driver, 'node_modules/playwright-core'), 'dir');
    for (const name of ['esbuild', 'zod', '@fontsource-variable/inter']) {
      const target = join(studio, 'node_modules', name);
      await mkdir(dirname(target), { recursive: true });
      await symlink(
        await realpath(join(source, 'node_modules', name)),
        target,
        'dir',
      );
    }
    const target = join(studio, 'node_modules/@ai-bdd/driver-playwright');
    await mkdir(dirname(target), { recursive: true });
    await symlink(driver, target, 'dir');
    await expect(access(join(driver, 'dist/index.js'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    expect(() =>
      createRequire(join(studio, 'package.json')).resolve(
        '@ai-bdd/driver-playwright',
      ),
    ).toThrow();
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_OPTIONS: '',
      STUDIO_MEDIA_BUILD_CONTEXT: join(directory, 'worker-image'),
    };
    delete environment.STUDIO_SOURCE_REVISION;
    const result = await execute(
      process.execPath,
      ['verification/prepare-media-image.mjs'],
      {
        cwd: studio,
        env: environment,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      },
    );
    const receipt = JSON.parse(result.stdout);
    expect(receipt.playwrightCore).toBe('1.64.0');
    expect(receipt.byteSize).toBeLessThan(32 * 1024 * 1024);
    expect(
      (await readFile(join(receipt.context, 'worker.mjs'))).length,
    ).toBeGreaterThan(10000);
    expect(
      JSON.parse(
        await readFile(
          join(receipt.context, 'node_modules/playwright-core/package.json'),
          'utf8',
        ),
      ).version,
    ).toBe('1.64.0');
    await expect(access(join(driver, 'dist/index.js'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 45000);
