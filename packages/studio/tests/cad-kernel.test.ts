import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import initOpenCascade from 'replicad-opencascadejs';
import { measureVolume, setOC } from 'replicad';
import {
  buildExactCad,
  exactStep,
  tessellateExactCad,
} from '../client/editors/scene/kernel.ts';
import {
  cadFeatureSchema,
  newCadFeature,
  sceneImportSchema,
} from '../shared/cad-domain.ts';
import { inspectGlb, parseStl } from '../client/editors/scene/imports.ts';
import {
  convertUnits,
  type SceneContent,
  type Solid,
} from '../client/editors/scene/model.ts';

beforeAll(async () => {
  const wasm = await readFile(
    fileURLToPath(import.meta.resolve('replicad-opencascadejs/wasm')),
  );
  setOC(await initOpenCascade({ wasmBinary: wasm }));
}, 30000);
const solid = (
  dimensions: [number, number, number],
  position: [number, number, number] = [0, 0, 0],
  operation: Solid['operation'] = 'union',
): Solid => ({
  id: crypto.randomUUID(),
  shape: 'box',
  dimensions,
  position,
  rotation: [0, 0, 0],
  operation,
  color: '#6b73d1',
});
const none = async () => {
  throw new Error('No import expected');
};

describe('OpenCascade B-rep feature evaluation and interchange', () => {
  it('computes analytic boolean volume and exports an actual STEP solid that independently reimports', async () => {
    const content: SceneContent = {
      unit: 'mm',
      grid: true,
      solids: [
        solid([20, 20, 20], [0, 10, 0]),
        solid([8, 8, 8], [8, 10, 0], 'subtract'),
      ],
    };
    const shape = await buildExactCad(content, none);
    expect(shape).not.toBeNull();
    try {
      const mesh = tessellateExactCad(shape);
      expect(mesh.volume).toBeCloseTo(7616, 5);
      expect(mesh.faces).toBeGreaterThan(6);
      expect(mesh.positions.length).toBeGreaterThan(108);
      const bytes = await exactStep(shape!, 'mm');
      const text = new TextDecoder().decode(bytes);
      expect(text).toContain('ISO-10303-21;');
      expect(text).toMatch(
        /MANIFOLD_SOLID_BREP|ADVANCED_BREP_SHAPE_REPRESENTATION/,
      );
      const restored = await buildExactCad(
        {
          unit: 'mm',
          grid: true,
          solids: [],
          imports: [
            {
              id: crypto.randomUUID(),
              name: 'Roundtrip solid',
              format: 'step',
              src: '/api/files/' + crypto.randomUUID(),
              position: [0, 0, 0],
              rotation: [0, 0, 0],
              scale: 1,
              visible: true,
              color: '#6b73d1',
              roughness: 0.6,
              metalness: 0.1,
            },
          ],
        },
        async () => bytes,
      );
      try {
        expect(measureVolume(restored!)).toBeCloseTo(7616, 5);
      } finally {
        restored?.delete();
      }
    } finally {
      shape?.delete();
    }
  });
  it('rebuilds dimensioned sketch features and suppression changes their actual volume', async () => {
    const base = { ...newCadFeature('mm'), width: 30, height: 20, depth: 10 };
    const hole = {
      ...newCadFeature('mm', 'circle'),
      radius: 3,
      depth: 10,
      operation: 'subtract' as const,
    };
    const content: SceneContent = {
      unit: 'mm',
      grid: true,
      solids: [],
      features: [base, hole],
    };
    const shape = await buildExactCad(content, none);
    try {
      expect(measureVolume(shape!)).toBeCloseTo(6000 - Math.PI * 90, 5);
    } finally {
      shape?.delete();
    }
    const changed = await buildExactCad(
      {
        ...content,
        features: [
          { ...base, width: 40 },
          { ...hole, enabled: false },
        ],
      },
      none,
    );
    try {
      expect(measureVolume(changed!)).toBeCloseTo(8000, 5);
    } finally {
      changed?.delete();
    }
    await expect(
      buildExactCad({ ...content, features: [hole, base] }, none),
    ).rejects.toThrow('first enabled');
  });
  it('preserves physical dimensions through meter STEP metadata and coordinate conversions', async () => {
    const content: SceneContent = {
      unit: 'm',
      grid: true,
      solids: [solid([1, 2, 3])],
      features: [{ ...newCadFeature('m'), center: [2, 0] }],
    };
    const converted = convertUnits(content, 'mm');
    expect(converted.features?.[0]?.width).toBe(1000);
    expect(converted.features?.[0]?.center).toEqual([2000, 0]);
    expect(convertUnits(converted, 'm')).toEqual(content);
    const shape = await buildExactCad({ ...content, features: [] }, none);
    try {
      const data = await exactStep(shape!, 'm');
      const restored = await buildExactCad(
        {
          unit: 'm',
          grid: true,
          solids: [],
          imports: [
            {
              id: crypto.randomUUID(),
              name: 'Meter unit model',
              format: 'step',
              src: '/api/files/' + crypto.randomUUID(),
              position: [0, 0, 0],
              rotation: [0, 0, 0],
              scale: 1,
              visible: true,
              color: '#6b73d1',
              roughness: 0.6,
              metalness: 0,
            },
          ],
        },
        async () => data,
      );
      try {
        expect(measureVolume(restored!)).toBeCloseTo(6, 6);
      } finally {
        restored?.delete();
      }
    } finally {
      shape?.delete();
    }
  });
  it('uses curved analytic primitives and real rolling-edge fillets', async () => {
    const ellipse = { ...solid([2, 3, 4]), shape: 'cylinder' as const };
    const cylinder = await buildExactCad(
      { unit: 'mm', grid: true, solids: [ellipse] },
      none,
    );
    try {
      expect(measureVolume(cylinder!)).toBeCloseTo(Math.PI * 6, 5);
    } finally {
      cylinder?.delete();
    }
    const rounded = await buildExactCad(
      {
        unit: 'mm',
        grid: true,
        solids: [],
        features: [
          {
            ...newCadFeature('mm'),
            width: 20,
            height: 10,
            depth: 10,
            fillet: 1,
          },
        ],
      },
      none,
    );
    try {
      const result = tessellateExactCad(rounded);
      expect(result.volume).toBeGreaterThan(1800);
      expect(result.volume).toBeLessThan(2000);
      expect(result.faces).toBeGreaterThan(6);
    } finally {
      rounded?.delete();
    }
  });
  it('rejects oversized or non-declarative feature/import input and invalid fillets', async () => {
    expect(
      cadFeatureSchema.safeParse({ ...newCadFeature('mm'), fillet: 100 })
        .success,
    ).toBe(false);
    expect(
      cadFeatureSchema.safeParse({
        ...newCadFeature('mm'),
        script: 'eval(code)',
      }).success,
    ).toBe(false);
    expect(
      sceneImportSchema.safeParse({ src: 'https://example.com/mesh.glb' })
        .success,
    ).toBe(false);
    await expect(
      buildExactCad(
        {
          unit: 'mm',
          grid: true,
          solids: Array.from({ length: 81 }, () => solid([1, 1, 1])),
        },
        none,
      ),
    ).rejects.toThrow('80 primitives');
  });
});

