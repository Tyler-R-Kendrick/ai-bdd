/** Browser-safe project paths and file operations shared by the code editor/compiler. */
export type CodeProject = { files: Record<string, string>; entry: string };
export const CODE_FILE_LIMIT = 50;
export const CODE_SOURCE_LIMIT = 2_000_000;
export const executableFile = (path: string) =>
  /\.(?:[cm]?js|jsx|tsx?)$/i.test(path);
export const entryFile = (path: string) =>
  /\.(?:html?|[cm]?js|jsx|tsx?)$/i.test(path);
export function validCodePath(path: string) {
  return (
    /^[a-zA-Z0-9_./-]{1,200}$/.test(path) &&
    !path.startsWith('/') &&
    !path.includes('..') &&
    !path.endsWith('/') &&
    !path.split('/').some((part) => !part) &&
    !path
      .split('/')
      .some((part) => ['node_modules', '.git', '__proto__'].includes(part))
  );
}
export function checkCodeProject(project: CodeProject): CodeProject {
  if (
    !project ||
    typeof project !== 'object' ||
    typeof project.entry !== 'string' ||
    !project.files ||
    typeof project.files !== 'object' ||
    Array.isArray(project.files)
  )
    throw new Error('Choose a code project with files and an entry path');
  const names = Object.keys(project.files);
  if (!names.length || names.length > CODE_FILE_LIMIT)
    throw new Error('Projects support 1–50 files');
  if (!entryFile(project.entry) || !Object.hasOwn(project.files, project.entry))
    throw new Error(
      'Choose an existing HTML, JavaScript, JSX, or TypeScript entry file',
    );
  let size = 0;
  for (const path of names) {
    const source = project.files[path];
    if (!validCodePath(path))
      throw new Error(`Invalid project file path: ${path}`);
    if (
      typeof source !== 'string' ||
      new TextEncoder().encode(source).length > 500_000
    )
      throw new Error(`File ${path} exceeds the 500 KB source limit`);
    size += new TextEncoder().encode(source).length;
  }
  if (size > CODE_SOURCE_LIMIT)
    throw new Error('Code project exceeds the 2 MB source limit');
  return { files: project.files, entry: project.entry };
}
export function projectPath(from: string, reference: string): string | null {
  const result = reference.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const segment of reference.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!result.length) return null;
      result.pop();
    } else result.push(segment);
  }
  return result.join('/');
}
export function resolveProjectFile(
  files: Record<string, string>,
  from: string,
  reference: string,
) {
  if (!(reference.startsWith('.') || reference.startsWith('/'))) return null;
  const path = projectPath(from, reference);
  if (!path) return null;
  for (const candidate of [
    path,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css'].map(
      (ext) => path + ext,
    ),
    ...['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.json'].map(
      (name) => path + '/' + name,
    ),
  ])
    if (Object.hasOwn(files, candidate)) return candidate;
  return null;
}
function relativeFile(from: string, target: string) {
  const directory = from.split('/').slice(0, -1),
    parts = target.split('/');
  while (directory.length && parts.length && directory[0] === parts[0]) {
    directory.shift();
    parts.shift();
  }
  const path = [...directory.map(() => '..'), ...parts].join('/');
  return path.startsWith('.') ? path : './' + path;
}
/** Rename literal local imports and HTML/CSS references; no package or external URL rewrites. */
export function renameCodeFile(
  project: CodeProject,
  before: string,
  after: string,
): CodeProject {
  if (!Object.hasOwn(project.files, before))
    throw new Error('The selected file no longer exists');
  if (!validCodePath(after))
    throw new Error(
      'Choose a relative project file path without parent traversal',
    );
  if (before === after) return project;
  if (Object.hasOwn(project.files, after))
    throw new Error('A file with this name already exists');
  const files: Record<string, string> = {};
  for (const [name, source] of Object.entries(project.files)) {
    const renamed = name === before ? after : name;
    const replace = (
      prefix: string,
      quote: string,
      specifier: string,
      suffix: string,
    ) => {
      const reference =
        specifier.startsWith('.') || specifier.startsWith('/')
          ? specifier
          : './' + specifier;
      const target = resolveProjectFile(project.files, name, reference);
      if (!target || (target !== before && name !== before))
        return prefix + quote + specifier + quote + suffix;
      let updated = relativeFile(renamed, target === before ? after : target);
      if (
        !/\.[a-z0-9]+$/i.test(specifier) &&
        /\.(?:tsx?|jsx?|mjs|cjs)$/i.test(updated)
      )
        updated = updated.replace(/\.(?:tsx?|jsx?|mjs|cjs)$/i, '');
      if (
        !specifier.startsWith('.') &&
        !specifier.startsWith('/') &&
        !prefix.includes('from') &&
        !prefix.includes('import') &&
        !prefix.includes('require')
      )
        updated = updated.replace(/^\.\//, '');
      return prefix + quote + updated + quote + suffix;
    };
    let updated = source;
    if (/\.(?:[cm]?js|jsx|tsx?)$/i.test(name))
      updated = source.replace(
        /(\b(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s*))(['"])([^'"\r\n]+)\2()/g,
        (_all, prefix, quote, specifier, suffix) => {
          if (!(specifier.startsWith('.') || specifier.startsWith('/')))
            return _all;
          return replace(prefix, quote, specifier, suffix);
        },
      );
    if (/\.html?$/i.test(name))
      updated = updated.replace(
        /(\b(?:src|href)\s*=\s*)(['"])([^'"\r\n]+)\2()/gi,
        (_all, prefix, quote, specifier, suffix) =>
          /^([a-z]+:|#|\/\/)/i.test(specifier)
            ? _all
            : replace(prefix, quote, specifier, suffix),
      );
    if (/\.css$/i.test(name))
      updated = updated.replace(
        /(\burl\(\s*)(['"])([^'"\r\n]+)\2(\s*\))/gi,
        (_all, prefix, quote, specifier, suffix) =>
          /^([a-z]+:|#|\/\/)/i.test(specifier)
            ? _all
            : replace(prefix, quote, specifier, suffix),
      );
    files[renamed] = updated;
  }
  return checkCodeProject({
    files,
    entry: project.entry === before ? after : project.entry,
  });
}
export function reactStarter(): CodeProject {
  return {
    entry: 'src/App.tsx',
    files: {
      'src/App.tsx': `import { useState } from 'react';\nimport { Plus, Minus } from 'lucide-react';\nimport './style.css';\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return <main><h1>Make something useful.</h1><p>React and TypeScript, ready to edit. Your service contracts work without live integrations.</p><div className="counter"><button aria-label="Decrease" onClick={() => setCount(n => n - 1)}><Minus size={18}/></button><output>{count}</output><button aria-label="Increase" onClick={() => setCount(n => n + 1)}><Plus size={18}/></button></div></main>;\n}\n`,
      'src/style.css': `*{box-sizing:border-box}body{margin:0;background:#f8f9f5;color:#24292e;font:16px system-ui,sans-serif}main{max-width:680px;margin:14vh auto;padding:32px}h1{font-size:42px;line-height:1.15;letter-spacing:-.035em;margin:20px 0}p{line-height:1.8;max-width:54ch}.counter{display:flex;align-items:center;gap:24px;margin-top:32px}button{display:grid;place-items:center;width:44px;height:44px;border:1px solid #d9ded3;border-radius:6px;background:white;color:inherit;cursor:pointer}button:hover{background:#eceee8}button:focus-visible{outline:3px solid #6b73d1;outline-offset:3px}output{font-size:24px;font-variant-numeric:tabular-nums;min-width:3ch;text-align:center}`,
      'README.md':
        '# React artifact\n\nEdit src/App.tsx to begin. The entry can export a React component or mount its own interface. Supported packages are installed locally by the workspace; package scripts are never executed. Add contracts.json to replay integration boundaries.\n',
    },
  };
}
