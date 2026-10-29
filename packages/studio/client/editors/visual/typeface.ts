import {
  fontDesignSchema,
  type FontDesign,
  type FontGlyph,
  type DesignPoint,
} from "../../../shared/visual-design.ts";

const alphabet: Record<string, string[]> = {
  A: ["01110", "11011", "11011", "11111", "11011", "11011", "11011"],
  B: ["11110", "11011", "11011", "11110", "11011", "11011", "11110"],
  C: ["01111", "11000", "11000", "11000", "11000", "11000", "01111"],
  D: ["11110", "11011", "11011", "11011", "11011", "11011", "11110"],
  E: ["11111", "11000", "11000", "11110", "11000", "11000", "11111"],
  F: ["11111", "11000", "11000", "11110", "11000", "11000", "11000"],
  G: ["01111", "11000", "11000", "11011", "11011", "11011", "01111"],
  H: ["11011", "11011", "11011", "11111", "11011", "11011", "11011"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00011", "00011", "00011", "00011", "11011", "01110"],
  K: ["11011", "11010", "11100", "11000", "11100", "11010", "11011"],
  L: ["11000", "11000", "11000", "11000", "11000", "11000", "11111"],
  M: ["10001", "11011", "11111", "10101", "10001", "10001", "10001"],
  N: ["11011", "11011", "11111", "11111", "11111", "11011", "11011"],
  O: ["01110", "11011", "11011", "11011", "11011", "11011", "01110"],
  P: ["11110", "11011", "11011", "11110", "11000", "11000", "11000"],
  Q: ["01110", "11011", "11011", "11011", "11111", "11010", "01101"],
  R: ["11110", "11011", "11011", "11110", "11100", "11010", "11011"],
  S: ["01111", "11000", "11000", "01110", "00011", "00011", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["11011", "11011", "11011", "11011", "11011", "11011", "01110"],
  V: ["11011", "11011", "11011", "11011", "11011", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "11111", "11011", "10001"],
  X: ["11011", "11011", "01010", "00100", "01010", "11011", "11011"],
  Y: ["11011", "11011", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00011", "00010", "00100", "01000", "11000", "11111"],
  "0": ["01110", "11011", "11111", "11111", "11111", "11011", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "11011", "00011", "00110", "01100", "11000", "11111"],
  "3": ["11110", "00011", "00011", "01110", "00011", "00011", "11110"],
  "4": ["11011", "11011", "11011", "11111", "00011", "00011", "00011"],
  "5": ["11111", "11000", "11000", "11110", "00011", "00011", "11110"],
  "6": ["01110", "11000", "11000", "11110", "11011", "11011", "01110"],
  "7": ["11111", "00011", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "11011", "11011", "01110", "11011", "11011", "01110"],
  "9": ["01110", "11011", "11011", "01111", "00011", "00011", "01110"],
};
export function gridGlyph(character: string): FontGlyph {
  const cells = alphabet[character.toUpperCase()] ?? [
    "11111",
    "10001",
    "10001",
    "10001",
    "10001",
    "10001",
    "11111",
  ];
  const contours: DesignPoint[][] = [];
  cells.forEach((row, y) =>
    [...row].forEach((filled, x) => {
      if (filled === "1") {
        const left = 70 + x * 100,
          bottom = 100 + (6 - y) * 100;
        // Clockwise outer contours in font coordinates, with no overlapping cells.
        contours.push([
          { x: left, y: bottom },
          { x: left, y: bottom + 100 },
          { x: left + 100, y: bottom + 100 },
          { x: left + 100, y: bottom },
        ]);
      }
    }),
  );
  return { character, advanceWidth: 640, contours };
}
export function createFontDesign(family = "Studio Sans"): FontDesign {
  return {
    family,
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs: [
      { character: " ", advanceWidth: 400, contours: [] },
      ...[..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].map(gridGlyph),
    ],
  };
}

class Binary {
  values: number[] = [];
  u8(value: number) {
    this.values.push(value & 255);
    return this;
  }
  u16(value: number) {
    return this.u8(value >>> 8).u8(value);
  }
  i16(value: number) {
    return this.u16(value & 65535);
  }
  u32(value: number) {
    return this.u16(value >>> 16).u16(value);
  }
  text(text: string) {
    for (const c of text) this.u8(c.charCodeAt(0));
    return this;
  }
  zeros(count: number) {
    while (count-- > 0) this.u8(0);
    return this;
  }
  add(value: Uint8Array) {
    this.values.push(...value);
    return this;
  }
  bytes() {
    return Uint8Array.from(this.values);
  }
}
const aligned = (value: number) => (value + 3) & ~3;
export function fontChecksum(bytes: Uint8Array): number {
  let value = 0;
  for (let i = 0; i < bytes.length; i += 4)
    value =
      (value +
        ((bytes[i] ?? 0) * 0x1000000 +
          ((bytes[i + 1] ?? 0) << 16) +
          ((bytes[i + 2] ?? 0) << 8) +
          (bytes[i + 3] ?? 0))) >>>
      0;
  return value;
}
function bounds(glyphs: FontGlyph[]) {
  const points = glyphs.flatMap((g) => g.contours.flat());
  return points.length
    ? [
        Math.min(...points.map((p) => p.x)),
        Math.min(...points.map((p) => p.y)),
        Math.max(...points.map((p) => p.x)),
        Math.max(...points.map((p) => p.y)),
      ].map(Math.round)
    : [0, 0, 0, 0];
}
function glyphBytes(glyph: FontGlyph): Uint8Array {
  if (!glyph.contours.length) return new Uint8Array();
  const out = new Binary().i16(glyph.contours.length);
  for (const v of bounds([glyph])) out.i16(v!);
  let count = 0;
  for (const contour of glyph.contours) {
    count += contour.length;
    out.u16(count - 1);
  }
  out.u16(0);
  const points = glyph.contours
    .flat()
    .map((p) => ({ ...p, x: Math.round(p.x), y: Math.round(p.y) }));
  for (const point of points) out.u8(point.onCurve === false ? 0 : 1);
  let last = 0;
  for (const point of points) {
    out.i16(point.x - last);
    last = point.x;
  }
  last = 0;
  for (const point of points) {
    out.i16(point.y - last);
    last = point.y;
  }
  return out.bytes();
}
function cmap(glyphs: FontGlyph[]): Uint8Array {
  const mappings = glyphs
    .map((glyph, index) => ({ code: glyph.character.charCodeAt(0), index }))
    .filter((m) => m.index > 0)
    .sort((a, b) => a.code - b.code);
  const count = mappings.length + 1,
    power = 2 ** Math.floor(Math.log2(count));
  const out = new Binary()
    .u16(0)
    .u16(1)
    .u16(3)
    .u16(1)
    .u32(12)
    .u16(4)
    .u16(16 + count * 8)
    .u16(0)
    .u16(count * 2)
    .u16(power * 2)
    .u16(Math.log2(power))
    .u16(count * 2 - power * 2);
  for (const m of mappings) out.u16(m.code);
  out.u16(65535).u16(0);
  for (const m of mappings) out.u16(m.code);
  out.u16(65535);
  for (const m of mappings) out.u16((m.index - m.code) & 65535);
  out.u16(1);
  out.zeros(count * 2);
  return out.bytes();
}
function nameTable(family: string): Uint8Array {
  const names = [
    [1, family],
    [2, "Regular"],
    [3, `${family}:1.0`],
    [4, `${family} Regular`],
    [5, "Version 1.0"],
    [6, `${family.replace(/[^A-Za-z0-9]/g, "") || "StudioFont"}-Regular`],
  ] as const;
  const strings = new Binary(),
    records = new Binary()
      .u16(0)
      .u16(names.length)
      .u16(6 + names.length * 12);
  for (const [id, text] of names) {
    const length = text.length * 2;
    records
      .u16(3)
      .u16(1)
      .u16(0x409)
      .u16(id)
      .u16(length)
      .u16(strings.values.length);
    for (let i = 0; i < text.length; i++) strings.u16(text.charCodeAt(i));
  }
  return records.add(strings.bytes()).bytes();
}
/** Emits a complete, deterministic TrueType font with cmap, outlines, metrics and checksums. */
export function buildTrueType(input: FontDesign): Uint8Array {
  const design = fontDesignSchema.parse(input);
  const notdef: FontGlyph = {
    character: "\u0000",
    advanceWidth: 640,
    contours: [
      [
        { x: 60, y: 0 },
        { x: 60, y: 700 },
        { x: 580, y: 700 },
        { x: 580, y: 0 },
      ],
      [
        { x: 140, y: 80 },
        { x: 500, y: 80 },
        { x: 500, y: 620 },
        { x: 140, y: 620 },
      ],
    ],
  };
  const supplied = design.glyphs.some((g) => g.character === " ")
    ? design.glyphs
    : [{ character: " ", advanceWidth: 400, contours: [] }, ...design.glyphs];
  const glyphs = [
    notdef,
    ...[...supplied].sort(
      (a, b) => a.character.charCodeAt(0) - b.character.charCodeAt(0),
    ),
  ];
  const boxes = glyphs.map((g) => bounds([g])),
    box = bounds(glyphs),
    tables = new Map<string, Uint8Array>();
  const glyf = new Binary(),
    loca = new Binary();
  for (const glyph of glyphs) {
    loca.u32(glyf.values.length);
    glyf.add(glyphBytes(glyph));
    glyf.zeros(aligned(glyf.values.length) - glyf.values.length);
  }
  loca.u32(glyf.values.length);
  tables.set("glyf", glyf.bytes());
  tables.set("loca", loca.bytes());
  tables.set("cmap", cmap(glyphs));
  tables.set("name", nameTable(design.family));
  const head = new Binary()
    .u32(0x10000)
    .u32(0x10000)
    .u32(0)
    .u32(0x5f0f3cf5)
    .u16(11)
    .u16(1000)
    .u32(0)
    .u32(3849984000)
    .u32(0)
    .u32(3849984000);
  for (const v of box) head.i16(v!);
  head.u16(0).u16(8).i16(2).i16(1).i16(0);
  tables.set("head", head.bytes());
  const advances = glyphs.map((g) => g.advanceWidth);
  const hhea = new Binary()
    .u32(0x10000)
    .i16(800)
    .i16(-200)
    .i16(200)
    .u16(Math.max(...advances))
    .i16(Math.min(...boxes.map((b) => b[0]!)))
    .i16(Math.min(...glyphs.map((g, i) => g.advanceWidth - boxes[i]![2]!)))
    .i16(box[2]!)
    .i16(1)
    .i16(0)
    .i16(0)
    .zeros(8)
    .i16(0)
    .u16(glyphs.length);
  tables.set("hhea", hhea.bytes());
  const hmtx = new Binary();
  glyphs.forEach((g, i) => hmtx.u16(g.advanceWidth).i16(boxes[i]![0]!));
  tables.set("hmtx", hmtx.bytes());
  const maxp = new Binary()
    .u32(0x10000)
    .u16(glyphs.length)
    .u16(Math.max(...glyphs.map((g) => g.contours.flat().length)))
    .u16(Math.max(...glyphs.map((g) => g.contours.length)))
    .u16(0)
    .u16(0)
    .u16(2)
    .zeros(16);
  tables.set("maxp", maxp.bytes());
  tables.set(
    "post",
    new Binary().u32(0x30000).u32(0).i16(-100).i16(50).zeros(20).bytes(),
  );
  const os2 = new Binary()
    .u16(4)
    .i16(Math.round(advances.reduce((s, v) => s + v, 0) / advances.length))
    .u16(400)
    .u16(5)
    .u16(0)
    .i16(650)
    .i16(600)
    .i16(0)
    .i16(75)
    .i16(650)
    .i16(600)
    .i16(0)
    .i16(350)
    .i16(50)
    .i16(300)
    .i16(0)
    .zeros(10)
    .u32(1)
    .u32(0)
    .u32(0)
    .u32(0)
    .text("AIBD")
    .u16(64)
    .u16(Math.min(...supplied.map((g) => g.character.charCodeAt(0))))
    .u16(Math.max(...supplied.map((g) => g.character.charCodeAt(0))))
    .i16(800)
    .i16(-200)
    .i16(200)
    .u16(Math.max(800, box[3]!))
    .u16(Math.max(200, -box[1]!))
    .u32(1)
    .u32(0)
    .i16(500)
    .i16(700)
    .u16(0)
    .u16(32)
    .u16(2);
  tables.set("OS/2", os2.bytes());
  const entries = [...tables].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    count = entries.length,
    power = 2 ** Math.floor(Math.log2(count));
  const output = new Binary()
      .u32(0x10000)
      .u16(count)
      .u16(power * 16)
      .u16(Math.log2(power))
      .u16(count * 16 - power * 16),
    data = new Binary();
  let headOffset = 0;
  for (const [tag, bytes] of entries) {
    const offset = 12 + 16 * count + data.values.length;
    output.text(tag).u32(fontChecksum(bytes)).u32(offset).u32(bytes.length);
    if (tag === "head") headOffset = offset;
    data.add(bytes).zeros(aligned(bytes.length) - bytes.length);
  }
  const result = output.add(data.bytes()).bytes();
  new DataView(result.buffer).setUint32(
    headOffset + 8,
    (0xb1b0afba - fontChecksum(result)) >>> 0,
  );
  return result;
}
