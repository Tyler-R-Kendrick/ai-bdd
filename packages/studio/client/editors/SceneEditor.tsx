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
import { Box3, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
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
  Upload,
  Plus,
  Eye,
  EyeOff,
  ArrowUp,
  ArrowDown,
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
import { api, download } from '../lib.ts';
import {
  newCadFeature,
  defaultEnvironment,
  type CadFeature,
  type SceneImport,
} from '../../shared/cad-domain.ts';
import { FeatureInspector } from './scene/FeatureInspector.tsx';
import {
  importObject,
  inspectGlb,
  parseStl,
  MAX_IMPORT_BYTES,
} from './scene/imports.ts';
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
  type Solid,
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
  modelBounds,
  view,
  focus,
  controls,
}: {
  solids: Solid[];
  modelBounds?: Box3;
  view: View;
  focus: number;
  controls: RefObject<OrbitControlsImpl | null>;
}) {
  const { camera, size: viewport } = useThree();
  useEffect(() => {
    const bounds = modelBounds ?? sceneBounds(solids),
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
  }, [
    focus,
    view,
    camera,
    controls,
    viewport.width,
    viewport.height,
    modelBounds,
  ]);
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
        roughness={solid.roughness ?? 0.62}
        metalness={solid.metalness ?? 0.04}
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

function ImportedGeometry({
  asset,
  selected,
  readOnly,
  mode,
  onSelect,
  onChange,
  onError,
  onBounds,
}: {
  asset: SceneImport;
  selected: boolean;
  readOnly: boolean;
  mode: TransformMode;
  onSelect: () => void;
  onChange: (asset: SceneImport) => void;
  onError: (message: string) => void;
  onBounds: (id: string, bounds: Box3) => void;
}) {
  const [object, setObject] = useState<Group | null>(null);
  useEffect(() => {
    let active = true;
    let loaded: Group | undefined;
    void importObject(asset)
      .then((group) => {
        loaded = group;
        if (active) setObject(group);
        else disposeGroup(group);
      })
      .catch((error) => {
        if (active) onError(`Import failed: ${(error as Error).message}`);
      });
    return () => {
      active = false;
      if (loaded) disposeGroup(loaded);
    };
  }, [asset.src]);
  useEffect(() => {
    if (!object) return;
    object.position.set(...asset.position);
    object.rotation.set(...asset.rotation);
    object.scale.setScalar(asset.scale);
    object.updateMatrixWorld(true);
    if (asset.format === 'stl')
      object.traverse((item) => {
        if (
          item instanceof Mesh &&
          item.material instanceof MeshStandardMaterial
        ) {
          item.material.color.set(asset.color);
          item.material.roughness = asset.roughness;
          item.material.metalness = asset.metalness;
        }
      });
    onBounds(asset.id, new Box3().setFromObject(object));
  }, [object, JSON.stringify(asset), onBounds]);
  if (!object) return null;
  return (
    <>
      <primitive
        object={object}
        onClick={(event: any) => {
          event.stopPropagation();
          onSelect();
        }}
      />
      {selected && !readOnly && (
        <TransformControls
          object={object}
          mode={mode}
          space="world"
          size={0.8}
          onMouseUp={() => {
            const scale = Math.max(Math.abs(object.scale.x), 0.00001);
            onChange({
              ...asset,
              position: object.position
                .toArray()
                .map((value) => bounded(value)) as [number, number, number],
              rotation: [
                object.rotation.x,
                object.rotation.y,
                object.rotation.z,
              ].map((value) => bounded(value)) as [number, number, number],
              scale: bounded(scale, 0.00001),
            });
          }}
        />
      )}
    </>
  );
}

function ImportedInspector({
  asset,
  disabled,
  onChange,
  onRemove,
}: {
  asset: SceneImport;
  disabled: boolean;
  onChange: (asset: SceneImport) => void;
  onRemove: () => void;
}) {
  return (
    <div className="scene-import-inspector">
      <Field label="Imported object name">
        <input
          aria-label="Imported object name"
          value={asset.name}
          maxLength={120}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...asset,
              name: event.target.value || 'Imported geometry',
            })
          }
        />
      </Field>
      <Badge>{asset.format.toUpperCase()} · project asset</Badge>
      <NumericVector
        label="Import position"
        values={asset.position}
        readOnly={disabled}
        onChange={(index, value) => {
          const position = [...asset.position] as SceneImport['position'];
          position[index] = value;
          onChange({ ...asset, position });
        }}
      />
      <NumericVector
        label="Import rotation"
        values={asset.rotation.map(degrees)}
        readOnly={disabled}
        suffix="degrees"
        onChange={(index, value) => {
          const rotation = [...asset.rotation] as SceneImport['rotation'];
          rotation[index] = radians(value);
          onChange({ ...asset, rotation });
        }}
      />
      <Field label="Uniform import scale">
        <input
          aria-label="Uniform import scale"
          type="number"
          min={0.00001}
          max={100000}
          step="any"
          value={asset.scale}
          disabled={disabled}
          onChange={(event) => {
            const scale = event.currentTarget.valueAsNumber;
            if (Number.isFinite(scale) && scale >= 0.00001 && scale <= 100000)
              onChange({ ...asset, scale });
          }}
        />
      </Field>
      <label className="scene-check">
        <input
          type="checkbox"
          checked={asset.visible}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...asset, visible: event.target.checked })
          }
        />
        Include in model
      </label>
      {asset.format === 'stl' ? (
        <>
          <Field label="Imported material color">
            <input
              type="color"
              aria-label="Imported material color"
              value={asset.color}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...asset, color: event.target.value })
              }
            />
          </Field>
          <Field label="Imported material roughness">
            <input
              type="range"
              aria-label="Imported material roughness"
              min="0"
              max="1"
              step="0.01"
              value={asset.roughness}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...asset, roughness: Number(event.target.value) })
              }
            />
          </Field>
        </>
      ) : (
        <p className="scene-kernel-note">
          {asset.format === 'glb'
            ? 'Embedded glTF materials and node hierarchy are retained in the preview and exports.'
            : 'STEP units are read by OpenCascade and converted to the model coordinate units.'}
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={onRemove}
      >
        <Trash2 />
        Remove imported object
      </Button>
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
    [kernelError, setKernelError] = useState(''),
    [kernelStats, setKernelStats] = useState<{
      volume: number;
      faces: number;
      solids: number;
    } | null>(null),
    [importing, setImporting] = useState(false),
    [kernelAttempt, setKernelAttempt] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef(draft),
    incoming = useRef(artifact);
  latest.current = draft;
  incoming.current = artifact;
  const controls = useRef<OrbitControlsImpl>(null);
  const [importedBounds, setImportedBounds] = useState<Record<string, Box3>>(
    {},
  );
  const rememberBounds = useCallback(
    (id: string, bounds: Box3) =>
      setImportedBounds((previous) =>
        previous[id]?.equals(bounds) ? previous : { ...previous, [id]: bounds },
      ),
    [],
  );
  const dirty = !same(draft, base.content),
    remoteChanged =
      artifact.version !== base.version &&
      !same(artifact.content, base.content) &&
      !same(artifact.content, draft);
  const selected = draft.solids.find((s) => s.id === selectedId),
    selectedFeature = draft.features?.find(
      (feature) => feature.id === selectedId,
    ),
    selectedImport = draft.imports?.find((asset) => asset.id === selectedId),
    environment = draft.environment ?? defaultEnvironment,
    editable = !readOnly && !saving && !importing;
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
  const serialized = JSON.stringify({
    solids: draft.solids,
    features: draft.features,
    imports: draft.imports,
    unit: draft.unit,
  });
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
        worker = new Worker(
          new URL('./scene/kernel.worker.ts', import.meta.url),
          {
            type: 'module',
          },
        );
        timeout = setTimeout(() => {
          worker?.terminate();
          if (active) {
            setComputing(false);
            setPositions(null);
            setKernelError(
              'The CAD operation exceeded 30 seconds. Simplify the feature history or imported STEP geometry, then retry.',
            );
          }
        }, 30000);
        worker.onmessage = (event) => {
          if (!active) return;
          clearTimeout(timeout);
          setComputing(false);
          if (event.data.error) {
            setKernelError(event.data.error);
            setPositions(null);
          } else {
            setPositions(event.data.positions);
            setKernelStats({
              volume: event.data.volume,
              faces: event.data.faces,
              solids: event.data.solids,
            });
          }
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
        worker.postMessage({ id: 1, content: draft, format: 'mesh' });
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
  }, [cad, serialized, kernelAttempt]);

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
  function addFeature(profile: CadFeature['profile']) {
    if ((draft.features?.length ?? 0) >= 40) {
      onError('A CAD model supports at most 40 sketch features.');
      return;
    }
    const feature = newCadFeature(draft.unit, profile);
    edit((current) => ({
      ...current,
      features: [...(current.features ?? []), feature],
    }));
    setSelectedId(feature.id);
  }
  function reorderFeature(id: string, direction: number) {
    edit((current) => {
      const features = [...(current.features ?? [])];
      const index = features.findIndex((feature) => feature.id === id);
      const destination = index + direction;
      if (index < 0 || destination < 0 || destination >= features.length)
        return current;
      [features[index], features[destination]] = [
        features[destination]!,
        features[index]!,
      ];
      return { ...current, features };
    });
  }
  function reorderSolid(direction: number) {
    edit((current) => {
      const solids = [...current.solids];
      const index = solids.findIndex((solid) => solid.id === selectedId);
      const destination = index + direction;
      if (index < 0 || destination < 0 || destination >= solids.length)
        return current;
      [solids[index], solids[destination]] = [
        solids[destination]!,
        solids[index]!,
      ];
      return { ...current, solids };
    });
  }
  async function uploadGeometry(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !editable) return;
    if ((draft.imports?.length ?? 0) >= (cad ? 4 : 30)) {
      onError(`This model supports at most ${cad ? 4 : 30} imported files.`);
      return;
    }
    if (!file.size || file.size > MAX_IMPORT_BYTES) {
      onError('Choose a geometry file of 10 MB or smaller.');
      return;
    }
    const extension = file.name.split('.').pop()?.toLowerCase();
    const format =
      extension === 'step' || extension === 'stp'
        ? 'step'
        : extension === 'stl'
          ? 'stl'
          : extension === 'glb'
            ? 'glb'
            : null;
    if (!format || (cad ? format !== 'step' : format === 'step')) {
      onError(
        cad
          ? 'Choose a STEP (.step or .stp) solid model.'
          : 'Choose a self-contained GLB or STL mesh. STEP belongs in a CAD model.',
      );
      return;
    }
    setImporting(true);
    try {
      const bytes = await file.arrayBuffer();
      if (format === 'glb') inspectGlb(bytes);
      if (format === 'stl') parseStl(bytes).dispose();
      if (
        format === 'step' &&
        !new TextDecoder().decode(bytes.slice(0, 512)).includes('ISO-10303-21;')
      )
        throw new Error(
          'The selected file is not an ISO 10303-21 STEP exchange file.',
        );
      const form = new FormData();
      form.append('file', file);
      const uploaded = await api<{ url: string; mime: string }>(
        `/artifacts/${artifact.id}/files`,
        'POST',
        form,
      );
      const asset: SceneImport = {
        id: crypto.randomUUID(),
        name: file.name.slice(0, 120),
        format,
        src: uploaded.url,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: format === 'glb' && draft.unit === 'mm' ? 1000 : 1,
        visible: true,
        color: '#6b73d1',
        roughness: 0.62,
        metalness: 0.04,
      };
      // edit uses the latest draft; it never replaces another change made during upload.
      const current = latest.current;
      const next = { ...current, imports: [...(current.imports ?? []), asset] };
      setHistory((previous) => [...previous.slice(-49), clone(current)]);
      setFuture([]);
      setDraft(next);
      latest.current = next;
      setSelectedId(asset.id);
      setFocus((value) => value + 1);
    } catch (error) {
      onError(`Import failed: ${(error as Error).message}`);
    } finally {
      setImporting(false);
    }
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
    if (selectedFeature) {
      edit((current) => ({
        ...current,
        features: current.features?.filter(
          (feature) => feature.id !== selectedFeature.id,
        ),
      }));
      setSelectedId(null);
      return;
    }
    if (selectedImport) {
      edit((current) => ({
        ...current,
        imports: current.imports?.filter(
          (asset) => asset.id !== selectedImport.id,
        ),
      }));
      setSelectedId(null);
      return;
    }
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
  async function exportModel(format: 'stl' | 'glb' | 'step') {
    if (cad && (computing || kernelError || positions === null)) {
      onError('Wait for a valid CAD result before exporting.');
      return;
    }
    setExporting(true);
    if (format === 'step') {
      let worker: Worker | undefined;
      try {
        worker = new Worker(
          new URL('./scene/kernel.worker.ts', import.meta.url),
          { type: 'module' },
        );
        const data = await new Promise<ArrayBuffer>((resolve, reject) => {
          const timeout = setTimeout(
            () =>
              reject(
                new Error(
                  'STEP export exceeded 30 seconds. Simplify the model.',
                ),
              ),
            30000,
          );
          worker!.onmessage = (event) => {
            clearTimeout(timeout);
            if (event.data.error) reject(new Error(event.data.error));
            else resolve(event.data.data);
          };
          worker!.onerror = () => {
            clearTimeout(timeout);
            reject(new Error('The CAD export worker could not load.'));
          };
          worker!.postMessage({ id: 1, content: draft, format: 'step' });
        });
        download(`${artifact.title}.step`, data, 'model/step');
      } catch (error) {
        onError(`STEP export failed: ${(error as Error).message}`);
      } finally {
        worker?.terminate();
        setExporting(false);
      }
      return;
    }
    const group = exportGroup(
      draft,
      cad ? (positions ?? undefined) : undefined,
      format === 'glb',
    );
    try {
      if (!cad)
        for (const asset of draft.imports ?? [])
          if (asset.visible) group.add(await importObject(asset));
      // Three normalizes imported names for animation binding, retaining source names in extras.
      // These exports are static scene snapshots, so restore their source names for interchange.
      group.traverse((object) => {
        if (typeof object.userData.name === 'string')
          object.name = object.userData.name;
      });
      group.updateMatrixWorld(true);
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
  const modelBounds = useMemo(() => {
    const bounds = sceneBounds(draft.solids);
    if (cad && positions?.length) {
      bounds.makeEmpty();
      const point = new Vector3();
      for (let i = 0; i < positions.length; i += 3)
        bounds.expandByPoint(
          point.set(positions[i]!, positions[i + 1]!, positions[i + 2]!),
        );
    }
    if (!cad)
      for (const asset of draft.imports ?? [])
        if (asset.visible && importedBounds[asset.id])
          bounds.union(importedBounds[asset.id]!);
    return bounds;
  }, [serialized, positions, importedBounds]);
  const itemCount =
    draft.solids.length +
    (draft.features?.length ?? 0) +
    (draft.imports?.length ?? 0);
  const hasGeometry = itemCount > 0;
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
        {cad && (
          <>
            <IconButton
              label="Add rectangle sketch extrusion"
              disabled={!editable}
              onClick={() => addFeature('rectangle')}
            >
              <Plus />
            </IconButton>
            <IconButton
              label="Add circular sketch extrusion"
              disabled={!editable}
              onClick={() => addFeature('circle')}
            >
              <Circle />
            </IconButton>
            <span className="toolbar-divider" />
          </>
        )}
        <IconButton
          label={cad ? 'Import STEP solid' : 'Import GLB or STL'}
          disabled={!editable}
          onClick={() => fileInput.current?.click()}
        >
          <Upload />
        </IconButton>
        <input
          ref={fileInput}
          type="file"
          hidden
          disabled={!editable}
          accept={cad ? '.step,.stp' : '.glb,.stl'}
          aria-label={cad ? 'STEP file' : 'GLB or STL file'}
          onChange={(event) => void uploadGeometry(event)}
        />
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
          disabled={exporting || !hasGeometry}
          onClick={() => void exportModel('stl')}
        >
          <Download />
          STL
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={exporting || !hasGeometry}
          onClick={() => void exportModel('glb')}
        >
          <Download />
          GLB
        </Button>
        {cad && (
          <Button
            size="sm"
            variant="outline"
            disabled={exporting || !hasGeometry || computing || !!kernelError}
            onClick={() => void exportModel('step')}
          >
            <Download />
            STEP
          </Button>
        )}
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
            {cad && kernelStats && !computing && !kernelError && (
              <Badge>B-rep · {kernelStats.faces} faces</Badge>
            )}
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
              shadows={environment.shadows}
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
              <color attach="background" args={[environment.background]} />
              <ambientLight intensity={environment.ambient} />
              <directionalLight
                position={[extent * 2, extent * 3, extent * 2]}
                intensity={environment.key}
                castShadow={environment.shadows}
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
                modelBounds={modelBounds}
                view={view}
                focus={focus}
                controls={controls}
              />
              {!cad &&
                draft.imports
                  ?.filter((asset) => asset.visible)
                  .map((asset) => (
                    <ImportedGeometry
                      key={asset.id}
                      asset={asset}
                      selected={asset.id === selectedId}
                      readOnly={!editable}
                      mode={mode}
                      onSelect={() => setSelectedId(asset.id)}
                      onChange={(next) =>
                        edit((current) => ({
                          ...current,
                          imports: current.imports?.map((item) =>
                            item.id === next.id ? next : item,
                          ),
                        }))
                      }
                      onError={onError}
                      onBounds={rememberBounds}
                    />
                  ))}
              {draft.grid && (
                <Grid
                  args={[10, 10]}
                  cellSize={gridCell}
                  sectionSize={gridCell * 10}
                  cellColor="#d1d7cd"
                  sectionColor="#b4bdb0"
                  fadeDistance={extent * 10}
                  infiniteGrid
                  position={[
                    0,
                    Math.min(0, modelBounds.min.y) - gridCell * 0.01,
                    0,
                  ]}
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
                draft.solids
                  .filter((solid) => solid.visible !== false)
                  .map((solid) => (
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
              {kernelError && !computing && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setKernelAttempt((value) => value + 1)}
                >
                  Retry CAD evaluation
                </Button>
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
                    {solid.name ??
                      `${solid.shape.charAt(0).toUpperCase() + solid.shape.slice(1)} ${index + 1}`}
                    {solid.visible === false && <EyeOff size={11} />}
                  </span>
                  {cad && (
                    <small>
                      {index === 0 ? 'base' : (solid.operation ?? 'union')}
                    </small>
                  )}
                </button>
              );
            })}
            {!draft.solids.length &&
              !draft.features?.length &&
              !draft.imports?.length && (
                <p className="scene-empty">
                  Add a primitive to start your model.
                </p>
              )}
          </div>
          {cad && (
            <div className="cad-feature-list" aria-label="CAD feature history">
              <h3>Sketch feature history</h3>
              {(draft.features ?? []).map((feature, index) => (
                <div className="cad-feature-row" key={feature.id}>
                  <button
                    className="scene-solid-item"
                    aria-pressed={selectedId === feature.id}
                    onClick={() => setSelectedId(feature.id)}
                  >
                    <span>{feature.name}</span>
                    <small>
                      {feature.enabled ? feature.operation : 'suppressed'}
                    </small>
                  </button>
                  <IconButton
                    label={`Move ${feature.name} earlier`}
                    disabled={!editable || index === 0}
                    onClick={() => reorderFeature(feature.id, -1)}
                  >
                    <ArrowUp />
                  </IconButton>
                  <IconButton
                    label={`Move ${feature.name} later`}
                    disabled={
                      !editable || index === (draft.features?.length ?? 0) - 1
                    }
                    onClick={() => reorderFeature(feature.id, 1)}
                  >
                    <ArrowDown />
                  </IconButton>
                </div>
              ))}
              {!draft.features?.length && (
                <p className="scene-empty">
                  Add a dimensioned rectangle or circle, then extrude it into a
                  solid.
                </p>
              )}
              {selectedFeature && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!editable}
                  onClick={remove}
                >
                  <Trash2 />
                  Delete feature
                </Button>
              )}
            </div>
          )}
          {!!draft.imports?.length && (
            <div className="scene-import-list" aria-label="Imported geometry">
              <h3>Imported geometry</h3>
              {draft.imports.map((asset) => (
                <button
                  className="scene-solid-item"
                  key={asset.id}
                  aria-pressed={selectedId === asset.id}
                  onClick={() => setSelectedId(asset.id)}
                >
                  {asset.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                  <span>{asset.name}</span>
                  <small>{asset.format.toUpperCase()}</small>
                </button>
              ))}
            </div>
          )}
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
                {cad && (
                  <>
                    <IconButton
                      label="Move selected solid earlier"
                      disabled={!editable || draft.solids[0]?.id === selectedId}
                      onClick={() => reorderSolid(-1)}
                    >
                      <ArrowUp />
                    </IconButton>
                    <IconButton
                      label="Move selected solid later"
                      disabled={
                        !editable ||
                        draft.solids[draft.solids.length - 1]?.id === selectedId
                      }
                      onClick={() => reorderSolid(1)}
                    >
                      <ArrowDown />
                    </IconButton>
                  </>
                )}
              </div>
              <Field label="Object name">
                <input
                  aria-label="Object name"
                  value={selected.name ?? selected.shape}
                  maxLength={120}
                  disabled={!editable}
                  onChange={(event) =>
                    patchSolid({ ...selected, name: event.target.value })
                  }
                />
              </Field>
              <label className="scene-check">
                <input
                  type="checkbox"
                  checked={selected.visible !== false}
                  disabled={!editable}
                  onChange={(event) =>
                    patchSolid({ ...selected, visible: event.target.checked })
                  }
                />
                Include in model
              </label>
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
              <Field label="Roughness">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  aria-label="Material roughness"
                  value={selected.roughness ?? 0.62}
                  disabled={!editable}
                  onChange={(event) =>
                    patchSolid({
                      ...selected,
                      roughness: Number(event.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Metalness">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  aria-label="Material metalness"
                  value={selected.metalness ?? 0.04}
                  disabled={!editable}
                  onChange={(event) =>
                    patchSolid({
                      ...selected,
                      metalness: Number(event.target.value),
                    })
                  }
                />
              </Field>
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
          ) : selectedFeature ? (
            <FeatureInspector
              feature={selectedFeature}
              disabled={!editable}
              unit={draft.unit}
              onChange={(next) =>
                edit((current) => ({
                  ...current,
                  features: current.features?.map((feature) =>
                    feature.id === next.id ? next : feature,
                  ),
                }))
              }
            />
          ) : selectedImport ? (
            <ImportedInspector
              asset={selectedImport}
              disabled={!editable}
              onChange={(next) =>
                edit((current) => ({
                  ...current,
                  imports: current.imports?.map((asset) =>
                    asset.id === next.id ? next : asset,
                  ),
                }))
              }
              onRemove={() => {
                edit((current) => ({
                  ...current,
                  imports: current.imports?.filter(
                    (asset) => asset.id !== selectedImport.id,
                  ),
                }));
                setSelectedId(null);
              }}
            />
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
          <div className="scene-lighting" aria-label="Scene lighting">
            <h3>Lighting and background</h3>
            <Field label="Viewport background">
              <input
                aria-label="Viewport background"
                type="color"
                value={environment.background}
                disabled={!editable}
                onChange={(event) =>
                  edit((current) => ({
                    ...current,
                    environment: {
                      ...(current.environment ?? defaultEnvironment),
                      background: event.target.value,
                    },
                  }))
                }
              />
            </Field>
            <Field label="Ambient light">
              <input
                aria-label="Ambient light"
                type="range"
                min="0"
                max="5"
                step="0.05"
                value={environment.ambient}
                disabled={!editable}
                onChange={(event) =>
                  edit((current) => ({
                    ...current,
                    environment: {
                      ...(current.environment ?? defaultEnvironment),
                      ambient: Number(event.target.value),
                    },
                  }))
                }
              />
            </Field>
            <Field label="Key light">
              <input
                aria-label="Key light"
                type="range"
                min="0"
                max="10"
                step="0.05"
                value={environment.key}
                disabled={!editable}
                onChange={(event) =>
                  edit((current) => ({
                    ...current,
                    environment: {
                      ...(current.environment ?? defaultEnvironment),
                      key: Number(event.target.value),
                    },
                  }))
                }
              />
            </Field>
            <label className="scene-check">
              <input
                type="checkbox"
                checked={environment.shadows}
                disabled={!editable}
                onChange={(event) =>
                  edit((current) => ({
                    ...current,
                    environment: {
                      ...(current.environment ?? defaultEnvironment),
                      shadows: event.target.checked,
                    },
                  }))
                }
              />
              Cast shadows
            </label>
          </div>
          <p className="scene-kernel-note">
            {cad
              ? 'OpenCascade evaluates B-rep solids and dimension-driven sketch extrusions in a cancellable worker. STEP preserves analytic geometry; STL/GLB use the displayed tessellation.'
              : 'Meshes retain their individual transforms and materials in GLB exports. Orbit with drag, pan with right-drag, zoom with the wheel.'}
          </p>
        </aside>
      </div>
      <footer className="scene-statusbar">
        <span>
          {itemCount} model {itemCount === 1 ? 'item' : 'items'}
          {cad && positions && !computing && !kernelError
            ? ` · ${(positions.length / 9).toLocaleString()} triangles${kernelStats ? ` · ${Number(kernelStats.volume.toFixed(3)).toLocaleString()} ${draft.unit}³` : ''}`
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
