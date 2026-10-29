import { BufferGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { SceneImport } from '../../../shared/cad-domain.ts';
import { disposeGroup } from './model.ts';

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
/** Inspect before GLTFLoader can initiate dependent requests. GLB must be self-contained. */
export function inspectGlb(buffer: ArrayBuffer) {
  if (buffer.byteLength < 20 || buffer.byteLength > MAX_IMPORT_BYTES)
    throw new Error('GLB must be between 20 bytes and 10 MB.');
  const view = new DataView(buffer);
  if (
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== buffer.byteLength
  )
    throw new Error('The file is not a complete glTF 2 binary container.');
  const length = view.getUint32(12, true);
  if (
    view.getUint32(16, true) !== 0x4e4f534a ||
    length > buffer.byteLength - 20 ||
    length > 2 * 1024 * 1024
  )
    throw new Error('GLB has an invalid or oversized JSON chunk.');
  const json = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 20, length)),
  );
  if (json.asset?.version !== '2.0')
    throw new Error('Only glTF 2.0 is supported.');
  if (
    (json.nodes?.length ?? 0) > 2000 ||
    (json.meshes?.length ?? 0) > 1000 ||
    (json.images?.length ?? 0) > 32
  )
    throw new Error('GLB exceeds the node, mesh, or image import limit.');
  for (const item of [...(json.buffers ?? []), ...(json.images ?? [])])
    if (item.uri)
      throw new Error(
        'GLB imports must embed their buffers and images; external or data-URI resources are not loaded.',
      );
  const primitives = (json.meshes ?? []).flatMap(
    (mesh: any) => mesh.primitives ?? [],
  );
  let totalVertices = 0;
  for (const primitive of primitives) {
    const position = json.accessors?.[primitive.attributes?.POSITION];
    if (
      !position ||
      !Number.isSafeInteger(position.count) ||
      position.count < 0 ||
      position.count > 600000
    )
      throw new Error('A GLB primitive exceeds 600,000 vertices.');
    totalVertices += position.count;
    if (totalVertices > 1200000)
      throw new Error('GLB scene exceeds 1,200,000 vertices.');
  }
  const nodes = json.nodes ?? [];
  const parents = new Uint16Array(nodes.length);
  for (const node of nodes)
    for (const child of node.children ?? []) {
      if (
        !Number.isInteger(child) ||
        child < 0 ||
        child >= nodes.length ||
        ++parents[child]! > 1
      )
        throw new Error(
          'GLB nodes must form an acyclic tree with one parent per node.',
        );
    }
  const queue: number[] = [];
  parents.forEach((count, index) => {
    if (count === 0) queue.push(index);
  });
  let visited = 0;
  while (queue.length) {
    const index = queue.pop()!;
    visited++;
    for (const child of nodes[index].children ?? [])
      if (--parents[child]! === 0) queue.push(child);
  }
  if (visited !== nodes.length)
    throw new Error('GLB nodes must form an acyclic tree.');
  return json;
}
export function parseStl(buffer: ArrayBuffer): BufferGeometry {
  if (!buffer.byteLength || buffer.byteLength > MAX_IMPORT_BYTES)
    throw new Error('STL imports are limited to 10 MB.');
  const geometry = new STLLoader().parse(buffer);
  const positions = geometry.getAttribute('position');
  if (
    !positions ||
    positions.count < 3 ||
    positions.count > 600000 ||
    !Array.from(positions.array).every(Number.isFinite)
  ) {
    geometry.dispose();
    throw new Error(
      'STL must contain finite geometry with at most 200,000 triangles.',
    );
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}
export async function fetchImport(asset: SceneImport): Promise<ArrayBuffer> {
  if (!/^\/api\/files\/[0-9a-f-]{36}$/.test(asset.src))
    throw new Error(
      'Imported geometry must be an authenticated project asset.',
    );
  const response = await fetch(asset.src, {
    credentials: 'same-origin',
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(`Could not load ${asset.name} (${response.status}).`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_IMPORT_BYTES)
    throw new Error('Imported geometry exceeds 10 MB.');
  return bytes;
}
export async function importObject(asset: SceneImport): Promise<Group> {
  const bytes = await fetchImport(asset);
  const group = new Group();
  group.name = asset.name;
  if (asset.format === 'stl')
    group.add(
      new Mesh(
        parseStl(bytes),
        new MeshStandardMaterial({
          color: asset.color,
          roughness: asset.roughness,
          metalness: asset.metalness,
        }),
      ),
    );
  else if (asset.format === 'glb') {
    inspectGlb(bytes);
    const result = await new GLTFLoader().parseAsync(bytes, '');
    let vertices = 0;
    try {
      result.scene.traverse((object) => {
        if (object instanceof Mesh) {
          const position = object.geometry.getAttribute('position');
          if (!position || !Array.from(position.array).every(Number.isFinite))
            throw new Error(
              'GLB geometry must contain finite position coordinates.',
            );
          vertices += position.count;
          if (vertices > 1200000)
            throw new Error('GLB scene exceeds 1,200,000 vertices.');
        }
      });
    } catch (error) {
      disposeGroup(result.scene);
      throw error;
    }
    group.add(result.scene);
  } else throw new Error('STEP imports are evaluated by the CAD kernel.');
  group.position.set(...asset.position);
  group.rotation.set(...asset.rotation);
  group.scale.setScalar(asset.scale);
  group.visible = asset.visible;
  group.updateMatrixWorld(true);
  return group;
}
