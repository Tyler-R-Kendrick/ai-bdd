import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiBddError } from '../../src/contracts/index.ts';
import { atomicWriteFile, raceAbort, sweepStaleTemps } from '../../src/util/index.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-bdd-atomic-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const UUID = '6c9a874a-6f0c-46b7-af7a-151f83570bc0';
const UUID2 = '0d2820de-16ca-4919-8600-3b8c004c6185';

/** A process id that certainly belonged to a process that has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.pid === undefined) throw new Error('no pid');
  return child.pid;
}

describe('sweepStaleTemps', () => {
  it('removes temp files of dead processes only: not live ones, not this process, not files that merely look similar', async () => {
    const dead = deadPid();
    const stale = `plan.json.${dead}.${UUID}.tmp`;
    const staleOther = `other.json.${dead}.${UUID2}.tmp`;
    const live = `plan.json.${process.ppid}.${UUID}.tmp`;
    const own = `plan.json.${process.pid}.${UUID2}.tmp`;
    const lookalikes = ['notes.tmp', `plan.json.${dead}.not-a-uuid.tmp`, `plan.json.${dead}.${UUID}.tmp.bak`, `plan.json.abc.${UUID}.tmp`, 'plan.json'];
    for (const name of [stale, staleOther, live, own, ...lookalikes]) writeFileSync(join(dir, name), 'x');

    expect(await sweepStaleTemps(dir)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([live, own, ...lookalikes].sort());
  });

  it('never throws: a missing directory is zero files', async () => {
    expect(await sweepStaleTemps(join(dir, 'does-not-exist'))).toBe(0);
  });
});

describe('atomicWriteFile', () => {
  it('writes the whole content via a temp file that is gone afterwards', async () => {
    await atomicWriteFile(join(dir, 'a', 'b.json'), '{"x":1}\n');
    expect(readFileSync(join(dir, 'a', 'b.json'), 'utf8')).toBe('{"x":1}\n');
    expect(readdirSync(join(dir, 'a'))).toEqual(['b.json']);
  });

  it('a write that fails halfway (here: data the file cannot take) leaves no temp file behind and the previous content intact', async () => {
    const target = join(dir, 'keep.json');
    writeFileSync(target, 'old');
    await expect(atomicWriteFile(target, 123 as unknown as string)).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(['keep.json']);
    expect(readFileSync(target, 'utf8')).toBe('old');
  });

  it('with sweep, debris left by an interrupted write of ANY file in the directory is removed; without it, debris stays', async () => {
    const dead = deadPid();
    mkdirSync(join(dir, 'recs'));
    const debris = join(dir, 'recs', `other.json.${dead}.${UUID}.tmp`);
    writeFileSync(debris, '{"torn');
    await atomicWriteFile(join(dir, 'recs', 'a.json'), '1');
    expect(readdirSync(join(dir, 'recs')).sort()).toEqual(['a.json', `other.json.${dead}.${UUID}.tmp`].sort());
    await atomicWriteFile(join(dir, 'recs', 'a.json'), '2', { sweep: true });
    expect(readdirSync(join(dir, 'recs'))).toEqual(['a.json']);
    expect(readFileSync(join(dir, 'recs', 'a.json'), 'utf8')).toBe('2');
  });

  it('does not sweep the temp file of a concurrent live writer (this process)', async () => {
    const own = join(dir, `x.json.${process.pid}.${UUID}.tmp`);
    writeFileSync(own, 'in flight');
    await atomicWriteFile(join(dir, 'y.json'), 'y', { sweep: true });
    expect(readFileSync(own, 'utf8')).toBe('in flight');
  });
});

describe('raceAbort', () => {
  it('without a signal it is the promise itself', async () => {
    const p = Promise.resolve(7);
    expect(raceAbort(p, undefined, 'x')).toBe(p);
  });

  it('passes the result or the error through when the call settles first, and stops listening', async () => {
    const c = new AbortController();
    await expect(raceAbort(Promise.resolve('ok'), c.signal, 'call')).resolves.toBe('ok');
    const boom = new Error('boom');
    await expect(raceAbort(Promise.reject(boom), c.signal, 'call')).rejects.toBe(boom);
    c.abort(); // nothing is listening any more: no unhandled rejection, no effect
    await new Promise((r) => setImmediate(r));
  });

  it('rejects with ABORTED as soon as the signal fires while the call never returns', async () => {
    const c = new AbortController();
    const never = new Promise<string>(() => {});
    const p = raceAbort(never, c.signal, 'driver perform');
    setTimeout(() => c.abort(), 5);
    const err = (await p.then(() => undefined, (e: unknown) => e)) as AiBddError;
    expect(err).toBeInstanceOf(AiBddError);
    expect(err.code).toBe('ABORTED');
    expect(err.message).toBe('driver perform aborted');
  });

  it('an already aborted signal rejects at once, and the abandoned call\'s late failure is not an unhandled rejection', async () => {
    const c = new AbortController();
    c.abort();
    let rejectLate: (e: Error) => void = () => {};
    const late = new Promise<string>((_, reject) => {
      rejectLate = reject;
    });
    const p = raceAbort(late, c.signal, 'model call');
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
    rejectLate(new Error('too late'));
    await new Promise((r) => setImmediate(r));
  });

  it('the abandoned call\'s late result or failure after an abort is dropped silently', async () => {
    const c = new AbortController();
    let rejectLate: (e: Error) => void = () => {};
    const late = new Promise<string>((_, reject) => {
      rejectLate = reject;
    });
    const p = raceAbort(late, c.signal, 'driver observe');
    c.abort();
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
    rejectLate(new Error('too late'));
    await new Promise((r) => setImmediate(r));
  });
});
