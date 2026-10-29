import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ComponentRef,
} from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Grid, OrbitControls, TransformControls } from '@react-three/drei';
import { Mesh, Vector3 } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import {
  Box,
  Boxes,
  Circle,
  Copy,
  Cylinder,
  Download,
  Focus,
  Grid3X3,
  Move,
  Redo2,
  RotateCcw,
  Save,
  Scaling,
  Trash2,
  Undo2,
} from 'lucide-react';
import type { MediaProps } from '../App.tsx';
import {
  Badge,
  Button,
  Field,
  IconButton,
  Select,
  Spinner,
} from '../components/ui.tsx';
import { download } from '../lib.ts';
import type { Solid } from '../../shared/domain.ts';
import {
  bounded,
  convertUnits,
  degrees,
  disposeGroup,
  exportGroup,
  geometryFromPositions,
  newSolid,
  primitiveGeometry,
  radians,
  sceneBounds,
  type SceneContent,
  type TransformMode,
} from './scene/model.ts';
import './scene/editor.css';

type View = 'perspective' | 'front' | 'top' | 'right';
type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;
type Snapshot = { content: SceneContent; version: number };
const clone = <T,>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const shapeIcons = { box: Box, sphere: Circle, cylinder: Cylinder };

function webGLAvailable() {
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2');
    if (!context) return false;
    context.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}
