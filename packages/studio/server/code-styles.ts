import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { compile } from 'tailwindcss';
import { projectPath, type CodeProject } from '../shared/code-project.ts';

const require = createRequire(import.meta.url);
const trusted = new Map([
  ['index.css', require.resolve('tailwindcss/index.css')],
  ['theme.css', require.resolve('tailwindcss/theme.css')],
  ['preflight.css', require.resolve('tailwindcss/preflight.css')],
  ['utilities.css', require.resolve('tailwindcss/utilities.css')],
]);
const prefix = '/studio-vfs/';

/** Compile static utility candidates against this artifact's bounded VFS only. */
export async function compileCodeStyles(
  path: string,
  files: CodeProject['files'],
): Promise<string> {
  const css = files[path]!;
  if (!/tailwind|@(?:theme|utility|apply|variant|custom-variant)\b/.test(css))
    return css;
  const check = (source: string) => {
    for (const match of source.matchAll(
      /@import\s+(?:url\(\s*)?["']?([^"'\s)]+)/gi,
    )) {
      const id = match[1]!;
      if (
        !id.startsWith('.') &&
        id !== 'tailwindcss' &&
        !id.startsWith('tailwindcss/')
      )
        throw new Error(
          'Preview stylesheet imports must be local or built-in Tailwind styles',
        );
    }
    if (/@source\b/.test(source))
      throw new Error(
        'Tailwind @source is unavailable: preview candidates come from project files',
      );
    if (/@(?:plugin|config)\b/.test(source))
      throw new Error(
        'Tailwind JavaScript plugins and configuration are unavailable in previews',
      );
  };
  check(css);
  let imports = 0;
  const compiler = await compile(css, {
    base: prefix + posix.dirname(path),
    loadModule: async () => {
      throw new Error(
        'Tailwind previews cannot execute JavaScript plugins or configuration',
      );
    },
    loadStylesheet: async (id, base) => {
      if (++imports > 50)
        throw new Error('Too many Tailwind stylesheet imports');
      let builtin: string | undefined;
      if (id === 'tailwindcss') builtin = 'index.css';
      else if (id.startsWith('tailwindcss/')) builtin = id.slice(12);
      else if (base === '/studio-tailwind' && id.startsWith('./'))
        builtin = id.slice(2);
      if (builtin) {
        if (!builtin.endsWith('.css')) builtin += '.css';
        const installed = trusted.get(builtin);
        if (!installed)
          throw new Error('Unrecognized built-in Tailwind stylesheet');
        return {
          path: '/studio-tailwind/' + builtin,
          base: '/studio-tailwind',
          content: await readFile(installed, 'utf8'),
        };
      }
      if (!base.startsWith(prefix) || !id.startsWith('.'))
        throw new Error(
          'Preview stylesheets must be local project files or built-in Tailwind styles',
        );
      const local = projectPath(base.slice(prefix.length) + '/entry.css', id);
      if (!local || !local.endsWith('.css') || !Object.hasOwn(files, local))
        throw new Error(
          'Tailwind stylesheet is missing or leaves the project',
        );
      const content = files[local]!;
      check(content);
      return {
        path: prefix + local,
        base: prefix + posix.dirname(local),
        content,
      };
    },
  });
  const candidates = new Set<string>();
  for (const [name, source] of Object.entries(files)) {
    if (!/\.(?:html?|[cm]?js|jsx|tsx?)$/i.test(name)) continue;
    for (const match of source.matchAll(/[^\s"'`{}<>=;]+/g)) {
      const token = match[0];
      if (token.length <= 256) candidates.add(token);
      if (candidates.size > 20_000)
        throw new Error(
          'Preview exceeds the 20,000 static Tailwind candidate limit',
        );
    }
  }
  const output = compiler.build([...candidates]);
  if (Buffer.byteLength(output) > 1_500_000)
    throw new Error(
      'Generated Tailwind stylesheet exceeds the 1.5 MB preview limit',
    );
  return output;
}
