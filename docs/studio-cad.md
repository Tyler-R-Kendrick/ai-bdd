# Studio 3D and CAD canvases

A scene and a CAD model are separate artifact media types. Both retain their own artifact conversation, ADR, version history, role enforcement, local draft conflicts, and undo/redo.

## CAD: dimensioned sketches and exact solid interchange

The CAD canvas uses Open CASCADE Technology through separately loaded JavaScript/WASM in a cancellable worker. Its model is a declarative, bounded feature history; it does not evaluate uploaded scripts.

A base can contain ordered boxes, ellipsoids, elliptical cylinders, and up to four authenticated STEP imports. Dimensional sketch features then add, remove, or intersect material. A rectangle is driven by width, height, center, sketch plane, and plane offset; a circle uses its radius and the same placement constraints. Extrusion depth and optional rolling-edge fillet create the solid. Change a dimension to regenerate the B-rep, reorder features with the arrows, or suppress a feature to compare the result. Primitives can also be reordered and assigned union/subtract/intersect operations.

The viewport is a tessellation of the B-rep, while the volume and face count come from the kernel's solid model. The interface displays those measurements only for a completed current evaluation. Pending or invalid operations prevent export. A retry action is available after a kernel loading/computation failure. Operations exceeding 30 seconds terminate their worker rather than blocking the document UI.

STEP export preserves analytic faces and units. Imported STEP geometry becomes a base on which later sketch features operate. The acceptance workflow independently checks a plate with a cylindrical hole, STEP download/upload, additional machining of the imported base, and persistence after reload. Unit tests compare analytic volume and round-trip meter metadata, not only a file extension or screenshot.

The supported feature construction is explicitly dimension-driven rectangle/circle extrusion and fillet, with ordered boolean operations. It does not imply a universal geometric-constraint solver, proprietary CAD feature interchange, or preservation of another CAD system's editable feature tree. STEP exchanges the B-rep, not the source system's parametric history.

## 3D scenes: meshes, materials, and lighting

Scenes support individual primitive transforms, names, visibility, metalness, and roughness. Background, ambient/key illumination, and shadows are editable. Import a self-contained GLB or STL project asset, transform it as an assembly, and export a composed GLB/STL. Embedded glTF node hierarchy and materials are retained. Three.js normalizes names for internal binding; static exports restore the original source names retained in glTF metadata.

GLB files must contain their binary data and images in the container. External and data-URI resources are refused before loading; the loader never fetches an arbitrary dependency URL supplied by a model. Imports are bounded to 10 MB, 2,000 nodes, 1,000 meshes, 32 images, 600,000 vertices per primitive, and 1,200,000 vertices per assembly. Cyclic or shared-parent node graphs are rejected. Geometry remains project-owned and is fetched through the same authenticated file API as other artifact media.

Exports are static scene snapshots. Embedded animation tracks and external Draco/KTX decoder configuration are not an authoring or interchange feature of this canvas. Use the video canvas for timed media composition.

## Units and permissions

STL has no unit metadata; its download filename includes the model's coordinate unit. GLB exports use meters. STEP reads exchange-file units and normalizes them to the current model; export writes explicit unit metadata. Changing units converts primitive, sketch, and import transforms while preserving physical dimensions, or rejects the change if supported numeric bounds would be exceeded.

Viewers may inspect and export authorized content. Editing, importing, renaming, visibility, feature construction, materials, lighting, and saves are disabled for viewers, and the server independently rejects writes. A version conflict retains the local model instead of silently overwriting a teammate.

Library source/build/replacement and redistribution notices are served at [`/licenses/cad-kernel-source.md`](../packages/studio/public/licenses/cad-kernel-source.md). The main application retains its script policy. Only the trusted compiled CAD worker response permits the binding library's required dynamic invokers; the worker has no DOM, external network permission, or uploaded JavaScript path.