describe('bounded self-contained mesh interchange', () => {
  function glb(json: unknown) {
    const text = JSON.stringify(json);
    const length = Math.ceil(text.length / 4) * 4;
    const buffer = new ArrayBuffer(20 + length);
    const view = new DataView(buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, buffer.byteLength, true);
    view.setUint32(12, length, true);
    view.setUint32(16, 0x4e4f534a, true);
    new Uint8Array(buffer, 20).fill(32);
    new Uint8Array(buffer, 20).set(new TextEncoder().encode(text));
    return buffer;
  }
  it('rejects external mesh resources before the loader can fetch them', () => {
    expect(() =>
      inspectGlb(
        glb({
          asset: { version: '2.0' },
          buffers: [{ uri: 'https://example.com/data.bin' }],
        }),
      ),
    ).toThrow('embed');
    expect(() =>
      inspectGlb(
        glb({
          asset: { version: '2.0' },
          images: [{ uri: 'data:image/png;base64,abcd' }],
        }),
      ),
    ).toThrow('embed');
    expect(() =>
      inspectGlb(
        glb({
          asset: { version: '2.0' },
          nodes: [{ children: [1] }, { children: [0] }],
        }),
      ),
    ).toThrow('acyclic');
    expect(
      inspectGlb(glb({ asset: { version: '2.0' }, nodes: [], meshes: [] }))
        .asset.version,
    ).toBe('2.0');
  });
  it('loads real binary STL triangles and rejects malformed containers', () => {
    const bytes = new ArrayBuffer(134);
    const view = new DataView(bytes);
    view.setUint32(80, 1, true);
    view.setFloat32(96, 0, true);
    view.setFloat32(100, 0, true);
    view.setFloat32(104, 0, true);
    view.setFloat32(108, 1, true);
    view.setFloat32(112, 0, true);
    view.setFloat32(116, 0, true);
    view.setFloat32(120, 0, true);
    view.setFloat32(124, 1, true);
    view.setFloat32(128, 0, true);
    const geometry = parseStl(bytes);
    expect(geometry.getAttribute('position').count).toBe(3);
    geometry.dispose();
    expect(() => inspectGlb(new ArrayBuffer(12))).toThrow('GLB');
    expect(() => parseStl(new ArrayBuffer(0))).toThrow('10 MB');
  });
});
