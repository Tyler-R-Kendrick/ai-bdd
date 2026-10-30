import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  ObjectStore,
  WorkspaceReference,
  WorkspaceStore,
} from './ports.ts';
import { objectDigest, ObjectIntegrityError } from './objects.ts';

const MAX_FILES = 2000,
  MAX_FILE = 64 * 1024 * 1024,
  MAX_WORKSPACE = 256 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const fileSchema = z
  .object({
    path: z.string().min(1).max(512),
    key: z.string().min(1).max(1024),
    byteSize: z.number().int().min(0).max(MAX_FILE),
    sha256: digest,
  })
  .strict();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    files: z.array(fileSchema).max(MAX_FILES),
  })
  .strict();
function safeRelative(path: string) {
  if (
    !path ||
    path.length > 512 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    Array.from(path).some((character) => character.charCodeAt(0) < 32) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Workspace manifest contains an unsafe relative path.');
  return path;
}
function excluded(path: string) {
  return path
    .split('/')
    .some(
      (part) =>
        part === '.git' ||
        part === 'node_modules' ||
        /^\.env(?:\.|$)/.test(part) ||
        /\.(?:key|pem|p12)$/i.test(part),
    );
}
async function filesWithin(directory: string) {
  const result: { path: string; absolute: string; size: number }[] = [];
  let total = 0;
  async function visit(path: string, depth: number) {
    if (depth > 12)
      throw new Error('Workspace nesting exceeds its snapshot limit.');
    const entries = (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name, 'en'),
    );
    for (const entry of entries) {
      const absolute = resolve(path, entry.name),
        name = relative(directory, absolute).split(sep).join('/');
      safeRelative(name);
      if (entry.isSymbolicLink())
        throw new Error('Workspace snapshots do not follow symbolic links.');
      if (excluded(name)) continue;
      if (entry.isDirectory()) await visit(absolute, depth + 1);
      else if (entry.isFile()) {
        const stat = await lstat(absolute);
        if (stat.size > MAX_FILE)
          throw new Error('One workspace file exceeds64 MB.');
        total += stat.size;
        result.push({ path: name, absolute, size: stat.size });
        if (result.length > MAX_FILES || total > MAX_WORKSPACE)
          throw new Error(
            'Workspace exceeds its2,000-file/256 MB snapshot limit.',
          );
      } else throw new Error('Workspace snapshots contain only regular files.');
    }
  }
  const rootStat = await lstat(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error('Workspace source must be a real directory.');
  await visit(directory, 0);
  return result;
}
/** Restores immutable work products into disposable staging, never a database snapshot. */
export class ObjectWorkspaceStore implements WorkspaceStore {
  readonly provider: string;
  constructor(readonly objects: ObjectStore) {
    this.provider = objects.provider;
  }
  async save(
    workspaceId: string,
    directory: string,
  ): Promise<WorkspaceReference> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(workspaceId))
      throw new Error('Invalid workspace identity.');
    const root = resolve(directory);
    const sources = await filesWithin(root);
    const files: z.infer<typeof fileSchema>[] = [];
    for (const source of sources) {
      const file = await open(
        source.absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let bytes: Buffer;
      try {
        const chunks: Buffer[] = [];
        let length = 0;
        while (true) {
          const part = Buffer.alloc(65536);
          const read = await file.read(part);
          if (!read.bytesRead) break;
          length += read.bytesRead;
          if (length > source.size || length > MAX_FILE)
            throw new Error(
              'A workspace file grew beyond its snapshot byte bound.',
            );
          chunks.push(part.subarray(0, read.bytesRead));
        }
        bytes = Buffer.concat(chunks, length);
      } finally {
        await file.close();
      }
      if (bytes.length !== source.size || bytes.length > MAX_FILE)
        throw new Error('A workspace file changed during snapshotting.');
      const sha256 = objectDigest(bytes),
        key = `studio/v1/workspaces/${workspaceId}/objects/${sha256}`;
      await this.objects.put(key, bytes, {
        contentType: 'application/octet-stream',
      });
      files.push({ path: source.path, key, byteSize: bytes.length, sha256 });
    }
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files }));
    const sha256 = objectDigest(bytes),
      key = `studio/v1/workspaces/${workspaceId}/manifests/${sha256}.json`;
    await this.objects.put(key, bytes, { contentType: 'application/json' });
    return {
      key,
      sha256,
      files: files.length,
      byteSize: files.reduce((sum, file) => sum + file.byteSize, 0),
    };
  }
  async restore(reference: WorkspaceReference, directory: string) {
    const object = await this.objects.get(reference.key, {
      maxBytes: 4 * 1024 * 1024,
      expectedSha256: reference.sha256,
    });
    if (!object) throw new Error('The durable workspace manifest is missing.');
    const manifest = manifestSchema.parse(
      JSON.parse(Buffer.from(object.bytes).toString()),
    );
    if (
      manifest.files.length !== reference.files ||
      manifest.files.reduce((sum, file) => sum + file.byteSize, 0) !==
        reference.byteSize ||
      reference.byteSize > MAX_WORKSPACE
    )
      throw new ObjectIntegrityError(
        'Workspace manifest totals do not match its durable reference.',
      );
    const unique = new Set<string>();
    for (const file of manifest.files) {
      safeRelative(file.path);
      if (excluded(file.path) || unique.has(file.path))
        throw new Error(
          'Workspace manifest contains an excluded or repeated path.',
        );
      unique.add(file.path);
    }
    const target = resolve(directory);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      const stat = await lstat(target);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await readdir(target)).length
      )
        throw new Error(
          'Restore requires a new or empty disposable workspace directory.',
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const staging = target + '.restoring-' + randomUUID();
    await mkdir(staging, { mode: 0o700 });
    try {
      for (const file of manifest.files) {
        const value = await this.objects.get(file.key, {
          maxBytes: file.byteSize,
          expectedSha256: file.sha256,
        });
        if (!value || value.byteSize !== file.byteSize)
          throw new ObjectIntegrityError(
            'A durable workspace file is missing or changed.',
          );
        const destination = resolve(staging, file.path);
        if (!destination.startsWith(staging + sep))
          throw new Error('Workspace path leaves staging.');
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const output = await open(destination, 'wx', 0o600);
        try {
          await output.writeFile(value.bytes);
        } finally {
          await output.close();
        }
      }
      await rmdir(target).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      await rename(staging, target);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
}
