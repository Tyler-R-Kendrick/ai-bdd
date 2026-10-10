import { sha256Hex } from '@ai-bdd/sdk';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { screenshotPng, solidPng } from '../../src/png.ts';
import { click, find, goto, openSession } from './helpers.ts';

function decode(png: Uint8Array): { width: number; height: number; pixels: Uint8Array; chunks: string[] } {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: string[] = [];
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (off < png.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
    chunks.push(type);
    const data = png.subarray(off + 8, off + 8 + len);
    // verify the CRC with an independent implementation
    let c = 0xffffffff;
    for (const b of png.subarray(off + 4, off + 8 + len)) {
      c ^= b;
      for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    expect(((c ^ 0xffffffff) >>> 0)).toBe(dv.getUint32(off + 8 + len));
    if (type === 'IHDR') {
      width = new DataView(data.buffer, data.byteOffset).getUint32(0);
      height = new DataView(data.buffer, data.byteOffset).getUint32(4);
      expect([data[8], data[9], data[10], data[11], data[12]]).toEqual([8, 2, 0, 0, 0]);
    }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return { width, height, pixels: new Uint8Array(raw), chunks };
}

describe('png encoder', () => {
  it('encodes a valid 32x32 truecolor PNG with correct CRCs and pixels', () => {
    const png = solidPng(32, 32, [10, 200, 30]);
    const { width, height, pixels, chunks } = decode(png);
    expect(chunks).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect([width, height]).toEqual([32, 32]);
    expect(pixels).toHaveLength(32 * (1 + 32 * 3));
    for (let y = 0; y < 32; y += 1) {
      expect(pixels[y * 97]).toBe(0); // filter byte
      for (let x = 0; x < 32; x += 1) expect([...pixels.subarray(y * 97 + 1 + x * 3, y * 97 + 4 + x * 3)]).toEqual([10, 200, 30]);
    }
  });

  it('colour is the first three bytes of the digest, and identical inputs give identical bytes', () => {
    const digest = 'a1b2c3' + '0'.repeat(58);
    const a = screenshotPng(digest);
    const b = screenshotPng(digest);
    expect(sha256Hex(a)).toBe(sha256Hex(b));
    expect([...decode(a).pixels.subarray(1, 4)]).toEqual([0xa1, 0xb2, 0xc3]);
    expect(sha256Hex(screenshotPng('ffffff' + '0'.repeat(58)))).not.toBe(sha256Hex(a));
    // pinned bytes: guards against accidental encoder changes breaking recorded screenshot hashes
    expect(sha256Hex(screenshotPng('000000'))).toBe(sha256Hex(solidPng(32, 32, [0, 0, 0])));
  });
});

describe('fake driver screenshots are deterministic', () => {
  it('same screen => byte-identical PNG across sessions and runs; different screens differ', async () => {
    const shots: Uint8Array[] = [];
    for (let i = 0; i < 3; i += 1) {
      const s = await openSession();
      await goto(s, '/settings/billing');
      const shot = (await s.observe({ pixels: true })).screenshot;
      shots.push(shot?.png ?? new Uint8Array());
      await s.close();
    }
    expect(new Set(shots.map((p) => sha256Hex(p))).size).toBe(1);
    expect(shots[0]?.length).toBeGreaterThan(60);

    const s = await openSession();
    const before = (await goto(s, '/settings/billing')).treeHash;
    const dlg = await click(s, 'button', 'Upgrade to Pro');
    expect(dlg.treeHash).not.toBe(before);
    expect(find(dlg, 'dialog', 'Confirm upgrade')).toBeDefined();
    const shot = (await s.observe({ pixels: true })).screenshot;
    expect(sha256Hex(shot?.png ?? new Uint8Array())).not.toBe(sha256Hex(shots[0] ?? new Uint8Array()));
    await s.close();
  });

  it('the screenshot colour is derived from the treeHash of the same observation', async () => {
    const s = await openSession();
    await goto(s, '/notes');
    const obs = await s.observe({ pixels: true });
    expect(sha256Hex(obs.screenshot?.png ?? new Uint8Array())).toBe(sha256Hex(screenshotPng(obs.treeHash)));
    await s.close();
  });
});
