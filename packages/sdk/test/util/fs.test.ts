import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiBddError } from '../../src/contracts/index.ts';
import { assertInsideRealRoot, toPosix } from '../../src/util/index.ts';

const windows = process.platform === 'win32';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ai-bdd-fs-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function denial(target: string, root?: string): Promise<AiBddError> {
  const err = await assertInsideRealRoot(target, root).then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(AiBddError);
  return err as AiBddError;
}

describe('assertInsideRealRoot: paths against an explicit root', () => {
  it('accepts the root itself and existing or missing paths below it, however deep', async () => {
    const root = join(dir, 'proj');
    mkdirSync(join(root, 'sub'), { recursive: true });
    await expect(assertInsideRealRoot(root, root)).resolves.toBeUndefined();
    await expect(assertInsideRealRoot(join(root, 'sub'), root)).resolves.toBeUndefined();
    await expect(assertInsideRealRoot(join(root, 'sub', 'new'), root)).resolves.toBeUndefined();
    await expect(assertInsideRealRoot(join(root, 'a', 'b', 'c', 'file.json'), root)).resolves.toBeUndefined();
  });

  it('refuses the parent of the root, a grandparent, a sibling and a sibling whose name starts with the root name, with the documented error', async () => {
    const root = join(dir, 'proj');
    mkdirSync(root);
    mkdirSync(join(dir, 'proj-evil'));
    for (const target of [dir, join(dir, '..'), join(dir, 'other'), join(dir, 'proj-evil'), join(dir, 'proj-evil', 'x'), join(root, '..', 'elsewhere')]) {
      const err = await denial(target, root);
      expect(err.code).toBe('POLICY_DENIED');
      expect(err.message).toBe(`refusing to write outside the project through a symlink: ${toPosix(resolve(target))}`);
      expect(err.details).toEqual({ path: toPosix(resolve(target)) });
      expect(err.retryable).toBe(false);
    }
  });

  it('refuses a path that merely leaves the root by ../ segments', async () => {
    const root = join(dir, 'proj');
    mkdirSync(root);
    const target = `${root}/sub/../../escape`;
    const err = await denial(target, root);
    expect(err.details).toEqual({ path: toPosix(join(dir, 'escape')) });
  });

  it('does not mistake a name that starts with two dots for leaving the root', async () => {
    const root = join(dir, 'proj');
    mkdirSync(join(root, '..data'), { recursive: true });
    await expect(assertInsideRealRoot(join(root, '..data'), root)).resolves.toBeUndefined();
    await expect(assertInsideRealRoot(join(root, '..data', 'x'), root)).resolves.toBeUndefined();
    await expect(assertInsideRealRoot(join(root, '..new', 'x'), root)).resolves.toBeUndefined();
    await expect(assertInsideRealRoot(join(root, '...'), root)).resolves.toBeUndefined();
  });

  it('works when neither the root nor the target exists yet', async () => {
    const root = join(dir, 'fresh');
    await expect(assertInsideRealRoot(root, root)).resolves.toBeUndefined();
    await expect(assertInsideRealRoot(join(root, 'a', 'b'), root)).resolves.toBeUndefined();
    await expect(assertInsideRealRoot(join(root, 'a', 'b', 'c', 'd'), join(root, 'a'))).resolves.toBeUndefined();
    const err = await denial(join(dir, 'other'), root);
    expect(err.code).toBe('POLICY_DENIED');
    await denial(root, join(root, 'a', 'b'));
    await denial(join(root, 'a'), join(root, 'a', 'b'));
    await denial(join(root, 'a', 'c'), join(root, 'a', 'b'));
  });

  it('keeps the order of missing path segments', async () => {
    await expect(assertInsideRealRoot(join(dir, 'r', 'a', 'b'), join(dir, 'r'))).resolves.toBeUndefined();
    await denial(join(dir, 'r', 'b', 'a'), join(dir, 'r', 'a', 'b'));
  });

  it('treats a path below a regular file as a missing path, not as an error', async () => {
    writeFileSync(join(dir, 'file'), 'x');
    await expect(assertInsideRealRoot(join(dir, 'file', 'sub', 'x'), dir)).resolves.toBeUndefined();
    await denial(join(dir, 'file', 'sub'), join(dir, 'other'));
  });

  it('missing path segments are appended as they are: a root that happens to contain a look-alike path is not confused with the target', async () => {
    // the target is an existing directory that the missing root would only resemble if its segments were rewritten
    const root = join(dir, 'x');
    mkdirSync(join(dir, 'Stryker was here!x'));
    await denial(join(dir, 'Stryker was here!x'), root);

    const mirror = join(dir, dir.slice(1), 'x');
    mkdirSync(mirror, { recursive: true });
    await denial(mirror, root);
  });

  it.skipIf(windows)('keeps backslashes of a missing top-level name (only leading separators are stripped)', async () => {
    const stem = `ai-bdd-fs-missing-${process.pid}`;
    await denial(`/${stem}b`, `/${stem}\\b`);
    await expect(assertInsideRealRoot(`/${stem}\\b/x`, `/${stem}\\b`)).resolves.toBeUndefined();
  });
});

