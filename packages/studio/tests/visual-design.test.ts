import { describe, expect, it } from 'vitest';
import {
  fontDesignSchema,
  layerAppearanceSchema,
  pathData,
  vectorPathSchema,
} from '../shared/visual-design.ts';
import {
  buildTrueType,
  createFontDesign,
} from '../client/editors/visual/typeface.ts';
import { removeEdgeColor } from '../client/editors/visual/raster.ts';
import {
  newLayer,
  svgSource,
  type VisualContent,
} from '../client/editors/visual/render.ts';

describe('editable vector and raster sources', () => {
  it('rejects malformed geometry and crops outside their authenticated source image', () => {
    expect(
      layerAppearanceSchema.safeParse({
        crop: { x: 0.8, y: 0, width: 0.5, height: 1 },
      }).success,
    ).toBe(false);
    expect(layerAppearanceSchema.safeParse({ opacity: Infinity }).success).toBe(
      false,
    );
    expect(
      vectorPathSchema.safeParse({
        viewWidth: 100,
        viewHeight: 100,
        closed: true,
        contours: [
          [
            { x: 0, y: 0 },
            { x: '<script>', y: 1 },
          ],
        ],
      }).success,
    ).toBe(false);
    expect(
      pathData({
        viewWidth: 100,
        viewHeight: 100,
        closed: true,
        contours: [
          [
            { x: 0, y: 0 },
            { x: 40, y: 0, onCurve: false },
            { x: 80, y: 80 },
          ],
        ],
      }),
    ).toBe('M 0 0 Q 40 0 80 80 Z');
  });
  it('derives an alpha matte from actual connected edge colors without deleting enclosed matching pixels', () => {
    const width = 7,
      height = 7,
      data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 1; y < 6; y++)
      for (let x = 1; x < 6; x++)
        if (x === 1 || x === 5 || y === 1 || y === 5) {
          const i = (y * width + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
    const matte = removeEdgeColor(data, width, height, 10);
    expect(matte[3]).toBe(0);
    expect(matte[(3 * width + 3) * 4 + 3]).toBe(255);
    expect(matte[(1 * width + 1) * 4 + 3]).toBe(255);
    expect(data[3]).toBe(255);
    expect(() => removeEdgeColor(data, 7, 8, 10)).toThrow('16 megapixels');
    expect(() => removeEdgeColor(data, width, height, Infinity)).toThrow(
      'tolerance',
    );
  });
  it('exports geometric paths, crop/mask appearance and designed fonts without external asset dependencies', () => {
    const content: VisualContent = {
      width: 500,
      height: 500,
      duration: 1,
      background: '#ffffff',
      layers: [],
    };
    const vector = {
      ...newLayer('path', content),
      path: {
        viewWidth: 100,
        viewHeight: 100,
        closed: true,
        contours: [
          [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 50, y: 100 },
          ],
        ],
      },
      opacity: 0.6,
      stroke: '#000000',
      strokeWidth: 2,
    };
    const source = svgSource({ ...content, layers: [vector] });
    expect(source).toContain('d="M 0 0 L 100 0 L 50 100 Z"');
    expect(source).toContain('opacity="0.6"');
    expect(source).not.toContain('foreignObject');
    const image = {
      ...newLayer('image', content),
      src: '/api/files/12978879-c986-440f-bcbc-658156798220',
      crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
      mask: 'ellipse' as const,
    };
    const output = svgSource(
      { ...content, layers: [image] },
      undefined,
      undefined,
      {
        images: new Map(),
        dataUrls: new Map([[image.src, 'data:image/png;base64,iVBORw==']]),
      },
    );
    expect(output).toContain('viewBox="0.1 0.2 0.5 0.6"');
    expect(output).toContain('<clipPath');
    expect(output).not.toContain('href="/api/');
  });
});

describe('TrueType font creation', () => {
  it('produces deterministic installable table data with the TrueType whole-font checksum', () => {
    const design = createFontDesign('Proof Typeface'),
      bytes = buildTrueType(design),
      view = new DataView(bytes.buffer);
    expect(buildTrueType(design)).toEqual(bytes);
    expect(view.getUint32(0)).toBe(0x00010000);
    let sum = 0;
    for (let i = 0; i < bytes.length; i += 4)
      sum = (sum + view.getUint32(i)) >>> 0;
    expect(sum).toBe(0xb1b0afba);
    const tables = new Map<string, { offset: number; length: number }>();
    for (let i = 0; i < view.getUint16(4); i++) {
      const start = 12 + i * 16,
        tag = String.fromCharCode(...bytes.slice(start, start + 4)),
        offset = view.getUint32(start + 8),
        length = view.getUint32(start + 12);
      expect(offset + length).toBeLessThanOrEqual(bytes.length);
      tables.set(tag, { offset, length });
    }
    expect([...tables.keys()]).toEqual([
      'OS/2',
      'cmap',
      'glyf',
      'head',
      'hhea',
      'hmtx',
      'loca',
      'maxp',
      'name',
      'post',
    ]);
    expect(tables.get('maxp')!.length).toBe(32);
    expect(view.getUint16(tables.get('maxp')!.offset + 4)).toBe(38);
    const cmap = tables.get('cmap')!.offset,
      sub = cmap + view.getUint32(cmap + 8),
      segments = view.getUint16(sub + 6) / 2;
    const codes = Array.from({ length: segments }, (_, i) =>
      view.getUint16(sub + 14 + i * 2),
    );
    expect(codes).toContain(65);
    expect(codes).toContain(90);
    expect(codes).toContain(48);
    expect(codes.at(-1)).toBe(65535);
  });
  it('preserves authored quadratic control points, glyph metrics and non-ASCII mappings', () => {
    const design = {
      ...createFontDesign('Outline Studio'),
      glyphs: [
        {
          character: '中',
          advanceWidth: 800,
          contours: [
            [
              { x: 10, y: 0 },
              { x: 400, y: 800, onCurve: false },
              { x: 750, y: 0 },
            ],
          ],
        },
      ],
    };
    const bytes = buildTrueType(design),
      view = new DataView(bytes.buffer),
      tables = new Map<string, number>();
    for (let i = 0; i < view.getUint16(4); i++) {
      const start = 12 + i * 16;
      tables.set(
        String.fromCharCode(...bytes.slice(start, start + 4)),
        view.getUint32(start + 8),
      );
    }
    const loca = tables.get('loca')!,
      glyf = tables.get('glyf')!,
      start = glyf + view.getUint32(loca + 8);
    expect(view.getInt16(start)).toBe(1);
    expect([...bytes.slice(start + 14, start + 17)]).toEqual([1, 0, 1]);
    const hmtx = tables.get('hmtx')!;
    expect(view.getUint16(hmtx + 8)).toBe(800);
    expect(
      fontDesignSchema.safeParse({
        ...design,
        glyphs: [...design.glyphs, ...design.glyphs],
      }).success,
    ).toBe(false);
  });
});
