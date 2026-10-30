import { describe, it, expect } from 'vitest';
import { readFile, access } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
const repository = resolve(import.meta.dirname, '../../..');
describe('Vercel container monorepo build context', () => {
  it('includes every local COPY input in the actual Dockerfile-directory context', async () => {
    const config = JSON.parse(
      await readFile(resolve(repository, 'vercel.json'), 'utf8'),
    );
    const backend = config.services.backend;
    expect(backend.runtime).toBe('container');
    const file = resolve(
      repository,
      backend.root,
      backend.entrypoint.split('#')[0],
    );
    const context = dirname(file),
      source = await readFile(file, 'utf8');
    expect(context).toBe(repository);
    const inputs: string[] = [];
    for (const line of source.split('\n')) {
      const match = line.match(/^COPY\s+(?!.*--from=)(.+)$/i);
      if (!match) continue;
      const values = match[1]!
        .trim()
        .split(/\s+/)
        .filter((value) => !value.startsWith('--'));
      for (const input of values.slice(0, -1)) {
        const absolute = resolve(context, input);
        expect(relative(context, absolute).startsWith('..')).toBe(false);
        await expect(
          access(absolute),
          input + ' is absent from the platform build context',
        ).resolves.toBeUndefined();
        inputs.push(input);
      }
    }
    expect(inputs).toContain('pnpm-lock.yaml');
    expect(inputs).toContain('pnpm-workspace.yaml');
    expect(inputs).toContain('packages/studio/package.json');
  });
  it('uses default root ignore rules for Buildah and Docker while keeping local and CI entrypoints aligned', async () => {
    const ignored = (
      await readFile(resolve(repository, '.dockerignore'), 'utf8')
    ).split('\n');
    for (const path of [
      '.git',
      '**/node_modules',
      '**/.env',
      '**/.env.*',
      '**/.vercel',
      'work',
    ])
      expect(ignored).toContain(path);
    const config = JSON.parse(
      await readFile(resolve(repository, 'vercel.json'), 'utf8'),
    );
    const file = config.services.backend.entrypoint;
    const workflow = await readFile(
      resolve(repository, '.github/workflows/studio.yml'),
      'utf8',
    );
    const compose = await readFile(
      resolve(repository, 'docker-compose.studio.yml'),
      'utf8',
    );
    expect(workflow).toContain('file: ' + file);
    expect(compose).toContain('dockerfile: ' + file);
  });
});
