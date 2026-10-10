import { inflateSync } from 'node:zlib';

export interface Raster { width: number; height: number; channels: number; data: Uint8Array }

/** Minimal PNG decoder for 8-bit, non-interlaced RGB/RGBA images (what Chromium screenshots are). */
export function decodePng(png: Uint8Array): Raster {
  const buf = Buffer.from(png);
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const colorType = body.readUInt8(9);
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
      if (body.readUInt8(8) !== 8 || body.readUInt8(12) !== 0 || channels === 0) throw new Error('unsupported PNG');
    } else if (type === 'IDAT') idat.push(body);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x += 1) {
      const cur = raw[y * (stride + 1) + 1 + x] ?? 0;
      const a = x >= channels ? (out[y * stride + x - channels] ?? 0) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= channels && y > 0 ? (out[(y - 1) * stride + x - channels] ?? 0) : 0;
      let v: number;
      switch (filter) {
        case 1: v = cur + a; break;
        case 2: v = cur + b; break;
        case 3: v = cur + Math.floor((a + b) / 2); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: v = cur;
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

export function pixel(r: Raster, x: number, y: number): [number, number, number] {
  const i = (y * r.width + x) * r.channels;
  return [r.data[i] ?? 0, r.data[i + 1] ?? 0, r.data[i + 2] ?? 0];
}

/** Bounding box of pixels that differ between two rasters of equal size, or undefined when identical. */
export function diffBox(a: Raster, b: Raster): { x0: number; y0: number; x1: number; y1: number } | undefined {
  if (a.width !== b.width || a.height !== b.height) throw new Error('size mismatch');
  let box: { x0: number; y0: number; x1: number; y1: number } | undefined;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const [r1, g1, b1] = pixel(a, x, y);
      const [r2, g2, b2] = pixel(b, x, y);
      if (r1 === r2 && g1 === g2 && b1 === b2) continue;
      box = box === undefined ? { x0: x, y0: y, x1: x, y1: y } : { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) };
    }
  }
  return box;
}
