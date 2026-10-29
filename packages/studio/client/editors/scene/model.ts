import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import type { Solid } from '../../../shared/domain.ts';

export type SceneContent = { solids: Solid[]; unit: 'm' | 'mm'; grid: boolean };
export type TransformMode = 'translate' | 'rotate' | 'scale';
const LIMIT = 100000;
export const round = (value: number) => Math.round(value * 1e6) / 1e6;
export const degrees = (radians: number) => round((radians * 180) / Math.PI);
export const radians = (value: number) => (value * Math.PI) / 180;
export function bounded(
  value: number,
  minimum = -LIMIT,
  maximum = LIMIT,
): number {
  return round(
    Math.min(
      maximum,
      Math.max(minimum, Number.isFinite(value) ? value : minimum),
    ),
  );
}
export function convertUnits(
  content: SceneContent,
  next: SceneContent['unit'],
): SceneContent {
  if (content.unit === next) return content;
  const factor = next === 'mm' ? 1000 : 0.001;
  const solids = content.solids.map((s) => ({
    ...s,
    position: s.position.map((v) => round(v * factor)) as Solid['position'],
    dimensions: s.dimensions.map((v) =>
      round(v * factor),
    ) as Solid['dimensions'],
  }));
  if (
    solids.some(
      (s) =>
        s.dimensions.some((v) => v < 0.01 || v > LIMIT) ||
        s.position.some((v) => Math.abs(v) > LIMIT),
    )
  )
    throw new Error(
      'Changing units would exceed the supported dimension range (0.01–100,000).',
    );
  return { ...content, unit: next, solids };
}
export function newSolid(
  shape: Solid['shape'],
  unit: SceneContent['unit'],
  offset = 0,
): Solid {
  const size = unit === 'mm' ? 10 : 1;
  return {
    id: crypto.randomUUID(),
    shape,
    position: [offset * size, size / 2, 0],
    rotation: [0, 0, 0],
    dimensions: [size, size, size],
    color: '#6b73d1',
  };
}
export function primitiveGeometry(shape: Solid['shape']): BufferGeometry {
  if (shape === 'sphere') return new SphereGeometry(0.5, 32, 24);
  if (shape === 'cylinder') return new CylinderGeometry(0.5, 0.5, 1, 48);
  return new BoxGeometry(1, 1, 1);
}
export function solidMatrix(solid: Solid): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...solid.position),
    new Quaternion().setFromEuler(new Euler(...solid.rotation)),
    new Vector3(...solid.dimensions),
  );
}
export function sceneBounds(solids: Solid[]): Box3 {
  const result = new Box3();
  for (const solid of solids) {
    const bounds = new Box3(
      new Vector3(-0.5, -0.5, -0.5),
      new Vector3(0.5, 0.5, 0.5),
    );
    bounds.applyMatrix4(solidMatrix(solid));
    result.union(bounds);
  }
  return result.isEmpty()
    ? new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1))
    : result;
}
export function geometryFromPositions(positions: Float32Array): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
export function exportGroup(
  content: SceneContent,
  cadPositions?: Float32Array,
  meters = false,
): Group {
  const group = new Group();
  if (cadPositions) {
    const mesh = new Mesh(
      geometryFromPositions(cadPositions),
      new MeshStandardMaterial({
        color: content.solids[0]?.color ?? '#6b73d1',
        roughness: 0.6,
      }),
    );
    mesh.name = 'CAD result';
    group.add(mesh);
  } else
    for (const solid of content.solids) {
      const mesh = new Mesh(
        primitiveGeometry(solid.shape),
        new MeshStandardMaterial({ color: solid.color, roughness: 0.6 }),
      );
      mesh.name = solid.shape;
      mesh.position.set(...solid.position);
      mesh.rotation.set(...solid.rotation);
      mesh.scale.set(...solid.dimensions);
      group.add(mesh);
    }
  if (meters && content.unit === 'mm') group.scale.setScalar(0.001);
  group.updateMatrixWorld(true);
  return group;
}
export function disposeGroup(group: Group) {
  group.traverse((object) => {
    if (object instanceof Mesh) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      materials.forEach((material) => material.dispose());
    }
  });
}
export function foldOperationOrder(
  solids: Solid[],
): { id: string; operation: 'base' | 'union' | 'subtract' | 'intersect' }[] {
  return solids.map((solid, index) => ({
    id: solid.id,
    operation: index === 0 ? 'base' : (solid.operation ?? 'union'),
  }));
}
