import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import type { Solid } from '../shared/domain.ts';
import { evaluateCad } from '../client/editors/scene/csg.ts';
import {
  bounded,
  convertUnits,
  disposeGroup,
  exportGroup,
  foldOperationOrder,
  geometryFromPositions,
  newSolid,
  sceneBounds,
  type SceneContent,
} from '../client/editors/scene/model.ts';

const solid = (
  dimensions: Solid['dimensions'] = [2, 2, 2],
  position: Solid['position'] = [0, 0, 0],
  operation?: Solid['operation'],
): Solid => ({
  id: crypto.randomUUID(),
  shape: 'box',
  dimensions,
  position,
  rotation: [0, 0, 0],
  color: '#6b73d1',
  ...(operation ? { operation } : {}),
});
const volume = (positions: Float32Array) => {
  let sum = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const a = new Vector3(positions[i], positions[i + 1], positions[i + 2]),
      b = new Vector3(positions[i + 3], positions[i + 4], positions[i + 5]),
      c = new Vector3(positions[i + 6], positions[i + 7], positions[i + 8]);
    sum += a.dot(b.cross(c)) / 6;
  }
  return Math.abs(sum);
};
describe('actual CAD boolean evaluation', () => {
  it('computes a closed cuboid and removes a smaller internal solid', () => {
    expect(volume(evaluateCad([solid()]))).toBeCloseTo(8, 4);
    const cut = evaluateCad([solid(), solid([1, 1, 1], [0, 0, 0], 'subtract')]);
    expect(volume(cut)).toBeCloseTo(7, 4);
    expect([...cut].every(Number.isFinite)).toBe(true);
  });
  it('computes union and intersection instead of drawing overlapping primitive facades', () => {
    expect(
      volume(evaluateCad([solid(), solid([2, 2, 2], [1, 0, 0], 'union')])),
    ).toBeCloseTo(12, 4);
    expect(
      volume(evaluateCad([solid(), solid([2, 2, 2], [1, 0, 0], 'intersect')])),
    ).toBeCloseTo(4, 4);
  });
  it('preserves expression order and makes disjoint intersection empty', () => {
    const first = solid(),
      second = solid([1, 1, 1], [10, 0, 0], 'intersect');
    expect(evaluateCad([first, second]).length).toBe(0);
    expect(foldOperationOrder([first, second])).toEqual([
      { id: first.id, operation: 'base' },
      { id: second.id, operation: 'intersect' },
    ]);
    expect(evaluateCad([]).length).toBe(0);
  });
  it('handles ellipsoids and transformed cylinders with positive, finite volume', () => {
    const sphere = { ...solid([2, 2, 2]), shape: 'sphere' as const };
    expect(volume(evaluateCad([sphere]))).toBeGreaterThan(3.8);
    expect(volume(evaluateCad([sphere]))).toBeLessThan(4.3);
    const cylinder = {
      ...solid([2, 2, 2], [10, -3, 2]),
      shape: 'cylinder' as const,
      rotation: [Math.PI / 2, 0, 0] as Solid['rotation'],
    };
    expect(volume(evaluateCad([cylinder]))).toBeGreaterThan(6);
    expect(volume(evaluateCad([cylinder]))).toBeLessThan(6.4);
  });
  it('rejects expressions over the documented computation bound', () => {
    expect(() =>
      evaluateCad(Array.from({ length: 81 }, () => solid())),
    ).toThrow('80 primitives');
  });
});
describe('scene units and geometry exports', () => {
  it('converts dimensions and positions while preserving physical size', () => {
    const content: SceneContent = {
      solids: [solid([1, 2, 3], [4, 5, 6])],
      unit: 'm',
      grid: true,
    };
    const converted = convertUnits(content, 'mm');
    expect(converted.solids[0]!.dimensions).toEqual([1000, 2000, 3000]);
    expect(converted.solids[0]!.position).toEqual([4000, 5000, 6000]);
    expect(convertUnits(converted, 'm')).toEqual(content);
    expect(convertUnits(content, 'm')).toBe(content);
  });
  it('rejects unit changes that would violate persisted dimensional limits', () => {
    expect(() =>
      convertUnits(
        { solids: [solid([0.01, 0.01, 0.01])], unit: 'mm', grid: true },
        'm',
      ),
    ).toThrow('dimension range');
    expect(() =>
      convertUnits(
        { solids: [solid([101, 1, 1])], unit: 'm', grid: true },
        'mm',
      ),
    ).toThrow('dimension range');
  });
  it('exports GLB scene geometry in meters and STL geometry in the chosen coordinate units', () => {
    const content: SceneContent = {
      solids: [solid([10, 20, 30], [0, 10, 0])],
      unit: 'mm',
      grid: true,
    };
    const glb = exportGroup(content, undefined, true),
      stl = exportGroup(content);
    expect(
      new Box3().setFromObject(glb).getSize(new Vector3()).toArray(),
    ).toEqual([0.01, 0.02, 0.03]);
    expect(
      new Box3().setFromObject(stl).getSize(new Vector3()).toArray(),
    ).toEqual([10, 20, 30]);
    disposeGroup(glb);
    disposeGroup(stl);
  });
  it('applies rotations to bounds and builds normals for kernel triangles', () => {
    const s = {
      ...solid([2, 4, 6]),
      rotation: [0, 0, Math.PI / 2] as Solid['rotation'],
    };
    const bounds = sceneBounds([s]).getSize(new Vector3());
    expect(bounds.x).toBeCloseTo(4);
    expect(bounds.y).toBeCloseTo(2);
    expect(bounds.z).toBeCloseTo(6);
    const geometry = geometryFromPositions(evaluateCad([s]));
    expect(geometry.getAttribute('normal').count).toBe(
      geometry.getAttribute('position').count,
    );
    geometry.dispose();
  });
  it('starts new CAD solids in useful millimeter dimensions and bounds invalid transform values', () => {
    expect(newSolid('box', 'mm').dimensions).toEqual([10, 10, 10]);
    expect(newSolid('box', 'm').dimensions).toEqual([1, 1, 1]);
    expect(bounded(Infinity, 0.01)).toBe(0.01);
    expect(bounded(-100001)).toBe(-100000);
  });
});
