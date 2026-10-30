// Whitelisted, bounded build context. No repository/worktree, credentials, package manager store, or runtime install.
import { build } from 'esbuild';
import { createRequire, builtinModules } from 'node:module';
import {
  cp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
  readdir,
  lstat,
  mkdtemp,
} from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const studio = resolve(import.meta.dirname, '..'),
  repo = resolve(studio, '../..'),
  require = createRequire(join(studio, 'package.json'));
const context = process.env.STUDIO_MEDIA_BUILD_CONTEXT
  ? resolve(process.env.STUDIO_MEDIA_BUILD_CONTEXT)
  : await mkdtemp(join(tmpdir(), 'studio-media-image-'));
if (process.env.STUDIO_MEDIA_BUILD_CONTEXT)
  await mkdir(context, { recursive: false, mode: 0o700 });
const modules = join(context, 'node_modules');
await mkdir(modules);
const entry = join(studio, 'server/media/worker.ts');
const result = await build({
  entryPoints: [entry],
  outfile: join(context, 'worker.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  metafile: true,
  external: ['playwright-core'],
  banner: {
    js: 'import { createRequire as __studioMediaRequire } from "node:module"; const require = __studioMediaRequire(import.meta.url);',
  },
});
for (const output of Object.values(result.metafile.outputs))
  for (const item of output.imports)
    if (
      !item.path.startsWith('node:') &&
      !builtinModules.includes(item.path) &&
      !['playwright-core'].includes(item.path)
    )
      throw new Error('Unexpected external worker dependency: ' + item.path);
const driver = createRequire(require.resolve('@ai-bdd/driver-playwright'));
const playwrightRoot = dirname(
  driver.resolve('playwright-core/package.json'),
);
const pkg = JSON.parse(
  await readFile(join(playwrightRoot, 'package.json'), 'utf8'),
);
if (pkg.version !== '1.64.0')
  throw new Error(
    'Media worker requires the lockfile-pinned Playwright Core1.64.0',
  );
await cp(playwrightRoot, join(modules, 'playwright-core'), {
  recursive: true,
  dereference: false,
});
const fontFile = require.resolve(
  '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
);
await copyFile(fontFile, join(context, 'inter.woff2'));
await copyFile(
  join(dirname(dirname(fontFile)), 'LICENSE'),
  join(context, 'FONT_LICENSE'),
);
await copyFile(join(repo, 'pnpm-lock.yaml'), join(context, 'pnpm-lock.yaml'));
await copyFile(
  join(studio, 'server/media/build-manifest.mjs'),
  join(context, 'build-manifest.mjs'),
);
await copyFile(join(studio, 'media.Dockerfile'), join(context, 'Dockerfile'));
await copyFile(
  join(studio, 'media.Dockerfile.dockerignore'),
  join(context, '.dockerignore'),
);
await writeFile(
  join(context, 'package.json'),
  JSON.stringify({
    name: 'studio-media-worker-image',
    private: true,
    type: 'module',
    dependencies: { 'playwright-core': '1.64.0' },
  }),
);
const notices = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  let directory = dirname(resolve(process.cwd(), input));
  if (!directory.includes('/node_modules/')) continue;
  while (directory.includes('/node_modules/')) {
    try {
      const data = JSON.parse(
        await readFile(join(directory, 'package.json'), 'utf8'),
      );
      if (data.name && data.version) {
        const key = data.name + '@' + data.version;
        if (!notices.has(key)) {
          const files = [];
          for (const file of await readdir(directory))
            if (/^(LICENSE|COPYING|NOTICE|OFL)(\.[a-zA-Z]+)?$/i.test(file))
              files.push({
                file,
                text: await readFile(join(directory, file), 'utf8'),
              });
          notices.set(key, {
            name: data.name,
            version: data.version,
            license: data.license ?? null,
            files,
          });
        }
        break;
      }
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}
await writeFile(
  join(context, 'THIRD_PARTY_NOTICES.json'),
  JSON.stringify([...notices.values()], null, 2),
);
await copyFile(join(repo, 'LICENSE'), join(context, 'STUDIO_LICENSE'));
let byteSize = 0,
  files = 0;
async function inspect(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name),
      stat = await lstat(path);
    if (stat.isSymbolicLink())
      throw new Error('Image build context may not contain symlinks');
    if (stat.isDirectory()) await inspect(path);
    else {
      files++;
      byteSize += stat.size;
    }
  }
}
await inspect(context);
if (byteSize > 32 * 1024 * 1024)
  throw new Error('Whitelisted worker image context exceeds32MiB');
const worker = await readFile(join(context, 'worker.mjs'));
const sourceBuild = {
  schemaVersion: 1,
  workerSha256: createHash('sha256').update(worker).digest('hex'),
  playwrightCore: pkg.version,
  sourceRevision: process.env.STUDIO_SOURCE_REVISION ?? null,
};
const sourceBytes = Buffer.from(JSON.stringify(sourceBuild, null, 2));
await writeFile(join(context, 'source-build.json'), sourceBytes);
byteSize += sourceBytes.length;
files++;
if (byteSize > 32 * 1024 * 1024)
  throw new Error('Whitelisted worker image context exceeds32MiB');
const receipt = { ...sourceBuild, context, files, byteSize };
console.log(JSON.stringify(receipt));
