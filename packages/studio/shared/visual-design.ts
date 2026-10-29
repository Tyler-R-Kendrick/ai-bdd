import { z } from 'zod';

const coordinate = z.number().finite().min(-10000).max(10000);
export const designPointSchema = z
  .object({ x: coordinate, y: coordinate, onCurve: z.boolean().optional() })
  .strict();
export const vectorPathSchema = z
  .object({
    contours: z
      .array(z.array(designPointSchema).min(2).max(256))
      .min(1)
      .max(64),
    closed: z.boolean(),
    viewWidth: z.number().finite().min(1).max(10000),
    viewHeight: z.number().finite().min(1).max(10000),
  })
  .strict();
export const layerAppearanceSchema = z
  .object({
    opacity: z.number().finite().min(0).max(1).optional(),
    stroke: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    strokeWidth: z.number().finite().min(0).max(100).optional(),
    path: vectorPathSchema.optional(),
    mask: z.enum(['none', 'ellipse', 'path']).optional(),
    crop: z
      .object({
        x: z.number().finite().min(0).max(1),
        y: z.number().finite().min(0).max(1),
        width: z.number().finite().min(0.01).max(1),
        height: z.number().finite().min(0.01).max(1),
      })
      .strict()
      .refine(
        (c) => c.x + c.width <= 1.000001 && c.y + c.height <= 1.000001,
        'Crop must stay inside its source image',
      )
      .optional(),
    filters: z
      .object({
        brightness: z.number().finite().min(0).max(2),
        contrast: z.number().finite().min(0).max(2),
        saturation: z.number().finite().min(0).max(2),
        grayscale: z.number().finite().min(0).max(1),
        blur: z.number().finite().min(0).max(30),
      })
      .strict()
      .optional(),
  })
  .strict();
export const fontGlyphSchema = z
  .object({
    character: z
      .string()
      .min(1)
      .max(1)
      .refine(
        (c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 0xd800,
        'Use a printable Basic Multilingual Plane character',
      ),
    advanceWidth: z.number().int().min(100).max(2000),
    contours: z.array(z.array(designPointSchema).min(3).max(256)).max(64),
  })
  .strict();
export const fontDesignSchema = z
  .object({
    family: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[\p{L}\p{N} ._-]+$/u),
    unitsPerEm: z.literal(1000),
    ascender: z.literal(800),
    descender: z.literal(-200),
    glyphs: z.array(fontGlyphSchema).min(1).max(128),
  })
  .strict()
  .refine(
    (f) => new Set(f.glyphs.map((g) => g.character)).size === f.glyphs.length,
    'Glyph characters must be unique',
  );

export type DesignPoint = z.infer<typeof designPointSchema>;
export type VectorPath = z.infer<typeof vectorPathSchema>;
export type LayerAppearance = z.infer<typeof layerAppearanceSchema>;
export type FontGlyph = z.infer<typeof fontGlyphSchema>;
export type FontDesign = z.infer<typeof fontDesignSchema>;
export const defaultFilters = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  grayscale: 0,
  blur: 0,
};

/** Converts bounded geometric data to path commands; executable SVG is never accepted. */
export function pathData(path: VectorPath): string {
  return path.contours
    .map((points) => {
      const first = points[0]!,
        last = points.at(-1)!;
      const midpoint = (a: DesignPoint, b: DesignPoint): DesignPoint => ({
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      });
      const start =
        first.onCurve !== false
          ? first
          : last.onCurve !== false
            ? last
            : midpoint(last, first);
      const outline =
        first.onCurve !== false
          ? points.slice(1)
          : last.onCurve !== false
            ? points.slice(0, -1)
            : points;
      let d = `M ${start.x} ${start.y}`;
      for (let i = 0; i < outline.length; i++) {
        const point = outline[i]!;
        if (point.onCurve === false) {
          const next = outline[i + 1] ?? start,
            end = next.onCurve === false ? midpoint(point, next) : next;
          d += ` Q ${point.x} ${point.y} ${end.x} ${end.y}`;
          if (next.onCurve !== false) i++;
        } else d += ` L ${point.x} ${point.y}`;
      }
      return d + (path.closed ? ' Z' : '');
    })
    .join(' ');
}

export function filterCss(filters?: LayerAppearance['filters']): string {
  if (!filters) return 'none';
  return `brightness(${filters.brightness}) contrast(${filters.contrast}) saturate(${filters.saturation}) grayscale(${filters.grayscale}) blur(${filters.blur}px)`;
}
export const iconPaths: Record<string, VectorPath> = {
  Spark: {
    viewWidth: 100,
    viewHeight: 100,
    closed: true,
    contours: [
      [
        { x: 50, y: 2 },
        { x: 61, y: 36 },
        { x: 98, y: 50 },
        { x: 61, y: 64 },
        { x: 50, y: 98 },
        { x: 39, y: 64 },
        { x: 2, y: 50 },
        { x: 39, y: 36 },
      ],
    ],
  },
  Leaf: {
    viewWidth: 100,
    viewHeight: 100,
    closed: true,
    contours: [
      [
        { x: 12, y: 88 },
        { x: 2, y: 3, onCurve: false },
        { x: 92, y: 8 },
        { x: 98, y: 94, onCurve: false },
        { x: 12, y: 88 },
      ],
    ],
  },
  Arrow: {
    viewWidth: 100,
    viewHeight: 100,
    closed: true,
    contours: [
      [
        { x: 5, y: 40 },
        { x: 58, y: 40 },
        { x: 58, y: 12 },
        { x: 96, y: 50 },
        { x: 58, y: 88 },
        { x: 58, y: 60 },
        { x: 5, y: 60 },
      ],
    ],
  },
  Shield: {
    viewWidth: 100,
    viewHeight: 100,
    closed: true,
    contours: [
      [
        { x: 10, y: 10 },
        { x: 50, y: 2 },
        { x: 90, y: 10 },
        { x: 90, y: 72 },
        { x: 50, y: 98 },
        { x: 10, y: 72 },
      ],
    ],
  },
};

export const grayscaleMatrix = (amount: number) =>
  [
    0.2126 + 0.7874 * (1 - amount),
    0.7152 - 0.7152 * (1 - amount),
    0.0722 - 0.0722 * (1 - amount),
    0,
    0,
    0.2126 - 0.2126 * (1 - amount),
    0.7152 + 0.2848 * (1 - amount),
    0.0722 - 0.0722 * (1 - amount),
    0,
    0,
    0.2126 - 0.2126 * (1 - amount),
    0.7152 - 0.7152 * (1 - amount),
    0.0722 + 0.9278 * (1 - amount),
    0,
    0,
    0,
    0,
    0,
    1,
    0,
  ].join(' ');
