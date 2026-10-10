// @ts-nocheck
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkBoundaries, extractImports } from '../check-boundaries.mjs';
import { cleanup, makeRepo, pkg } from './fixture.mjs';

function repo(files) {
  return makeRepo({
    'packages/sdk/package.json': pkg('sdk'),
    'packages/cli/package.json': pkg('cli', { '@ai-bdd/sdk': 'workspace:*' }, { '@ai-bdd/testing': 'workspace:*', '@ai-bdd/driver-playwright': 'workspace:*' }),
    'packages/driver-playwright/package.json': pkg('driver-playwright', { '@ai-bdd/sdk': 'workspace:*' }),
    'packages/testing/package.json': pkg('testing', { '@ai-bdd/sdk': 'workspace:*' }),
    ...files,
  });
}

function problemsOf(files) {
  const root = repo(files);
  try {
    return checkBoundaries(root).problems;
  } finally {
    cleanup(root);
  }
}

test('extractImports finds static, type, re-export, dynamic and require forms and ignores comments', () => {
  const found = extractImports(`
    import a from 'a';
    import type { B } from "b";
    import { c,
      d } from './c.ts';
    import 'side-effect';
    export * from './e.ts';
    export type { F } from 'f';
    const g = await import('g');
    const h = require('h');
    // import nope from 'nope';
    /* import nope2 from 'nope2'; */
    const url = import.meta.url;
  `);
  assert.deepEqual(found.map((f) => f.spec), ['a', 'b', './c.ts', 'side-effect', './e.ts', 'f', 'g', 'h']);
  assert.equal(found.find((f) => f.spec === 'b').typeOnly, true);
  assert.equal(found.find((f) => f.spec === 'g').kind, 'dynamic');
});

test('a clean tree passes', () => {
  const p = problemsOf({
    'packages/sdk/src/index.ts': "export * from './judge/index.ts';",
    'packages/sdk/src/judge/index.ts': "import { x } from '../contracts/index.ts';\nimport { y } from './impl.ts';\nimport z from 'zod';\nexport { x, y, z };",
    'packages/sdk/src/judge/impl.ts': "import { u } from '../util/deep/file.ts';\nexport const y = u;",
    'packages/sdk/src/runner/index.ts': "import { judge } from '../judge/index.ts';\nexport { judge };",
    'packages/cli/src/main.ts': "import { engine } from '@ai-bdd/sdk';\nimport type { T } from '@ai-bdd/sdk/contracts';\nimport type { Fake } from '@ai-bdd/testing';\nexport async function load() { return (await import('@ai-bdd/testing')).x; }",
    'packages/driver-playwright/src/index.ts': "import { Driver } from '@ai-bdd/sdk/contracts';\nimport { chromium } from 'playwright-core';\nimport fs from 'node:fs';",
  });
  assert.deepEqual(p, []);
});

test('sdk sibling modules must be imported through index.ts', () => {
  const p = problemsOf({
    'packages/sdk/src/runner/index.ts': "import { a } from '../judge/impl.ts';\nimport { b } from '../plan';\nimport { c } from '../extract/index.ts';",
    'packages/sdk/src/judge/impl.ts': 'export const a = 1;',
  });
  assert.equal(p.length, 1);
  assert.match(p[0], /runner\/index\.ts:1 .*only via '\.\.\/judge\/index\.ts'/);
});

test('sdk may not leave src or import other workspace packages', () => {
  const p = problemsOf({
    'packages/sdk/src/plan/index.ts': "import a from '../../../cli/src/main.ts';\nimport b from '@ai-bdd/testing';",
  });
  assert.equal(p.length, 2);
  assert.match(p[0], /leaves packages\/sdk/);
  assert.match(p[1], /sdk must not import other workspace packages/);
});

