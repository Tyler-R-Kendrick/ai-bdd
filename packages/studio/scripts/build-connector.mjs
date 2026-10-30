import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { readFile, appendFile, stat } from 'node:fs/promises';
export async function buildConnector({
  outfile = resolve(
    fileURLToPath(new URL('../', import.meta.url)),
    'dist/connector.mjs',
  ),
} = {}) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = await build({
    entryPoints: [resolve(root, 'server/machine-worker.ts')],
    absWorkingDir: root,
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    packages: 'bundle',
    sourcemap: false,
    metafile: true,
    legalComments: 'eof',
    banner: {
      js: "import { createRequire as __studioCreateRequire } from 'node:module'; const require = __studioCreateRequire(import.meta.url);",
    },
  });
  if (
    Object.keys(result.metafile.inputs).some((path) =>
      /server\/(?:store|auth|identity|persistence|agent)\b/.test(path),
    )
  )
    throw new Error(
      'The portable connector imported the hosted server or credentials runtime',
    );
  const packages = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.includes('node_modules')) continue;
    let directory = dirname(resolve(root, input));
    while (directory !== dirname(directory)) {
      try {
        const pkg = JSON.parse(
          await readFile(join(directory, 'package.json'), 'utf8'),
        );
        if (pkg.name && pkg.version) {
          packages.set(pkg.name + '@' + pkg.version, { directory, pkg });
          break;
        }
      } catch {}
      directory = dirname(directory);
    }
  }
  const notices = [];
  for (const [name, { directory, pkg }] of [...packages].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    let license;
    for (const file of [
      'LICENSE',
      'LICENSE.md',
      'LICENSE.txt',
      'LICENCE',
      'COPYING',
    ])
      try {
        license = await readFile(join(directory, file), 'utf8');
        break;
      } catch {}
    if (!license)
      throw new Error(
        'Missing redistribution notice for bundled package ' + name,
      );
    notices.push(name + ' (' + pkg.license + ')\n' + license);
  }
  const ownLicense = await readFile(resolve(root, '../../LICENSE'), 'utf8');
  await appendFile(
    outfile,
    '\n/* Studio connector redistribution notices\n' +
      [ownLicense, ...notices].join('\n\n').replaceAll('*/', '* /') +
      '\n*/\n',
  );
  if ((await stat(outfile)).size > 12 * 1024 * 1024)
    throw new Error('The portable connector exceeds its download budget');
  return {
    outfile,
    inputs: Object.keys(result.metafile.inputs).length,
    notices: notices.length,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await buildConnector();
