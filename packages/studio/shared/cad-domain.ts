import { z } from 'zod';

const coordinate = z.number().finite().min(-100000).max(100000);
const dimension = z.number().finite().min(0.01).max(100000);
const vector = z.tuple([coordinate, coordinate, coordinate]);
const localAsset = z.string().regex(/^\/api\/files\/[0-9a-f-]{36}$/);

/** Declarative, dimension-driven profiles. The worker never evaluates user source. */
export const cadFeatureSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    enabled: z.boolean(),
    operation: z.enum(['union', 'subtract', 'intersect']),
    profile: z.enum(['rectangle', 'circle']),
    plane: z.enum(['XY', 'XZ', 'YZ']),
    center: z.tuple([coordinate, coordinate]),
    offset: coordinate,
    width: dimension,
    height: dimension,
    radius: dimension,
    depth: dimension,
    fillet: z.number().finite().min(0).max(10000),
  })
  .strict()
  .superRefine((feature, context) => {
    const limit =
      Math.min(
        feature.depth,
        feature.profile === 'circle'
          ? feature.radius * 2
          : Math.min(feature.width, feature.height),
      ) / 2;
    if (feature.fillet >= limit && feature.fillet !== 0)
      context.addIssue({
        code: 'custom',
        path: ['fillet'],
        message:
          'Fillet radius must be less than half the smallest feature dimension.',
      });
  });
export type CadFeature = z.infer<typeof cadFeatureSchema>;

export const sceneImportSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    format: z.enum(['glb', 'stl', 'step']),
    src: localAsset,
    position: vector,
    rotation: vector,
    scale: z.number().finite().min(0.00001).max(100000),
    visible: z.boolean(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    roughness: z.number().finite().min(0).max(1),
    metalness: z.number().finite().min(0).max(1),
  })
  .strict();
export type SceneImport = z.infer<typeof sceneImportSchema>;

export const sceneEnvironmentSchema = z
  .object({
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    ambient: z.number().finite().min(0).max(5),
    key: z.number().finite().min(0).max(10),
    shadows: z.boolean(),
  })
  .strict();
export type SceneEnvironment = z.infer<typeof sceneEnvironmentSchema>;
export const defaultEnvironment: SceneEnvironment = {
  background: '#eef0ed',
  ambient: 1.35,
  key: 2.8,
  shadows: true,
};
export function newCadFeature(
  unit: 'm' | 'mm',
  profile: CadFeature['profile'] = 'rectangle',
): CadFeature {
  const size = unit === 'mm' ? 20 : 1;
  return {
    id: crypto.randomUUID(),
    name: profile === 'circle' ? 'Circular extrusion' : 'Rectangle extrusion',
    enabled: true,
    operation: 'union',
    profile,
    plane: 'XY',
    center: [0, 0],
    offset: 0,
    width: size,
    height: size,
    radius: size / 4,
    depth: size / 2,
    fillet: 0,
  };
}
