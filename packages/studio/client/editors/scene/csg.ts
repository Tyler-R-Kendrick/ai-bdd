import modeling from '@jscad/modeling';
import type { Solid } from '../../../shared/domain.ts';
import { solidMatrix } from './model.ts';

/** Evaluate the ordered, tessellated solid expression with JSCAD's actual boolean kernel. */
export function evaluateCad(solids: Solid[]): Float32Array {
  const { primitives, transforms, booleans, geometries } = modeling;
  if (solids.length > 80)
    throw new Error(
      'CAD models support at most 80 primitives per boolean expression.',
    );
  let result: ReturnType<typeof primitives.cuboid> | null = null;
  for (const solid of solids) {
    let primitive;
    if (solid.shape === 'sphere')
      primitive = primitives.sphere({ radius: 0.5, segments: 24 });
    else if (solid.shape === 'cylinder')
      primitive = transforms.rotateX(
        Math.PI / 2,
        primitives.cylinder({ radius: 0.5, height: 1, segments: 32 }),
      );
    else primitive = primitives.cuboid({ size: [1, 1, 1] });
    const shape = transforms.transform(solidMatrix(solid).elements, primitive);
    if (result === null) result = shape;
    else if (solid.operation === 'subtract')
      result = booleans.subtract(result, shape);
    else if (solid.operation === 'intersect')
      result = booleans.intersect(result, shape);
    else result = booleans.union(result, shape);
  }
  if (result === null) return new Float32Array();
  const positions: number[] = [];
  for (const polygon of geometries.geom3.toPolygons(result)) {
    const vertices = polygon.vertices;
    // JSCAD returns convex polygons, so fan triangulation preserves its result.
    for (let i = 1; i + 1 < vertices.length; i++)
      for (const vertex of [vertices[0]!, vertices[i]!, vertices[i + 1]!])
        positions.push(vertex[0], vertex[1], vertex[2]);
    if (positions.length > 9_000_000)
      throw new Error(
        'This CAD result exceeds the one-million triangle export limit.',
      );
  }
  return new Float32Array(positions);
}