describe.skipIf(windows)('assertInsideRealRoot: symlinks', () => {
  it('refuses a missing path below a symlink that leaves the root, and the symlink itself', async () => {
    const root = join(dir, 'proj');
    const outside = join(dir, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'link'));
    const missing = await denial(join(root, 'link', 'new', 'deep.json'), root);
    expect(missing.code).toBe('POLICY_DENIED');
    expect(missing.message).toBe(`refusing to write outside the project through a symlink: ${toPosix(join(root, 'link', 'new', 'deep.json'))}`);
    expect(missing.details).toEqual({ path: toPosix(join(root, 'link', 'new', 'deep.json')) });
    await denial(join(root, 'link'), root);
    await denial(join(root, 'link', 'existing'), root);
  });

  it('accepts a symlink that stays inside the root', async () => {
    const root = join(dir, 'proj');
    mkdirSync(join(root, 'real'), { recursive: true });
    symlinkSync(join(root, 'real'), join(root, 'alias'));
    await expect(assertInsideRealRoot(join(root, 'alias', 'new', 'x'), root)).resolves.toBeUndefined();
  });

  it('resolves symlinks in the root as well', async () => {
    const real = join(dir, 'real');
    mkdirSync(join(real, 'proj'), { recursive: true });
    symlinkSync(real, join(dir, 'alias'));
    await expect(assertInsideRealRoot(join(real, 'proj', 'x'), join(dir, 'alias', 'proj'))).resolves.toBeUndefined();
    await expect(assertInsideRealRoot(join(dir, 'alias', 'proj', 'x'), join(real, 'proj'))).resolves.toBeUndefined();
    await denial(join(real, 'other', 'x'), join(dir, 'alias', 'proj'));
  });

  it('a symlinked ancestor of a root that does not exist yet is not mistaken for an escape', async () => {
    const real = join(dir, 'real');
    mkdirSync(real);
    symlinkSync(real, join(dir, 'alias'));
    await expect(assertInsideRealRoot(join(dir, 'alias', 'proj', 'out', 'x'), join(dir, 'alias', 'proj'))).resolves.toBeUndefined();
  });

  it('rethrows an error that is not "missing", such as a symlink loop', async () => {
    symlinkSync(join(dir, 'b'), join(dir, 'a'));
    symlinkSync(join(dir, 'a'), join(dir, 'b'));
    const err = (await assertInsideRealRoot(join(dir, 'a', 'x'), dir).then(() => undefined, (e: unknown) => e)) as NodeJS.ErrnoException;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AiBddError);
    expect(err.code).toBe('ELOOP');
  });
});

