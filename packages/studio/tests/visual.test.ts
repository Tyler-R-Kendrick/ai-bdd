import { describe, expect, it } from 'vitest';
import type { Layer } from '../shared/domain.ts';
import {
  drawFrame,
  resized,
  svgSource,
  visibleAt,
  wrapText,
  type VisualContent,
} from '../client/editors/visual/render.ts';

const layer = (values: Partial<Layer> = {}): Layer => ({
  id: '1348c810-e9ea-448c-a16a-d28910310ebf',
  type: 'text',
  x: 10,
  y: 20,
  width: 100,
  height: 100,
  fill: '#24292e',
  text: 'Hello world',
  fontSize: 20,
  fontFamily: 'Inter',
  start: 1,
  duration: 2,
  rotation: 0,
  ...values,
});
const content = (layers: Layer[]): VisualContent => ({
  width: 1280,
  height: 720,
  background: '#ffffff',
  layers,
  duration: 10,
});

describe('visual artifact rendering', () => {
  it('renders clips on a half-open interval so a cut never shows two adjacent clips', () => {
    const first = layer({ start: 0, duration: 2 }),
      second = layer({ start: 2, duration: 2 });
    expect(visibleAt(first, 0)).toBe(true);
    expect(visibleAt(first, 2)).toBe(false);
    expect(visibleAt(second, 2)).toBe(true);
    expect(visibleAt(second, 4)).toBe(false);
  });

  it('keeps explicit empty lines, wraps words, and breaks an oversized token without losing characters', () => {
    const measure = (value: string) => value.length;
    expect(wrapText('one two\n\nabcdefghij', 5, measure)).toEqual([
      'one',
      'two',
      '',
      'abcde',
      'fghij',
    ]);
    expect(wrapText('ab cd e', 5, measure)).toEqual(['ab cd', 'e']);
    expect(wrapText('你好世界', 2, measure)).toEqual(['你好', '世界']);
  });

  it('escapes authored text in exported SVG and includes no executable markup', () => {
    const exported = svgSource(
      content([layer({ text: '<script>alert("x")</script> & text' })]),
    );
    expect(exported).toContain('&lt;script&gt;');
    expect(exported).toContain('&amp;');
    expect(exported).not.toContain('<script>');
    expect(exported).not.toContain('foreignObject');
    expect(exported).toContain(
      'clip-path="url(#clip-1348c810-e9ea-448c-a16a-d28910310ebf)"',
    );
  });

  it('exports only visible timeline clips, while an image export contains every layer', () => {
    const model = content([
      layer({ text: 'First', start: 0, duration: 2 }),
      layer({
        id: 'a79cb37a-8ab6-44b2-afb8-14d077ea490a',
        text: 'Second',
        start: 2,
        duration: 2,
      }),
    ]);
    expect(svgSource(model, 2)).toContain('Second');
    expect(svgSource(model, 2)).not.toContain('First');
    expect(svgSource(model)).toContain('First');
    expect(svgSource(model)).toContain('Second');
  });

  it('embeds authenticated raster and font assets so SVG exports do not depend on a signed-in browser', () => {
    const fontUrl = '/api/files/302072ee-c986-440f-bcbc-658156798220';
    const imageUrl = '/api/files/5f90fe51-1cf9-4d1e-a754-8948a2c059a4';
    const dataUrls = new Map([
      [fontUrl, 'data:font/woff2;base64,d09GMg=='],
      [imageUrl, 'data:image/png;base64,iVBORw=='],
    ]);
    const exported = svgSource(
      content([
        layer({ fontFamily: 'Custom', fontUrl }),
        layer({ type: 'image', src: imageUrl }),
      ]),
      undefined,
      undefined,
      { dataUrls, images: new Map() },
    );
    expect(exported).toContain('data:font/woff2;base64,d09GMg==');
    expect(exported).toContain('href="data:image/png;base64,iVBORw=="');
    expect(exported).not.toContain('href="/api/files/');
    expect(() =>
      svgSource(content([layer({ type: 'image', src: imageUrl })])),
    ).toThrow('Load image assets');
    expect(() =>
      svgSource(content([layer({ fontFamily: 'Custom', fontUrl })])),
    ).toThrow('Load custom font assets');
  });

  it('rotates pointer deltas into local coordinates before resizing and prevents inverted geometry', () => {
    expect(
      resized(layer({ width: 100, height: 50, rotation: 90 }), 0, 30),
    ).toEqual({ width: 130, height: 50 });
    expect(resized(layer({ width: 100, height: 50 }), -150, -100)).toEqual({
      width: 1,
      height: 1,
    });
  });

  it('uses the same layer order and timing for native canvas exports and restores graphics state', () => {
    const calls: string[] = [];
    const ctx = new Proxy(
      { fillStyle: '', textBaseline: '', font: '' },
      {
        get(target, key) {
          if (key in target) return target[key as keyof typeof target];
          if (key === 'measureText')
            return (text: string) => ({ width: text.length * 10 });
          return (...args: unknown[]) => {
            calls.push(`${String(key)}:${args.join(',')}`);
          };
        },
        set(target, key, value) {
          (target as Record<string, unknown>)[String(key)] = value;
          return true;
        },
      },
    ) as unknown as CanvasRenderingContext2D;
    drawFrame(
      ctx,
      content([
        layer({ type: 'rect', start: 0, duration: 1 }),
        layer({ text: 'Visible', start: 1, duration: 1 }),
      ]),
      1,
    );
    expect(calls.filter((call) => call.startsWith('fillRect:'))).toEqual([
      'fillRect:0,0,1280,720',
    ]);
    expect(calls).toContain('fillText:Visible,0,17');
    expect(calls.filter((call) => call.startsWith('save:'))).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith('restore:'))).toHaveLength(2);
    expect(calls).toContain('clip:');
  });
});
