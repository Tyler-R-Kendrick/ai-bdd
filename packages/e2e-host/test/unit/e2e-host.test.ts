import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateRegistration, registerSpecs, titleFor } from '../../src/index.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aibdd-e2e-host-'));
  mkdirSync(join(dir, 'specs'), { recursive: true });
  copyFileSync(join(REPO, 'fixtures/specs/billing.spec.md'), join(dir, 'specs', 'billing.spec.md'));
  copyFileSync(join(REPO, 'fixtures/specs/data-driven.spec.md'), join(dir, 'specs', 'data-driven.spec.md'));
  copyFileSync(join(REPO, 'fixtures/specs/billing.cpt'), join(dir, 'specs', 'billing.cpt'));
  copyFileSync(join(REPO, 'fixtures/specs/semantic.feature'), join(dir, 'specs', 'semantic.feature'));
  return dir;
}

describe('V2: static registration generation (e2e `run()` is not public)', () => {
  it('writes one test per scenario with stable titles', () => {
    const dir = project();
    const outFile = join(dir, 'tests', 'ai-bdd.generated.e2e.ts');
    const result = generateRegistration({ projectRoot: dir, globs: ['specs/**/*.spec.md', 'specs/**/*.feature', 'specs/**/*.cpt'], outFile });
    expect(result.tests).toBeGreaterThan(0);
    const source = readFileSync(outFile, 'utf8');
    expect(source).toContain('DO NOT EDIT');
    expect(source).toContain("import { test } from 'e2e';");
    expect(source).toContain('Workspace billing › Member upgrades to Pro');
    expect(source).toContain('await agent.act("Open billing settings")');
    expect(source).toContain('await agent.assert("The plan badge reads \\"Pro\\"", { vision: true })');
  });

  it('is deterministic: the same specs produce the same file', () => {
    const dir = project();
    const first = join(dir, 'a.ts');
    const second = join(dir, 'b.ts');
    generateRegistration({ projectRoot: dir, globs: ['specs/**/*.spec.md'], outFile: first });
    generateRegistration({ projectRoot: dir, globs: ['specs/**/*.spec.md'], outFile: second });
    expect(readFileSync(second, 'utf8')).toBe(readFileSync(first, 'utf8'));
  });
});

describe('F-E2: registration during module evaluation', () => {
  it('registers synchronously and reports the titles it produced', () => {
    const dir = project();
    const calls: Array<{ title: string; tags: string[] }> = [];
    const fakeTest = ((title: string, options: Record<string, unknown>) => {
      calls.push({ title, tags: (options.tags as string[]) ?? [] });
    }) as never;

    const registration = registerSpecs({ projectRoot: dir, globs: ['specs/**/*.spec.md', 'specs/**/*.feature', 'specs/**/*.cpt'], test: fakeTest });
    expect(registration.titles.length).toBe(calls.length);
    expect(registration.titles).toContain('Workspace billing › Member upgrades to Pro');
    expect(calls.some((call) => call.tags.includes('billing'))).toBe(true);
    expect(new Set(registration.titles).size).toBe(registration.titles.length);
  });

  it('keeps data rows distinct in the title', () => {
    const dir = project();
    const fakeTest = (() => undefined) as never;
    const registration = registerSpecs({ projectRoot: dir, globs: ['specs/data-driven.spec.md', 'specs/billing.cpt'], test: fakeTest });
    const titles = registration.titles.filter((title) => title.includes('A workspace can be seeded per row'));
    expect(titles).toHaveLength(3);
    expect(titles.some((title) => title.includes('[Acme,free]'))).toBe(true);
  });

  it('skips a spec that cannot be parsed instead of failing the collection', () => {
    const dir = project();
    writeFileSync(join(dir, 'specs', 'broken.spec.md'), 'no heading here\n* a step\n');
    const fakeTest = (() => undefined) as never;
    const registration = registerSpecs({ projectRoot: dir, globs: ['specs/broken.spec.md'], test: fakeTest });
    expect(registration.titles).toEqual([]);
    expect(registration.documents.length + registration.skipped.length).toBeGreaterThan(0);
  });

  it('produces e2e-legal titles (1..512 UTF-8 bytes)', () => {
    const long = { id: 'x', name: 'A'.repeat(400), uri: 'x', dialect: 'gauge', tags: [], options: {}, contexts: [], teardown: [], scenarios: [], diagnostics: [] } as never;
    const scenario = { id: 's', name: 'B'.repeat(400), tags: [], steps: [], options: {}, location: { uri: 'x', line: 1, column: 1 } } as never;
    const title = titleFor(long, scenario);
    expect(Buffer.byteLength(title, 'utf8')).toBeLessThanOrEqual(512);
    expect(title.length).toBeGreaterThan(0);
  });
});