describe('assertInsideRealRoot: the default root', () => {
  it('is the directory that holds the .ai-bdd segment', async () => {
    const proj = join(dir, 'proj');
    mkdirSync(join(proj, '.ai-bdd'), { recursive: true });
    await expect(assertInsideRealRoot(join(proj, '.ai-bdd', 'runs', 'r1'))).resolves.toBeUndefined();
    await expect(assertInsideRealRoot(join(proj, '.ai-bdd'))).resolves.toBeUndefined();
  });

  it.skipIf(windows)('refuses a .ai-bdd directory, or a directory below it, that is a symlink out of the project', async () => {
    const proj = join(dir, 'proj');
    const outside = join(dir, 'outside');
    mkdirSync(proj);
    mkdirSync(join(outside, 'deeper'), { recursive: true });
    symlinkSync(outside, join(proj, '.ai-bdd'));
    const err = await denial(join(proj, '.ai-bdd', 'runs'));
    expect(err.code).toBe('POLICY_DENIED');
    expect(err.details).toEqual({ path: toPosix(join(proj, '.ai-bdd', 'runs')) });
    await denial(join(proj, '.ai-bdd'));
    await denial(join(proj, '.ai-bdd', 'deeper', 'x', 'y'));
  });

  it.skipIf(windows)('refuses a symlink below .ai-bdd that leaves the project', async () => {
    const proj = join(dir, 'proj');
    mkdirSync(join(proj, '.ai-bdd'), { recursive: true });
    mkdirSync(join(dir, 'outside'));
    symlinkSync(join(dir, 'outside'), join(proj, '.ai-bdd', 'link'));
    await denial(join(proj, '.ai-bdd', 'link', 'file'));
    await expect(assertInsideRealRoot(join(proj, '.ai-bdd', 'plain', 'file'))).resolves.toBeUndefined();
  });

  it.skipIf(windows)('is the directory of the LAST .ai-bdd segment', async () => {
    const proj = join(dir, 'proj');
    const inner = join(proj, '.ai-bdd', 'sub');
    mkdirSync(join(inner, '.ai-bdd'), { recursive: true });
    mkdirSync(join(dir, 'outside'));
    symlinkSync(join(dir, 'outside'), join(inner, '.ai-bdd', 'link'));
    await denial(join(inner, '.ai-bdd', 'link', 'x'));
    // the nearer root is `inner`; a link from `inner` to `proj` stays outside of it
    symlinkSync(proj, join(inner, '.ai-bdd', 'up'));
    await denial(join(inner, '.ai-bdd', 'up', 'x'));
  });

  it('does not check a path without a .ai-bdd segment', async () => {
    mkdirSync(join(dir, 'outside'));
    if (!windows) {
      mkdirSync(join(dir, 'proj'));
      symlinkSync(join(dir, 'outside'), join(dir, 'proj', 'link'));
      await expect(assertInsideRealRoot(join(dir, 'proj', 'link', 'x'))).resolves.toBeUndefined();
      await expect(assertInsideRealRoot(join(dir, 'proj', 'link'))).resolves.toBeUndefined();
    }
    await expect(assertInsideRealRoot(join(dir, 'anything', 'goes'))).resolves.toBeUndefined();
  });

  it.skipIf(windows)('a .ai-bdd directly under the file system root has the file system root as its root', async () => {
    await expect(assertInsideRealRoot('/.ai-bdd/x')).resolves.toBeUndefined();
  });

  it('an explicit root wins over the inferred one, including when no .ai-bdd segment would infer any', async () => {
    const root = join(dir, 'root');
    mkdirSync(join(dir, 'proj', '.ai-bdd'), { recursive: true });
    mkdirSync(root);
    await denial(join(dir, 'proj', '.ai-bdd', 'x'), root);
    await denial(join(dir, 'plain', 'x'), root);
    await expect(assertInsideRealRoot(join(root, 'x'), root)).resolves.toBeUndefined();
  });
});
