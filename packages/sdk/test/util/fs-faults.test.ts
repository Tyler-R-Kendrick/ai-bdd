import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertInsideRealRoot, atomicWriteFile, sweepStaleTemps } from '../../src/util/index.ts';

// Failures that a real file system rarely produces on demand are injected through thin pass-through wrappers.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    readdir: vi.fn(actual.readdir),
    rm: vi.fn(actual.rm),
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
  };
});

const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const UUID = '6c9a874a-6f0c-46b7-af7a-151f83570bc0';
const UUID2 = '0d2820de-16ca-4919-8600-3b8c004c6185';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-bdd-faults-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fsp.lstat).mockImplementation(real.lstat);
  vi.mocked(fsp.readdir).mockImplementation(real.readdir as never);
  vi.mocked(fsp.rm).mockImplementation(real.rm);
  vi.mocked(fsp.open).mockImplementation(real.open);
  vi.mocked(fsp.rename).mockImplementation(real.rename);
  vi.mocked(fsp.lstat).mockClear();
  vi.mocked(fsp.readdir).mockClear();
  vi.mocked(fsp.rm).mockClear();
  vi.mocked(fsp.open).mockClear();
  vi.mocked(fsp.rename).mockClear();
  rmSync(dir, { recursive: true, force: true });
});

describe('assertInsideRealRoot: faults while resolving', () => {
  it('stops at the file system root when nothing on the way up exists', async () => {
    let calls = 0;
    vi.mocked(fsp.lstat).mockImplementation((async () => {
      calls += 1;
      if (calls > 100) throw new Error('runaway: the walk up never ended');
      throw errno('ENOENT');
    }) as never);
    await expect(assertInsideRealRoot(join(dir, 'a', 'b'), join(dir, 'a'))).resolves.toBeUndefined();
    await expect(assertInsideRealRoot(join(dir, 'c'), join(dir, 'a'))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('rethrows a failure that is not an error object as it is', async () => {
    vi.mocked(fsp.lstat).mockRejectedValueOnce(null);
    await expect(assertInsideRealRoot(join(dir, 'x'), dir)).rejects.toBeNull();
    vi.mocked(fsp.lstat).mockRejectedValueOnce('plain string');
    await expect(assertInsideRealRoot(join(dir, 'x'), dir)).rejects.toBe('plain string');
  });

  it('rethrows an object that carries no error code', async () => {
    const odd = { message: 'odd' };
    vi.mocked(fsp.lstat).mockRejectedValueOnce(odd);
    await expect(assertInsideRealRoot(join(dir, 'x'), dir)).rejects.toBe(odd);
  });

  it('rethrows other file system errors such as EACCES', async () => {
    vi.mocked(fsp.lstat).mockRejectedValueOnce(errno('EACCES'));
    await expect(assertInsideRealRoot(join(dir, 'x'), dir)).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('treats ENOENT and ENOTDIR alike: both mean the path is not there yet', async () => {
    for (const code of ['ENOENT', 'ENOTDIR']) {
      vi.mocked(fsp.lstat).mockRejectedValueOnce(errno(code));
      await expect(assertInsideRealRoot(join(dir, 'x', 'y'), dir)).resolves.toBeUndefined();
    }
  });
});

describe('sweepStaleTemps: liveness of the owning process', () => {
  const stale = (pid: number, name = 'plan.json', uuid = UUID): string => `${name}.${pid}.${uuid}.tmp`;

  it('keeps the temp file of a process that exists but belongs to someone else (EPERM), removes those of processes that are gone (ESRCH)', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      throw errno(pid === 4_000_002 ? 'EPERM' : 'ESRCH');
    }) as never);
    const gone = stale(4_000_001);
    const foreign = stale(4_000_002, 'plan.json', UUID2);
    writeFileSync(join(dir, gone), 'x');
    writeFileSync(join(dir, foreign), 'x');

    expect(await sweepStaleTemps(dir)).toBe(1);
    expect(readdirSync(dir)).toEqual([foreign]);
    expect(kill).toHaveBeenCalledWith(4_000_001, 0);
    expect(kill).toHaveBeenCalledWith(4_000_002, 0);
  });

  it('never touches the temp files of this very process, without asking whether it is alive', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw errno('ESRCH');
    }) as never);
    const own = stale(process.pid);
    writeFileSync(join(dir, own), 'in flight');

    expect(await sweepStaleTemps(dir)).toBe(0);
    expect(readFileSync(join(dir, own), 'utf8')).toBe('in flight');
    expect(kill).not.toHaveBeenCalled();
  });

  it('counts a file that vanished between the listing and the removal and goes on with the others', async () => {
    vi.spyOn(process, 'kill').mockImplementation((() => {
      throw errno('ESRCH');
    }) as never);
    const names = [stale(4_000_001), stale(4_000_001, 'other.json', UUID2), stale(4_000_003)];
    vi.mocked(fsp.readdir).mockResolvedValueOnce(names as never);

    expect(await sweepStaleTemps(dir)).toBe(3);
    expect(vi.mocked(fsp.rm)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fsp.rm)).toHaveBeenCalledWith(join(dir, names[0] as string), { force: true });
  });

  it('stops quietly when a removal fails for another reason, reporting what it removed so far', async () => {
    vi.spyOn(process, 'kill').mockImplementation((() => {
      throw errno('ESRCH');
    }) as never);
    writeFileSync(join(dir, stale(4_000_001)), 'x');
    writeFileSync(join(dir, stale(4_000_002, 'b.json', UUID2)), 'x');
    vi.mocked(fsp.rm).mockImplementationOnce(real.rm).mockRejectedValueOnce(errno('EBUSY'));

    expect(await sweepStaleTemps(dir)).toBe(1);
    expect(vi.mocked(fsp.rm)).toHaveBeenCalledTimes(2);
  });
});