test('non-sdk packages use only public sdk entry points and declared deps', () => {
  const p = problemsOf({
    'packages/driver-playwright/src/index.ts': [
      "import a from '@ai-bdd/sdk/src/runner/index.ts';",
      "import b from '@ai-bdd/testing';",
      "import c from '../../sdk/src/index.ts';",
      "import d from '@ai-bdd/sdk/contracts';",
    ].join('\n'),
  });
  assert.equal(p.length, 3);
  assert.match(p[0], /only '@ai-bdd\/sdk' and '@ai-bdd\/sdk\/contracts'/);
  assert.match(p[1], /not declared/);
  assert.match(p[2], /leaves packages\/driver-playwright/);
});

test('cli loads testing/driver/models only dynamically (R-SDK2)', () => {
  const p = problemsOf({
    'packages/cli/src/main.ts': "import { fake } from '@ai-bdd/testing';\nconst d = await import('@ai-bdd/driver-playwright');\nimport { engine } from '@ai-bdd/sdk';",
  });
  assert.equal(p.length, 1);
  assert.match(p[0], /main\.ts:1 .*dynamic import/);
});

test('dist imports are rejected everywhere, including tests', () => {
  const p = problemsOf({
    'packages/cli/src/main.ts': "import x from '@ai-bdd/sdk/dist/index.js';\nimport y from '../dist/main.js';",
    'packages/sdk/test/a.test.ts': "import z from '../dist/index.js';",
    'tests/acceptance/a.test.ts': "import w from '@ai-bdd/sdk/dist/x';",
  });
  assert.equal(p.length, 4);
  for (const line of p) assert.match(line, /dist\//);
});

test('test files may import internals', () => {
  const p = problemsOf({
    'packages/sdk/test/runner/a.test.ts': "import { internal } from '../../src/judge/impl.ts';\nimport { fake } from '@ai-bdd/testing';",
    'packages/cli/test/b.test.ts': "import { fake } from '@ai-bdd/testing';\nimport x from '@ai-bdd/sdk/src/anything';",
    'tests/acceptance/c.test.ts': "import x from '../../packages/sdk/src/judge/impl.ts';",
  });
  assert.deepEqual(p, []);
});

test('import-looking text inside a template literal is not an import', () => {
  const found = extractImports("export const T = `import { x } from '@ai-bdd/driver-playwright';\nexport default {};`;\nimport real from 'real';\nconst d = import(`dyn`);");
  assert.deepEqual(found.map((f) => f.spec), ['real', 'dyn']);
});

test('extractImports folds concatenations, consts and escapes and reports non-literal specifiers as null', () => {
  const found = extractImports("const a = '@ai-bdd/sdk/';\nawait import(a + 'src/x.ts');\nawait import('\\x40ai-bdd\\u002fsdk');\nawait import(process.env.X);\nconst re = /`/;\nimport q from 'after-regex';\nimport.meta.resolve('r');\ncreateRequire(import.meta.url)('cr');");
  assert.deepEqual(found.map((f) => [f.kind, f.spec]), [['dynamic', '@ai-bdd/sdk/src/x.ts'], ['dynamic', '@ai-bdd/sdk'], ['dynamic', null], ['static', 'after-regex'], ['resolve', 'r'], ['require', 'cr'], ['createRequire', null]]);
});

test('computed specifiers, createRequire and file: URLs are reported in sources but not in tests', () => {
  const p = problemsOf({
    'packages/cli/src/a.ts': "export const a = await import(process.env['X']);\nimport { createRequire } from 'node:module';\nexport const r = createRequire(import.meta.url);",
    'packages/cli/src/b.ts': "export const b = await import('file:///elsewhere/x.ts');\nexport const c = await import('@ai-bdd/sdk/' + 'src/a.ts');",
    'packages/cli/test/c.test.ts': "export const d = await import(process.env['X']);\nconst s = \"import x from '@ai-bdd/sdk/dist/a'\";",
  });
  assert.equal(p.length, 4);
  assert.match(p[0], /a\.ts:1 .*not a static string/);
  assert.match(p[1], /a\.ts:3 .*createRequire/);
  assert.match(p[2], /b\.ts:1 .*leaves packages\/cli/);
  assert.match(p[3], /b\.ts:2 .*public entry points/);
});
