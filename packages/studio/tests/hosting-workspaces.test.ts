import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiskObjectStore } from '../server/hosting/disk-objects.ts';
import { ObjectWorkspaceStore } from '../server/hosting/workspaces.ts';
import { objectDigest } from '../server/hosting/objects.ts';
const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'studio-workspace-'));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe('durable workspace object manifests', () => {
  it('restores plans/evidence across fresh adapter instances without storing environment secrets', async () => {
    const path = await root(),
      source = join(path, 'source');
    await mkdir(join(source, 'plans'), { recursive: true });
    await writeFile(join(source, 'plans', 'plan.json'), '{"verified":true}');
    await writeFile(join(source, 'evidence.png'), Buffer.from([1, 2, 3, 4]));
    await writeFile(join(source, '.env'), 'TEST_ONLY_SECRET=excluded');
    const objects = new DiskObjectStore(join(path, 'objects'));
    const saved = await new ObjectWorkspaceStore(objects).save(
      'artifact-1',
      source,
    );
    expect(saved.files).toBe(2);
    await rm(source, { recursive: true });
    const target = join(path, 'restored');
    await mkdir(target);
    await new ObjectWorkspaceStore(
      new DiskObjectStore(join(path, 'objects')),
    ).restore(saved, target);
    expect(await readFile(join(target, 'plans', 'plan.json'), 'utf8')).toBe(
      '{"verified":true}',
    );
    expect(await readFile(join(target, 'evidence.png'))).toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
    await expect(readFile(join(target, '.env'))).rejects.toThrow();
    const bytes = await objects.get(saved.key, { maxBytes: 10000 });
    expect(Buffer.from(bytes!.bytes).toString()).not.toContain(
      'TEST_ONLY_SECRET',
    );
    await expect(
      new ObjectWorkspaceStore(objects).restore(saved, target),
    ).rejects.toThrow('empty');
  });
  it('rejects traversal in an integrity-valid manifest before writing outside staging', async () => {
    const path = await root(),
      objects = new DiskObjectStore(join(path, 'objects'));
    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        files: [
          {
            path: '../outside.txt',
            key: 'studio/one',
            byteSize: 1,
            sha256: '0'.repeat(64),
          },
        ],
      }),
    );
    await objects.put('studio/bad-manifest.json', body, {
      contentType: 'application/json',
    });
    await expect(
      new ObjectWorkspaceStore(objects).restore(
        {
          key: 'studio/bad-manifest.json',
          sha256: objectDigest(body),
          files: 1,
          byteSize: 1,
        },
        join(path, 'target'),
      ),
    ).rejects.toThrow('unsafe');
    await expect(readFile(join(path, 'outside.txt'))).rejects.toThrow();
  });
  it('refuses source symlinks instead of archiving an unrelated host file', async () => {
    const path = await root(),
      source = join(path, 'source');
    await mkdir(source);
    await writeFile(join(path, 'outside.txt'), 'not part of the artifact');
    await symlink(join(path, 'outside.txt'), join(source, 'linked.txt'));
    await expect(
      new ObjectWorkspaceStore(new DiskObjectStore(join(path, 'objects'))).save(
        'artifact-1',
        source,
      ),
    ).rejects.toThrow('symbolic');
  });
});