describe('atomicWriteFile: failure paths', () => {
  const target = (): string => join(dir, 'out.json');

  it('closes the file handle after a successful write, before renaming', async () => {
    const order: string[] = [];
    vi.mocked(fsp.open).mockImplementationOnce((async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      const close = fh.close.bind(fh);
      fh.close = async () => {
        order.push('close');
        await close();
      };
      return fh;
    }) as never);
    vi.mocked(fsp.rename).mockImplementationOnce((async (from: string, to: string) => {
      order.push('rename');
      await real.rename(from, to);
    }) as never);

    await atomicWriteFile(target(), 'data');
    expect(order).toEqual(['close', 'rename']);
    expect(readFileSync(target(), 'utf8')).toBe('data');
  });

  it('closes the handle and removes the temp file when the write fails, rethrowing the write error', async () => {
    const diskFull = new Error('disk full');
    let closed = 0;
    vi.mocked(fsp.open).mockImplementationOnce((async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      const close = fh.close.bind(fh);
      fh.writeFile = async () => {
        throw diskFull;
      };
      fh.close = async () => {
        closed += 1;
        await close();
      };
      return fh;
    }) as never);

    await expect(atomicWriteFile(target(), 'data')).rejects.toBe(diskFull);
    expect(closed).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
    expect(vi.mocked(fsp.rename)).not.toHaveBeenCalled();
  });

  it('cleans up with force: a temp file that is already gone does not replace the original error', async () => {
    const diskFull = new Error('disk full');
    vi.mocked(fsp.open).mockImplementationOnce((async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      fh.writeFile = async () => {
        await real.rm(args[0] as string); // somebody else removed the temp file
        throw diskFull;
      };
      return fh;
    }) as never);

    await expect(atomicWriteFile(target(), 'data')).rejects.toBe(diskFull);
    expect(vi.mocked(fsp.rm)).toHaveBeenCalledWith(expect.stringMatching(/out\.json\.\d+\.[0-9a-f-]{36}\.tmp$/), { force: true });
  });

  it('removes the temp file and keeps the old content when the rename fails', async () => {
    writeFileSync(target(), 'old');
    const failure = errno('EXDEV');
    vi.mocked(fsp.rename).mockRejectedValueOnce(failure);

    await expect(atomicWriteFile(target(), 'new')).rejects.toBe(failure);
    expect(readdirSync(dir)).toEqual(['out.json']);
    expect(readFileSync(target(), 'utf8')).toBe('old');
  });
});
