import {
  drawCircle,
  drawEllipse,
  drawRectangle,
  exportSTEP,
  importSTEP,
  makeBox,
  makeEllipsoid,
  measureVolume,
  getOC,
  type Shape3D,
} from 'replicad';
import {
  cadFeatureSchema,
  type CadFeature,
  type SceneImport,
} from '../../../shared/cad-domain.ts';
import { degrees, type SceneContent, type Solid } from './model.ts';

function transform(
  shape: Shape3D,
  position: number[],
  rotation: number[],
): Shape3D {
  // Three.js XYZ Euler coordinates apply Z, then Y, then X to the point.
  for (const axis of [2, 1, 0])
    if (rotation[axis]) {
      const direction: [number, number, number] = [0, 0, 0];
      direction[axis] = 1;
      shape = shape.rotate(degrees(rotation[axis]!), [0, 0, 0], direction);
    }
  return shape.translate(position as [number, number, number]);
}
function primitive(solid: Solid): Shape3D {
  const [x, y, z] = solid.dimensions;
  let shape: Shape3D;
  if (solid.shape === 'box')
    shape = makeBox([-x / 2, -y / 2, -z / 2], [x / 2, y / 2, z / 2]);
  else if (solid.shape === 'sphere') shape = makeEllipsoid(x / 2, y / 2, z / 2);
  else {
    let ellipse = drawEllipse(Math.max(x, z) / 2, Math.min(x, z) / 2);
    if (z > x) ellipse = ellipse.rotate(90);
    shape = ellipse.sketchOnPlane('XZ', [0, y / 2, 0]).extrude(y) as Shape3D;
  }
  return transform(shape, solid.position, solid.rotation);
}
function extrusion(input: CadFeature): Shape3D {
  const checked = cadFeatureSchema.safeParse(input);
  if (!checked.success)
    throw new Error(
      `${input.name}: ${checked.error.issues[0]?.message ?? 'Check the feature dimensions.'}`,
    );
  const feature = checked.data;
  const profile =
    feature.profile === 'circle'
      ? drawCircle(feature.radius)
      : drawRectangle(feature.width, feature.height);
  let result = profile
    .translate(feature.center)
    .sketchOnPlane(feature.plane, feature.offset)
    .extrude(feature.depth) as Shape3D;
  if (feature.fillet > 0) {
    const rounded = result.fillet(feature.fillet);
    result.delete();
    result = rounded;
  }
  return result;
}
function combine(
  previous: Shape3D | null,
  next: Shape3D,
  operation: 'union' | 'subtract' | 'intersect',
): Shape3D {
  if (!previous) {
    if (operation !== 'union') {
      next.delete();
      throw new Error('The first enabled CAD feature must add material.');
    }
    return next;
  }
  try {
    const result =
      operation === 'subtract'
        ? previous.cut(next)
        : operation === 'intersect'
          ? previous.intersect(next)
          : previous.fuse(next);
    previous.delete();
    return result;
  } finally {
    next.delete();
  }
}
export type CadKernelResult = {
  positions: Float32Array;
  volume: number;
  faces: number;
  solids: number;
};
/** Evaluate dimensioned operations with OCCT B-rep; rendering is a separate tessellation. */
export async function buildExactCad(
  content: SceneContent,
  load: (asset: SceneImport) => Promise<ArrayBuffer>,
): Promise<Shape3D | null> {
  if (
    content.solids.length > 80 ||
    (content.features?.length ?? 0) > 40 ||
    (content.imports?.length ?? 0) > 4
  )
    throw new Error(
      'Exact CAD supports 80 primitives, 40 sketch features, and four STEP imports.',
    );
  let result: Shape3D | null = null;
  try {
    for (const solid of content.solids.filter((s) => s.visible !== false))
      result = combine(
        result,
        primitive(solid),
        result ? (solid.operation ?? 'union') : 'union',
      );
    for (const asset of content.imports ?? []) {
      if (!asset.visible) continue;
      if (asset.format !== 'step')
        throw new Error(
          'CAD imports require STEP B-rep geometry; use a 3D scene for GLB/STL meshes.',
        );
      const bytes = await load(asset);
      if (!bytes.byteLength || bytes.byteLength > 10 * 1024 * 1024)
        throw new Error('STEP imports must be 10 MB or smaller.');
      // STEP reader units are process-global; do not inherit a prior export's model unit.
      getOC().Interface_Static.SetCVal('xstep.cascade.unit', 'MM');
      let shape = (await importSTEP(new Blob([bytes]))).asShape3D();
      shape = shape.scale(asset.scale * (content.unit === 'm' ? 0.001 : 1));
      result = combine(
        result,
        transform(shape, asset.position, asset.rotation),
        'union',
      );
    }
    for (const feature of content.features ?? [])
      if (feature.enabled)
        result = combine(result, extrusion(feature), feature.operation);
    return result;
  } catch (error) {
    result?.delete();
    throw error;
  }
}
export function tessellateExactCad(shape: Shape3D | null): CadKernelResult {
  if (!shape)
    return { positions: new Float32Array(), volume: 0, faces: 0, solids: 0 };
  const mesh = shape.mesh({ tolerance: 0.05, angularTolerance: 0.15 });
  if (mesh.triangles.length > 900000)
    throw new Error(
      'CAD tessellation exceeds 300,000 triangles. Simplify the model.',
    );
  const positions = new Float32Array(mesh.triangles.length * 3);
  mesh.triangles.forEach((index, vertex) => {
    positions[vertex * 3] = mesh.vertices[index * 3]!;
    positions[vertex * 3 + 1] = mesh.vertices[index * 3 + 1]!;
    positions[vertex * 3 + 2] = mesh.vertices[index * 3 + 2]!;
  });
  const faces = shape.faces,
    solids = shape.solids;
  const result = {
    positions,
    volume: measureVolume(shape),
    faces: faces.length,
    solids: solids.length,
  };
  faces.forEach((face) => face.delete());
  solids.forEach((solid) => solid.delete());
  if (!Number.isFinite(result.volume) || !positions.every(Number.isFinite))
    throw new Error('CAD evaluation produced non-finite geometry.');
  return result;
}
export async function exactStep(
  shape: Shape3D,
  unit: SceneContent['unit'],
): Promise<ArrayBuffer> {
  return exportSTEP([{ shape, name: 'Studio solid model' }], {
    unit,
    modelUnit: unit,
  }).arrayBuffer();
}