function CameraRig({
  solids,
  view,
  focus,
  controls,
}: {
  solids: Solid[];
  view: View;
  focus: number;
  controls: RefObject<OrbitControlsImpl | null>;
}) {
  const { camera, size: viewport } = useThree();
  useEffect(() => {
    const bounds = sceneBounds(solids),
      center = bounds.getCenter(new Vector3()),
      size = bounds.getSize(new Vector3()),
      distance =
        Math.max(size.length(), 0.1) *
        1.45 *
        Math.max(1, viewport.height / Math.max(viewport.width, 1));
    const direction =
      view === 'top'
        ? new Vector3(0, 1, 0.0001)
        : view === 'front'
          ? new Vector3(0, 0.08, 1)
          : view === 'right'
            ? new Vector3(1, 0.08, 0)
            : new Vector3(1, 0.8, 1);
    camera.position
      .copy(center)
      .addScaledVector(direction.normalize(), distance);
    camera.near = Math.max(distance / 10000, 0.00001);
    camera.far = Math.max(distance * 1000, 1000);
    camera.updateProjectionMatrix();
    camera.lookAt(center);
    controls.current?.target.copy(center);
    controls.current?.update();
  }, [focus, view, camera, controls, viewport.width, viewport.height]);
  return null;
}
function Primitive({
  solid,
  selected,
  readOnly,
  mode,
  snap,
  unit,
  onSelect,
  onTransform,
  ghost = false,
}: {
  solid: Solid;
  selected: boolean;
  readOnly: boolean;
  mode: TransformMode;
  snap: boolean;
  unit: SceneContent['unit'];
  onSelect: () => void;
  onTransform: (solid: Solid) => void;
  ghost?: boolean;
}) {
  const mesh = useRef<Mesh>(null);
  const geometry = useMemo(() => primitiveGeometry(solid.shape), [solid.shape]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const element = (
    <mesh
      ref={mesh}
      geometry={geometry}
      position={solid.position}
      rotation={solid.rotation}
      scale={solid.dimensions}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      castShadow
      receiveShadow
    >
      <meshStandardMaterial
        color={solid.color}
        roughness={0.62}
        metalness={0.04}
        emissive={selected ? '#26263b' : '#000000'}
        emissiveIntensity={selected ? 0.18 : 0}
        wireframe={ghost}
      />
    </mesh>
  );
  if (!selected || readOnly) return element;
  return (
    <>
      {element}
      <TransformControls
        object={mesh as RefObject<Mesh>}
        mode={mode}
        space="world"
        size={0.8}
        translationSnap={snap ? (unit === 'mm' ? 1 : 0.1) : null}
        rotationSnap={snap ? radians(15) : null}
        scaleSnap={snap ? 0.1 : null}
        onMouseUp={() => {
          const m = mesh.current;
          if (!m) return;
          const next = {
            ...solid,
            position: m.position
              .toArray()
              .map((v) => bounded(v)) as Solid['position'],
            rotation: [m.rotation.x, m.rotation.y, m.rotation.z].map((v) =>
              bounded(v),
            ) as Solid['rotation'],
            dimensions: m.scale
              .toArray()
              .map((v) => bounded(Math.abs(v), 0.01)) as Solid['dimensions'],
          };
          onTransform(next);
        }}
      />
    </>
  );
}
function CadResult({
  positions,
  color,
  editing,
}: {
  positions: Float32Array;
  color: string;
  editing: boolean;
}) {
  const geometry = useMemo(() => geometryFromPositions(positions), [positions]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  if (!positions.length) return null;
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial
        color={color}
        roughness={0.55}
        metalness={0.08}
        transparent={editing}
        opacity={editing ? 0.25 : 1}
        depthWrite={!editing}
      />
    </mesh>
  );
}
function NumericVector({
  label,
  values,
  onChange,
  readOnly,
  min = -100000,
  max = 100000,
  suffix = '',
}: {
  label: string;
  values: number[];
  onChange: (index: number, value: number) => void;
  readOnly: boolean;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <div>
      <h3>
        {label}
        {suffix && <span className="muted"> · {suffix}</span>}
      </h3>
      <div className="scene-axis-inputs">
        {values.map((value, index) => (
          <label key={index}>
            {['X', 'Y', 'Z'][index]}
            <input
              aria-label={`${label} ${['X', 'Y', 'Z'][index]}`}
              type="number"
              min={min}
              max={max}
              step="any"
              value={Number(value.toFixed(4))}
              disabled={readOnly}
              onChange={(event) => {
                if (event.currentTarget.value !== '')
                  onChange(
                    index,
                    bounded(event.currentTarget.valueAsNumber, min, max),
                  );
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

export default function SceneEditor({
  artifact,
  readOnly,
  onSave,
  onDirty,
  onError,
}: MediaProps) {
  const cad = artifact.kind === 'cad';
  const [base, setBase] = useState<Snapshot>(() => ({
    content: clone(artifact.content) as SceneContent,
    version: artifact.version,
  }));
  const [draft, setDraft] = useState<SceneContent>(
    () => clone(artifact.content) as SceneContent,
  );
  const [selectedId, setSelectedId] = useState<string | null>(
      () => artifact.content.solids[0]?.id ?? null,
    ),
    [mode, setMode] = useState<TransformMode>('translate'),
    [snap, setSnap] = useState(cad),
    [view, setView] = useState<View>('perspective'),
    [focus, setFocus] = useState(0),
    [saving, setSaving] = useState(false),
    [exporting, setExporting] = useState(false),
    [showPrimitives, setShowPrimitives] = useState(true),
    [history, setHistory] = useState<SceneContent[]>([]),
    [future, setFuture] = useState<SceneContent[]>([]);
  const [webgl] = useState(webGLAvailable),
    [positions, setPositions] = useState<Float32Array | null>(null),
    [computing, setComputing] = useState(false),
    [kernelError, setKernelError] = useState('');
  const latest = useRef(draft),
    incoming = useRef(artifact);
  latest.current = draft;
  incoming.current = artifact;
  const controls = useRef<OrbitControlsImpl>(null);
  const dirty = !same(draft, base.content),
    remoteChanged =
      artifact.version !== base.version &&
      !same(artifact.content, base.content) &&
      !same(artifact.content, draft);
  const selected = draft.solids.find((s) => s.id === selectedId),
    editable = !readOnly && !saving;
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    if (artifact.version <= base.version) return;
    if (!dirty || same(artifact.content, draft)) {
      setBase({
        content: clone(artifact.content) as SceneContent,
        version: artifact.version,
      });
      setDraft(clone(artifact.content) as SceneContent);
      setHistory([]);
      setFuture([]);
    }
  }, [artifact.version, base.version, dirty]);
  const serialized = JSON.stringify(draft.solids);
  useEffect(() => {
    if (!cad) {
      setPositions(null);
      return;
    }
    let worker: Worker | undefined;
    let active = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    setComputing(true);
    setKernelError('');
    const start = setTimeout(() => {
      try {
        worker = new Worker(new URL('./scene/csg.worker.ts', import.meta.url), {
          type: 'module',
        });
        timeout = setTimeout(() => {
          worker?.terminate();
          if (active) {
            setComputing(false);
            setPositions(null);
            setKernelError(
              'The solid operation exceeded 20 seconds. Reduce the number of primitives or simplify overlaps.',
            );
          }
        }, 20000);
        worker.onmessage = (event) => {
          if (!active) return;
          clearTimeout(timeout);
          setComputing(false);
          if (event.data.error) {
            setKernelError(event.data.error);
            setPositions(null);
          } else setPositions(event.data.positions);
          worker?.terminate();
        };
        worker.onerror = () => {
          if (active) {
            clearTimeout(timeout);
            setComputing(false);
            setPositions(null);
            setKernelError(
              'The CAD worker could not load. Reload this view or export the editable artifact JSON.',
            );
          }
          worker?.terminate();
        };
        worker.postMessage({ solids: draft.solids });
      } catch (error) {
        setComputing(false);
        setPositions(null);
        setKernelError((error as Error).message);
      }
    }, 180);
    return () => {
      active = false;
      clearTimeout(start);
      clearTimeout(timeout);
      worker?.terminate();
    };
  }, [cad, serialized]);

  const edit = useCallback(
    (change: (current: SceneContent) => SceneContent) => {
      if (readOnly || saving) return;
      const current = latest.current,
        next = change(clone(current));
      if (same(current, next)) return;
      setHistory((previous) => [...previous.slice(-49), clone(current)]);
      setFuture([]);
      setDraft(next);
      latest.current = next;
    },
    [readOnly, saving],
  );
  function patchSolid(next: Solid) {
    edit((current) => ({
      ...current,
      solids: current.solids.map((s) => (s.id === next.id ? next : s)),
    }));
  }
  function updateVector(
    property: 'position' | 'rotation' | 'dimensions',
    index: number,
    value: number,
  ) {
    if (!selected) return;
    const values = [...selected[property]] as Solid['position'];
    values[index] = value;
    patchSolid({ ...selected, [property]: values });
  }
  function add(shape: Solid['shape']) {
    if (draft.solids.length >= (cad ? 80 : 200)) {
      onError(
        cad
          ? 'A CAD expression supports up to 80 primitives.'
          : 'A scene supports up to 200 solids.',
      );
      return;
    }
    const solid = newSolid(shape, draft.unit, draft.solids.length ? 1.3 : 0);
    edit((current) => ({ ...current, solids: [...current.solids, solid] }));
    setSelectedId(solid.id);
  }
  function duplicate() {
    if (!selected) return;
    const solid = {
      ...clone(selected),
      id: crypto.randomUUID(),
      position: selected.position.map(
        (n, i) => n + (i === 0 ? (draft.unit === 'mm' ? 5 : 0.5) : 0),
      ) as Solid['position'],
    };
    edit((current) => ({ ...current, solids: [...current.solids, solid] }));
    setSelectedId(solid.id);
  }
  function remove() {
    if (!selected) return;
    edit((current) => ({
      ...current,
      solids: current.solids.filter((s) => s.id !== selected.id),
    }));
    setSelectedId(null);
  }
  function undo() {
    if (!editable || !history.length) return;
    setFuture((old) => [clone(draft), ...old]);
    setDraft(clone(history[history.length - 1]!));
    setHistory((old) => old.slice(0, -1));
  }
  function redo() {
    if (!editable || !future.length) return;
    setHistory((old) => [...old, clone(draft)]);
    setDraft(clone(future[0]!));
    setFuture((old) => old.slice(1));
  }
  function loadLatest() {
    setDraft(clone(artifact.content) as SceneContent);
    setBase({
      content: clone(artifact.content) as SceneContent,
      version: artifact.version,
    });
    setHistory([]);
    setFuture([]);
    setSelectedId(artifact.content.solids[0]?.id ?? null);
  }
  async function save() {
    if (!editable || !dirty) return;
    const snapshot = clone(draft);
    const version = base.version;
    setSaving(true);
    try {
      await onSave(snapshot, version);
      setBase({ content: snapshot, version: version + 1 });
    } catch {
      /* Parent presents the actionable HTTP error. The draft is retained. */
    } finally {
      setSaving(false);
    }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input,textarea,select,[contenteditable=true]'))
        return;
      if (event.key === 'Escape') setSelectedId(null);
      if (!editable) return;
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        void save();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        remove();
      } else if (event.key === 'w') setMode('translate');
      else if (event.key === 'e') setMode('rotate');
      else if (event.key === 'r') setMode('scale');
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [editable, selectedId, draft, base.version]);
  async function exportModel(format: 'stl' | 'glb') {
    if (cad && (computing || kernelError || positions === null)) {
      onError('Wait for a valid CAD result before exporting.');
      return;
    }
    setExporting(true);
    const group = exportGroup(
      draft,
      cad ? (positions ?? undefined) : undefined,
      format === 'glb',
    );
    try {
      if (format === 'stl') {
        const result = new STLExporter().parse(group, { binary: true });
        download(
          `${artifact.title}.${draft.unit}.stl`,
          result.buffer,
          'model/stl',
        );
      } else {
        const result = await new GLTFExporter().parseAsync(group, {
          binary: true,
        });
        if (!(result instanceof ArrayBuffer))
          throw new Error('The exporter did not produce a binary glTF file.');
        download(`${artifact.title}.glb`, result, 'model/gltf-binary');
      }
    } catch (error) {
      onError(`Export failed: ${(error as Error).message}`);
    } finally {
      disposeGroup(group);
      setExporting(false);
    }
  }
  const modelBounds = useMemo(() => sceneBounds(draft.solids), [serialized]);
  const extent = Math.max(modelBounds.getSize(new Vector3()).length(), 1),
    gridCell = draft.unit === 'mm' ? 1 : 0.1;
  return (
    <section
      className="scene-editor"
      aria-label={cad ? 'CAD editor' : '3D scene editor'}
    >
      <div
        className="scene-toolbar"
        role="toolbar"
        aria-label="Scene editing tools"
      >
        <div className="scene-toolbar-group">
          <IconButton
            label="Add box"
            disabled={!editable}
            onClick={() => add('box')}
          >
            <Box />
          </IconButton>
          <IconButton
            label="Add sphere"
            disabled={!editable}
            onClick={() => add('sphere')}
          >
            <Circle />
          </IconButton>
          <IconButton
            label="Add cylinder"
            disabled={!editable}
            onClick={() => add('cylinder')}
          >
            <Cylinder />
          </IconButton>
        </div>
        <span className="toolbar-divider" />
        <div className="scene-toolbar-group">
          <IconButton
            label="Move · W"
            disabled={!editable}
            aria-pressed={mode === 'translate'}
            onClick={() => setMode('translate')}
          >
            <Move />
          </IconButton>
          <IconButton
            label="Rotate · E"
            disabled={!editable}
            aria-pressed={mode === 'rotate'}
            onClick={() => setMode('rotate')}
          >
            <RotateCcw />
          </IconButton>
          <IconButton
            label="Scale · R"
            disabled={!editable}
            aria-pressed={mode === 'scale'}
            onClick={() => setMode('scale')}
          >
            <Scaling />
          </IconButton>
        </div>
        <span className="toolbar-divider" />
        <IconButton
          label="Undo scene change"
          disabled={!editable || !history.length}
          onClick={undo}
        >
          <Undo2 />
        </IconButton>
        <IconButton
          label="Redo scene change"
          disabled={!editable || !future.length}
          onClick={redo}
        >
          <Redo2 />
        </IconButton>
        <IconButton label="Frame model" onClick={() => setFocus((v) => v + 1)}>
          <Focus />
        </IconButton>
        <IconButton
          label={draft.grid ? 'Hide grid' : 'Show grid'}
          disabled={!editable}
          aria-pressed={draft.grid}
          onClick={() =>
            edit((current) => ({ ...current, grid: !current.grid }))
          }
        >
          <Grid3X3 />
        </IconButton>
        <div className="scene-toolbar-spacer" />
        <Button
          size="sm"
          variant="outline"
          disabled={exporting || !draft.solids.length}
          onClick={() => void exportModel('stl')}
        >
          <Download />
          STL
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={exporting || !draft.solids.length}
          onClick={() => void exportModel('glb')}
        >
          <Download />
          GLB
        </Button>
        <Button
          size="sm"
          disabled={!editable || !dirty}
          onClick={() => void save()}
        >
          {saving ? (
            <Spinner label="Saving…" />
          ) : (
            <>
              <Save />
              Save
            </>
          )}
        </Button>
      </div>
      {remoteChanged && dirty && (
        <div className="scene-conflict" role="status">
          <span>
            A teammate saved a newer version. Your unsaved changes are retained;
            saving will report the version conflict.
          </span>
          <Button size="sm" variant="outline" onClick={loadLatest}>
            Load latest
          </Button>
        </div>
      )}
      <div className="scene-body">
        <div className="scene-viewport">
          <div className="scene-viewport-label">
            <Boxes size={14} />
            <span>{cad ? 'Solid modeling' : 'Perspective scene'}</span>
            <Badge>{draft.unit}</Badge>
          </div>
          <div className="scene-view-controls" aria-label="Camera views">
            {(['perspective', 'front', 'top', 'right'] as View[]).map((v) => (
              <button
                key={v}
                aria-pressed={view === v}
                title={`${v} view`}
                onClick={() => {
                  setView(v);
                  setFocus((n) => n + 1);
                }}
              >
                {v === 'perspective'
                  ? '3D'
                  : v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          {webgl ? (
            <Canvas
              camera={{
                position: [4, 3, 4],
                fov: 42,
                near: 0.001,
                far: 1000000,
              }}
              shadows
              dpr={[1, 1.8]}
              onPointerMissed={() => setSelectedId(null)}
              fallback={
                <div className="scene-fallback">
                  <h3>WebGL is unavailable</h3>
                  <p>
                    Enable hardware acceleration to use the 3D viewport.
                    Parameters and exports remain available.
                  </p>
                </div>
              }
            >
              <color attach="background" args={['#eef0ed']} />
              <ambientLight intensity={1.35} />
              <directionalLight
                position={[extent * 2, extent * 3, extent * 2]}
                intensity={2.8}
                castShadow
              />
              <directionalLight
                position={[-extent, extent, -extent]}
                intensity={0.8}
              />
              <OrbitControls
                ref={controls}
                makeDefault
                minDistance={0.01}
                maxDistance={1000000}
              />
              <CameraRig
                solids={draft.solids}
                view={view}
                focus={focus}
                controls={controls}
              />
              {draft.grid && (
                <Grid
                  args={[10, 10]}
                  cellSize={gridCell}
                  sectionSize={gridCell * 10}
                  cellColor="#d1d7cd"
                  sectionColor="#b4bdb0"
                  fadeDistance={extent * 10}
                  infiniteGrid
                  position={[0, -0.001, 0]}
                />
              )}
              {cad && positions && (
                <CadResult
                  positions={positions}
                  color={draft.solids[0]?.color ?? '#6b73d1'}
                  editing={false}
                />
              )}
              {(!cad || showPrimitives || kernelError || positions === null) &&
                draft.solids.map((solid) => (
                  <Primitive
                    key={solid.id}
                    solid={solid}
                    selected={solid.id === selectedId}
                    readOnly={!editable}
                    mode={mode}
                    snap={snap}
                    unit={draft.unit}
                    ghost={cad && positions !== null}
                    onSelect={() => setSelectedId(solid.id)}
                    onTransform={patchSolid}
                  />
                ))}
            </Canvas>
          ) : (
            <div className="scene-fallback">
              <Boxes size={32} />
              <h3>3D viewport needs WebGL 2</h3>
              <p>
                Enable browser hardware acceleration to navigate the model. You
                can still edit every parameter, save, and export STL or GLB.
              </p>
            </div>
          )}
          {cad && (computing || kernelError || positions?.length === 0) && (
            <div className="scene-computing" role="status">
              {computing ? (
                <Spinner label="Computing solid operations…" />
              ) : (
                kernelError ||
                'The current boolean expression produces an empty solid.'
              )}
            </div>
          )}
        </div>
        <aside className="scene-inspector" aria-label="Scene properties">
          <h3>{cad ? 'Solid expression' : 'Scene objects'}</h3>
          <div className="scene-solid-list">
            {draft.solids.map((solid, index) => {
              const Icon = shapeIcons[solid.shape];
              return (
                <button
                  className="scene-solid-item"
                  aria-pressed={solid.id === selectedId}
                  key={solid.id}
                  onClick={() => setSelectedId(solid.id)}
                >
                  <Icon size={14} />
                  <span>
                    {solid.shape.charAt(0).toUpperCase() + solid.shape.slice(1)}{' '}
                    {index + 1}
                  </span>
                  {cad && (
                    <small>
                      {index === 0 ? 'base' : (solid.operation ?? 'union')}
                    </small>
                  )}
                </button>
              );
            })}
            {!draft.solids.length && (
              <p className="scene-empty">
                Add a primitive to start your model.
              </p>
            )}
          </div>
          {selected ? (
            <>
              <div className="scene-toolbar-group">
                <IconButton
                  label="Duplicate selected solid"
                  disabled={
                    !editable || draft.solids.length >= (cad ? 80 : 200)
                  }
                  onClick={duplicate}
                >
                  <Copy />
                </IconButton>
                <IconButton
                  label="Delete selected solid"
                  disabled={!editable}
                  onClick={remove}
                >
                  <Trash2 />
                </IconButton>
              </div>
              <Field label="Shape">
                <Select
                  disabled={!editable}
                  value={selected.shape}
                  onChange={(event) =>
                    patchSolid({
                      ...selected,
                      shape: event.target.value as Solid['shape'],
                    })
                  }
                >
                  <option value="box">Box</option>
                  <option value="sphere">Sphere / ellipsoid</option>
                  <option value="cylinder">Cylinder</option>
                </Select>
              </Field>
              <NumericVector
                label="Position"
                values={selected.position}
                suffix={draft.unit}
                readOnly={!editable}
                onChange={(i, v) => updateVector('position', i, v)}
              />
              <NumericVector
                label="Rotation"
                values={selected.rotation.map(degrees)}
                suffix="degrees"
                readOnly={!editable}
                min={-36000}
                max={36000}
                onChange={(i, v) => updateVector('rotation', i, radians(v))}
              />
              <NumericVector
                label="Dimensions"
                values={selected.dimensions}
                suffix={draft.unit}
                readOnly={!editable}
                min={0.01}
                onChange={(i, v) => updateVector('dimensions', i, v)}
              />
              <label className="scene-color-field">
                <input
                  aria-label="Solid color"
                  type="color"
                  value={selected.color}
                  disabled={!editable}
                  onChange={(event) =>
                    patchSolid({ ...selected, color: event.target.value })
                  }
                />
                <span>{selected.color.toUpperCase()}</span>
              </label>
              {cad && draft.solids[0]?.id !== selected.id && (
                <Field label="Operation with previous result">
                  <Select
                    value={selected.operation ?? 'union'}
                    disabled={!editable}
                    onChange={(event) =>
                      patchSolid({
                        ...selected,
                        operation: event.target.value as Solid['operation'],
                      })
                    }
                  >
                    <option value="union">Union · add material</option>
                    <option value="subtract">Subtract · remove material</option>
                    <option value="intersect">Intersect · keep overlap</option>
                  </Select>
                </Field>
              )}
            </>
          ) : (
            <p className="scene-empty">
              Select a solid to edit its position, rotation, dimensions, and
              material.
            </p>
          )}
          <Field label="Coordinate units">
            <Select
              value={draft.unit}
              disabled={!editable}
              onChange={(event) => {
                try {
                  const unit = event.target.value as SceneContent['unit'];
                  edit((current) => convertUnits(current, unit));
                  setFocus((v) => v + 1);
                } catch (error) {
                  onError((error as Error).message);
                }
              }}
            >
              <option value="m">Meters</option>
              <option value="mm">Millimeters</option>
            </Select>
          </Field>
          <label className="scene-check">
            <input
              type="checkbox"
              checked={snap}
              onChange={(event) => setSnap(event.target.checked)}
            />
            Snap transforms ({draft.unit === 'mm' ? '1 mm' : '0.1 m'} / 15°)
          </label>
          {cad && (
            <label className="scene-check">
              <input
                type="checkbox"
                checked={showPrimitives}
                onChange={(event) => setShowPrimitives(event.target.checked)}
              />
              Show editable primitives
            </label>
          )}
          <p className="scene-kernel-note">
            {cad
              ? 'Boolean operations use the JSCAD solid kernel in a cancellable worker. Results are tessellated meshes; STEP/BREP and feature-history constraints are not supported.'
              : 'Meshes retain their individual transforms and materials in GLB exports. Orbit with drag, pan with right-drag, zoom with the wheel.'}
          </p>
        </aside>
      </div>
      <footer className="scene-statusbar">
        <span>
          {draft.solids.length} {draft.solids.length === 1 ? 'solid' : 'solids'}
          {cad && positions
            ? ` · ${(positions.length / 9).toLocaleString()} triangles`
            : ''}{' '}
          · {dirty ? 'Unsaved changes' : `Saved · v${base.version}`}
        </span>
        <span>
          STL coordinates: {draft.unit} · GLB: meters · W move / E rotate / R
          scale
        </span>
      </footer>
    </section>
  );
}
