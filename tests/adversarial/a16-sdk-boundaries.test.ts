// Attack 16: the CLI or an integration importing SDK internals (R-SDK2).
// Three independent lines of attack: (1) an AST-based audit of the real source (not the regex scanner the repository uses),
// (2) the runtime package export map, (3) evasion attempts against scripts/check-boundaries.mjs itself.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './helpers/kit.ts';

const PACKAGES = ['sdk', 'cli', 'driver-playwright', 'models-ai-sdk', 'playwright-test', 'testing'] as const;
const WORKSPACE_PUBLIC = new Set(['@ai-bdd/sdk', '@ai-bdd/sdk/contracts']);

interface Found { file: string; line: number; spec: string | null; expr: string; kind: 'import' | 'export' | 'dynamic' | 'require' | 'createRequire' | 'resolve'; typeOnly: boolean }

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'dist') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.[cm]?[jt]sx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Every module reference of a source file, found on the TypeScript AST. `spec` is null for non-literal arguments. */
function references(file: string): Found[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Found[] = [];
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const lit = (n: ts.Expression | undefined): string | null => (n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const typeOnly = clause?.isTypeOnly === true;
      out.push({ file, line: lineOf(node), spec: lit(node.moduleSpecifier), expr: node.moduleSpecifier.getText(sf), kind: 'import', typeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      out.push({ file, line: lineOf(node), spec: lit(node.moduleSpecifier), expr: node.moduleSpecifier.getText(sf), kind: 'export', typeOnly: node.isTypeOnly });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      out.push({ file, line: lineOf(node), spec: lit(node.moduleReference.expression), expr: node.moduleReference.expression.getText(sf), kind: 'require', typeOnly: node.isTypeOnly });
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      if (callee.kind === ts.SyntaxKind.ImportKeyword) out.push({ file, line: lineOf(node), spec: lit(arg), expr: arg?.getText(sf) ?? '', kind: 'dynamic', typeOnly: false });
      else if (ts.isIdentifier(callee) && callee.text === 'require') out.push({ file, line: lineOf(node), spec: lit(arg), expr: arg?.getText(sf) ?? '', kind: 'require', typeOnly: false });
      else if (ts.isIdentifier(callee) && callee.text === 'createRequire') out.push({ file, line: lineOf(node), spec: null, expr: node.getText(sf), kind: 'createRequire', typeOnly: false });
      else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve' && callee.expression.getText(sf) === 'import.meta') out.push({ file, line: lineOf(node), spec: lit(arg), expr: arg?.getText(sf) ?? '', kind: 'resolve', typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Resolve `const name = 'literal'` visible in the file (used to vet `import(name)`). */
function constStrings(file: string): Map<string, string> {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const map = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))) {
      const prev = map.get(node.name.text);
      map.set(node.name.text, prev === undefined ? node.initializer.text : `${prev}\u0000${node.initializer.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

function declaredWorkspace(pkg: string): Set<string> {
  const json = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', pkg, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
  const names = new Set<string>();
  for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) for (const n of Object.keys(json[key] ?? {})) if (n.startsWith('@ai-bdd/')) names.add(n);
  return names;
}

describe('A16 R-SDK2 AST audit of the real sources', () => {
  const problems: string[] = [];
  const unverifiable: string[] = [];
  const seen: Record<string, number> = {};
  for (const pkg of PACKAGES) {
    const root = join(REPO_ROOT, 'packages', pkg);
    const files = walk(join(root, 'src'));
    seen[pkg] = files.length;
    const declared = declaredWorkspace(pkg);
    for (const file of files) {
      const consts = constStrings(file);
      for (const ref of references(file)) {
        const where = `${relative(REPO_ROOT, file)}:${ref.line} ${ref.kind} ${ref.expr}`;
        let specs: string[];
        if (ref.spec !== null) specs = [ref.spec];
        else {
          const names = consts.get(ref.expr.trim());
          if (names !== undefined) specs = names.split('\u0000');
          else if (ref.kind === 'dynamic' && pkg === 'sdk' && /\bs\b|specifier|file|url|href/i.test(ref.expr)) {
            // the config loader imports the USER's config / driver packages by file URL: not an SDK internal
            continue;
          } else {
            unverifiable.push(where);
            continue;
          }
        }
        for (const spec of specs) {
          if (/(^|\/)dist(\/|$)/.test(spec)) problems.push(`${where}: imports from dist`);
          if (spec.startsWith('@ai-bdd/')) {
            const [, name = '', ...rest] = spec.split('/');
            const target = `@ai-bdd/${name}`;
            if (target === `@ai-bdd/${pkg}`) {
              if (pkg === 'sdk' && rest.length > 0 && spec !== '@ai-bdd/sdk/contracts') problems.push(`${where}: sdk deep-imports itself`);
              continue;
            }
            if (pkg === 'sdk') problems.push(`${where}: sdk imports another workspace package`);
            else if (target === '@ai-bdd/sdk') {
              if (!WORKSPACE_PUBLIC.has(spec)) problems.push(`${where}: ${spec} is not a public SDK entry point`);
            } else {
              if (!declared.has(target)) problems.push(`${where}: ${target} is not declared in package.json`);
              if (rest.length > 0) problems.push(`${where}: only the root entry point of ${target} may be imported`);
              if (pkg === 'cli' && (ref.kind === 'import' || ref.kind === 'export') && !ref.typeOnly) problems.push(`${where}: cli must load ${target} dynamically`);
            }
          } else if (spec.startsWith('.')) {
            const resolved = resolve(dirname(file), spec);
            if (relative(root, resolved).startsWith('..')) problems.push(`${where}: relative import leaves packages/${pkg}`);
          }
        }
        if (ref.kind === 'createRequire') unverifiable.push(where);
      }
    }
  }

  it('A16 R-SDK2: every package was scanned (the audit is not vacuous)', () => {
    for (const pkg of PACKAGES) expect(seen[pkg] ?? 0, pkg).toBeGreaterThan(0);
    expect(seen['sdk']).toBeGreaterThan(40);
  });

  it('A16 R-SDK2: no package reaches an SDK internal, a dist directory, an undeclared workspace package or out of its own directory', () => {
    expect(problems).toEqual([]);
  });

  it('A16 R-SDK2: every non-literal import() / require / createRequire in the sources resolves to a vetted constant', () => {
    expect(unverifiable).toEqual([]);
  });

  it('A16 R-SDK2: the CLI loads @ai-bdd/testing, the Playwright driver and the AI SDK adapter only through dynamic import', () => {
    const cliFiles = walk(join(REPO_ROOT, 'packages', 'cli', 'src'));
    const staticValue = cliFiles.flatMap((f) => references(f)).filter((r) => (r.kind === 'import' || r.kind === 'export') && !r.typeOnly && r.spec !== null && r.spec.startsWith('@ai-bdd/') && r.spec !== '@ai-bdd/sdk' && r.spec !== '@ai-bdd/sdk/contracts');
    expect(staticValue.map((r) => `${relative(REPO_ROOT, r.file)}:${r.line} ${r.spec}`)).toEqual([]);
  });

  it('A16 R-SDK2: the integration package uses the SDK and the Playwright driver only through their root entry points', () => {
    const refs = walk(join(REPO_ROOT, 'packages', 'playwright-test', 'src')).flatMap((f) => references(f)).filter((r) => r.spec?.startsWith('@ai-bdd/'));
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(['@ai-bdd/sdk', '@ai-bdd/sdk/contracts', '@ai-bdd/driver-playwright'], `${relative(REPO_ROOT, r.file)}:${r.line}`).toContain(r.spec);
  });
});

describe('A16 R-SDK2 runtime package boundaries', () => {
  const probe = (spec: string, cwd: string): string => {
    const code = `try { await import(${JSON.stringify(spec)}); console.log('LOADED'); } catch (e) { console.log(e && e.code ? e.code : String(e)); }`;
    return execFileSync(process.execPath, ['--conditions=source', '--no-warnings', '--input-type=module', '-e', code], { cwd, encoding: 'utf8', timeout: 60_000 }).trim();
  };

  it('A16 R-SDK2: the SDK export map exposes only "." and "./contracts"', () => {
    const json = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'sdk', 'package.json'), 'utf8')) as { exports: Record<string, unknown> };
    expect(Object.keys(json.exports).sort()).toEqual(['.', './contracts']);
  });

  const deep = ['@ai-bdd/sdk/src/runner/index.ts', '@ai-bdd/sdk/src/runner/steps.ts', '@ai-bdd/sdk/dist/index.js', '@ai-bdd/sdk/package.json', '@ai-bdd/sdk/src/contracts/index.ts'];
  for (const spec of deep) {
    it(`A16 R-SDK2: node refuses to load ${spec} from the CLI package (ERR_PACKAGE_PATH_NOT_EXPORTED)`, () => {
      expect(probe(spec, join(REPO_ROOT, 'packages', 'cli'))).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
    });
  }

  it('A16 R-SDK2: the two public entry points do load', () => {
    expect(probe('@ai-bdd/sdk', join(REPO_ROOT, 'packages', 'cli'))).toBe('LOADED');
    expect(probe('@ai-bdd/sdk/contracts', join(REPO_ROOT, 'packages', 'cli'))).toBe('LOADED');
  });
});

describe('A16 R-SDK2 evading scripts/check-boundaries.mjs', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  interface Check { checkBoundaries(root: string): { ok: boolean; problems: string[] } }
  async function checker(): Promise<Check> {
    const path = join(REPO_ROOT, 'scripts', 'check-boundaries.mjs');
    return (await import(/* @vite-ignore */ path)) as Check;
  }

  function repoWith(file: string, source: string): string {
    const root = mkdtempSync(join(tmpdir(), 'a16-'));
    roots.push(root);
    const put = (rel: string, content: string): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    };
    put('packages/sdk/package.json', JSON.stringify({ name: '@ai-bdd/sdk', version: '0.0.0' }));
    put('packages/sdk/src/index.ts', 'export const x = 1;\n');
    put('packages/sdk/src/runner/steps.ts', 'export const steps = 1;\n');
    put('packages/cli/package.json', JSON.stringify({ name: '@ai-bdd/cli', version: '0.0.0', dependencies: { '@ai-bdd/sdk': 'workspace:*' } }));
    put(`packages/cli/src/${file}`, source);
    return root;
  }

  it('A16 R-SDK2: the real repository passes the repository scanner (control)', async () => {
    const res = (await checker()).checkBoundaries(REPO_ROOT);
    expect(res.problems).toEqual([]);
  });

  const evasions: [string, string, boolean][] = [
    // [label, source of packages/cli/src/evil.ts, must be reported]
    ['control: deep static import', "import { runStep } from '@ai-bdd/sdk/src/runner/steps.ts';\nexport const a = runStep;\n", true],
    ['control: relative escape into the sdk sources', "import { steps } from '../../sdk/src/runner/steps.ts';\nexport const a = steps;\n", true],
    ['control: dist import', "export const a = await import('@ai-bdd/sdk/dist/index.js');\n", true],
    ['control: re-export of a deep path', "export * from '@ai-bdd/sdk/src/runner/steps.ts';\n", true],
    ['control: require of a deep path', "const a = require('@ai-bdd/sdk/src/runner/steps.ts');\nexport { a };\n", true],
    ['control: legal public import is not reported', "import type { Engine } from '@ai-bdd/sdk/contracts';\nexport type A = Engine;\n", false],
    ['computed specifier (string concatenation)', "export const a = await import('@ai-bdd/sdk/' + 'src/runner/steps.ts');\n", true],
    ['specifier held in a variable', "const target = '@ai-bdd/sdk/src/runner/steps.ts';\nexport const a = await import(target);\n", true],
    ['template literal with a substitution', "const name = 'steps';\nexport const a = await import(`@ai-bdd/sdk/src/runner/${name}.ts`);\n", true],
    ['createRequire', "import { createRequire } from 'node:module';\nexport const a = createRequire(import.meta.url)('@ai-bdd/sdk/src/runner/steps.ts');\n", true],
    ['import.meta.resolve then import', "const url = import.meta.resolve('@ai-bdd/sdk/src/runner/steps.ts');\nexport const a = await import(url);\n", true],
    ['unicode escape inside the specifier', "export const a = await import('@ai-bdd\\u002fsdk/src/runner/steps.ts');\n", true],
    ['hex escape inside the specifier', "export const a = await import('\\x40ai-bdd/sdk/src/runner/steps.ts');\n", true],
    ['import hidden after a regular expression literal that contains a backtick', "const re = /`/;\nimport { steps } from '@ai-bdd/sdk/src/runner/steps.ts';\nconst t = `ok ${re}`;\nexport const a = steps;\n", true],
    ['import hidden inside a template literal substitution', "export const a = `${await import('@ai-bdd/sdk/src/runner/steps.ts')}`;\n", true],
    ['import after a regex literal that ends a line comment sequence', "const re = /https?:\\/\\//; export const a = await import('@ai-bdd/sdk/src/runner/steps.ts');\n", true],
    ['relative escape written with a backslash', "export const a = await import('..\\\\..\\\\sdk\\\\src\\\\runner\\\\steps.ts');\n", true],
    ['file URL to the sibling package', "export const a = await import('file:///repo/packages/sdk/src/runner/steps.ts');\n", true],
  ];

  for (const [label, source, mustReport] of evasions) {
    it(`A16 R-SDK2: ${label} -> ${mustReport ? 'reported' : 'accepted'}`, async () => {
      const root = repoWith('evil.ts', source);
      const res = (await checker()).checkBoundaries(root);
      expect(res.problems.length > 0, `problems: ${JSON.stringify(res.problems)}`).toBe(mustReport);
    });
  }
});
