import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Circle,
  Copy,
  Download,
  ImagePlus,
  Image as ImageIcon,
  Layers,
  LoaderCircle,
  Pause,
  Play,
  Redo2,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Square,
  Trash2,
  Type,
  Undo2,
  Upload,
  Video,
  X,
} from 'lucide-react';
import type { MediaProps } from '../App.tsx';
import type { Layer } from '../../shared/domain.ts';
import { validateContent } from '../../shared/domain.ts';
import {
  Badge,
  Button,
  Field,
  IconButton,
  Input,
  Select,
  Textarea,
} from '../components/ui.tsx';
import { api, download } from '../lib.ts';
import {
  clamp,
  drawFrame,
  layerFont,
  layerLines,
  newLayer,
  resized,
  svgSource,
  timeLabel,
  visibleAt,
  type VisualContent,
} from './visual/render.ts';
import {
  clearAssetCache,
  imageDimensions,
  loadAssets,
} from './visual/assets.ts';
import fixWebmDuration from 'fix-webm-duration';
import './visual/editor.css';

type Gesture = {
  layer: Layer;
  start: { x: number; y: number };
  type: 'move' | 'resize';
  pointer: number;
};

export default function VisualEditor({
  artifact,
  readOnly,
  onSave,
  onDirty,
  onError,
}: MediaProps) {
  const [draft, setDraft] = useState<VisualContent>(
    () => structuredClone(artifact.content) as VisualContent,
  );
  const [saved, setSaved] = useState(() => JSON.stringify(artifact.content));
  const [version, setVersion] = useState(artifact.version);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [assetsRevision, setAssetsRevision] = useState(0);
  const [progress, setProgress] = useState(0);
  const [layersOpen, setLayersOpen] = useState(true);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const [past, setPast] = useState<VisualContent[]>([]);
  const [future, setFuture] = useState<VisualContent[]>([]);
  const svg = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const draftRef = useRef(draft);
  const baseRef = useRef(version);
  const dirtyRef = useRef(false);
  const exportAbort = useRef<AbortController | null>(null);
  const playbackRef = useRef<number | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const fontInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const video = artifact.kind === 'video';
  const brand = artifact.kind === 'brand';
  const dirty = JSON.stringify(draft) !== saved;
  const conflict = artifact.version > version && dirty;
  const locked = readOnly || exporting || saving || importing;
  const selected = draft.layers.find((layer) => layer.id === selectedId);
  draftRef.current = draft;
  baseRef.current = version;
  dirtyRef.current = dirty;

  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    // Keep the local draft intact if a teammate saves while this editor has changes.
    if (artifact.version > baseRef.current && !dirtyRef.current) {
      setDraft(structuredClone(artifact.content) as VisualContent);
      setSaved(JSON.stringify(artifact.content));
      setVersion(artifact.version);
      setPast([]);
      setFuture([]);
    }
  }, [artifact.version, artifact.content]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      exportAbort.current?.abort();
      clearAssetCache();
      if (playbackRef.current !== null)
        cancelAnimationFrame(playbackRef.current);
    };
  }, []);
  const assetKey = draft.layers
    .map((layer) => (layer.src ?? '') + '|' + (layer.fontUrl ?? ''))
    .join(';');
  useEffect(() => {
    let active = true;
    void loadAssets(draft)
      .then(() => {
        if (active) setAssetsRevision((value) => value + 1);
      })
      .catch((error) => {
        if (active) onError((error as Error).message);
      });
    return () => {
      active = false;
    };
  }, [assetKey]);
  useEffect(() => {
    if (!playing) return;
    const start = performance.now(),
      initial = time >= draft.duration ? 0 : time;
    const animate = (now: number) => {
      const next = initial + (now - start) / 1000;
      if (next >= draft.duration) {
        setTime(draft.duration);
        setPlaying(false);
        return;
      }
      setTime(next);
      playbackRef.current = requestAnimationFrame(animate);
    };
    playbackRef.current = requestAnimationFrame(animate);
    return () => {
      if (playbackRef.current !== null)
        cancelAnimationFrame(playbackRef.current);
    };
  }, [playing, draft.duration]);

  const measure = useMemo(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    return (layer: Layer, text: string) => {
      if (!ctx) return text.length * layer.fontSize * 0.55;
      ctx.font = `${layer.fontSize}px ${layerFont(layer)}`;
      return ctx.measureText(text).width;
    };
  }, [assetsRevision]);

  const record = useCallback(() => {
    setPast((history) => [
      ...history.slice(-49),
      structuredClone(draftRef.current),
    ]);
    setFuture([]);
  }, []);

  const change = (update: (current: VisualContent) => VisualContent) => {
    if (locked) return;
    record();
    setDraft((current) => update(current));
  };
  const layerChange = (values: Partial<Layer>) =>
    change((current) => ({
      ...current,
      layers: current.layers.map((layer) =>
        layer.id === selectedId ? { ...layer, ...values } : layer,
      ),
    }));
  const add = (type: Layer['type']) => {
    if (locked) return;
    const layer = newLayer(type, draft);
    change((current) => ({ ...current, layers: [...current.layers, layer] }));
    setSelectedId(layer.id);
  };
  const remove = () => {
    if (!selected || locked) return;
    change((current) => ({
      ...current,
      layers: current.layers.filter((layer) => layer.id !== selectedId),
    }));
    setSelectedId(null);
  };
  const duplicate = () => {
    if (!selected || locked) return;
    const layer = {
      ...selected,
      id: crypto.randomUUID(),
      x: selected.x + 24,
      y: selected.y + 24,
    };
    change((current) => ({ ...current, layers: [...current.layers, layer] }));
    setSelectedId(layer.id);
  };
  const reorder = (direction: number) => {
    if (!selected || locked) return;
    change((current) => {
      const layers = [...current.layers],
        index = layers.findIndex((layer) => layer.id === selected.id),
        next = clamp(index + direction, 0, layers.length - 1);
      const [item] = layers.splice(index, 1);
      layers.splice(next, 0, item!);
      return { ...current, layers };
    });
  };
  const undo = () => {
    if (locked || !past.length) return;
    setFuture((history) => [...history, structuredClone(draft)]);
    setDraft(past[past.length - 1]!);
    setPast((history) => history.slice(0, -1));
  };
  const redo = () => {
    if (locked || !future.length) return;
    setPast((history) => [...history, structuredClone(draft)]);
    setDraft(future[future.length - 1]!);
    setFuture((history) => history.slice(0, -1));
  };

  function point(event: React.PointerEvent): { x: number; y: number } {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const transformed = new DOMPoint(
      event.clientX,
      event.clientY,
    ).matrixTransform(matrix.inverse());
    return { x: transformed.x, y: transformed.y };
  }

  function startGesture(
    event: React.PointerEvent,
    layer: Layer,
    type: Gesture['type'],
  ) {
    event.stopPropagation();
    setSelectedId(layer.id);
    if (locked) return;
    event.preventDefault();
    record();
    gesture.current = {
      layer: { ...layer },
      start: point(event),
      type,
      pointer: event.pointerId,
    };
    svg.current?.setPointerCapture(event.pointerId);
  }

  function moveGesture(event: React.PointerEvent) {
    const current = gesture.current;
    if (!current || locked || current.pointer !== event.pointerId) return;
    const position = point(event),
      dx = position.x - current.start.x,
      dy = position.y - current.start.y;
    const delta =
      current.type === 'move'
        ? {
            x: clamp(Math.round(current.layer.x + dx), -100000, 100000),
            y: clamp(Math.round(current.layer.y + dy), -100000, 100000),
          }
        : resized(current.layer, dx, dy);
    setDraft((content) => ({
      ...content,
      layers: content.layers.map((layer) =>
        layer.id === current.layer.id ? { ...layer, ...delta } : layer,
      ),
    }));
  }

  function endGesture(event: React.PointerEvent) {
    if (gesture.current?.pointer !== event.pointerId) return;
    gesture.current = null;
    if (svg.current?.hasPointerCapture(event.pointerId))
      svg.current.releasePointerCapture(event.pointerId);
  }

  async function save() {
    if (locked || !dirty) return;
    setSaving(true);
    try {
      const content = validateContent(artifact.kind, draft);
      await onSave(content, version);
      setSaved(JSON.stringify(content));
      setVersion(version + 1);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function exportSvg() {
    try {
      await document.fonts.ready;
      const assets = await loadAssets(draft);
      download(
        `${artifact.title}.svg`,
        svgSource(draft, video ? time : undefined, measure, assets),
        'image/svg+xml',
      );
    } catch (error) {
      onError((error as Error).message);
    }
  }
  async function exportPng() {
    try {
      await document.fonts.ready;
      const assets = await loadAssets(draft);
      const canvas = document.createElement('canvas');
      canvas.width = draft.width;
      canvas.height = draft.height;
      const ctx = canvas.getContext('2d');
      if (!ctx)
        throw new Error(
          'Canvas export is unavailable in this browser. Download SVG instead.',
        );
      drawFrame(ctx, draft, video ? time : undefined, assets);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value
              ? resolve(value)
              : reject(
                  new Error('PNG encoding failed. Try a smaller artboard.'),
                ),
          'image/png',
        ),
      );
      download(`${artifact.title}.png`, blob, 'image/png');
    } catch (error) {
      onError((error as Error).message);
    }
  }

  async function exportVideo() {
    if (exporting) return;
    if (
      typeof MediaRecorder === 'undefined' ||
      typeof HTMLCanvasElement.prototype.captureStream !== 'function'
    ) {
      onError(
        'WebM recording is unavailable in this browser. Open the editor in a current Chromium or Firefox browser. You can still export the current frame as PNG or SVG.',
      );
      return;
    }
    const mime = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ].find((value) => MediaRecorder.isTypeSupported(value));
    if (!mime) {
      onError(
        'This browser cannot encode WebM. Use a current Chromium or Firefox browser.',
      );
      return;
    }
    if (document.visibilityState === 'hidden') {
      onError('Keep this editor visible while recording a WebM export.');
      return;
    }
    setPlaying(false);
    setExporting(true);
    setProgress(0);
    const controller = new AbortController();
    exportAbort.current = controller;
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        controller.abort();
        onError(
          'Video export was cancelled because the editor became hidden. Keep this tab visible to record every frame.',
        );
      }
    };
    document.addEventListener('visibilitychange', visibility);
    let stream: MediaStream | undefined;
    let recorder: MediaRecorder | undefined;
    let frame = 0;
    try {
      await document.fonts.ready;
      const assets = await loadAssets(draft, controller.signal);
      if (controller.signal.aborted)
        throw new DOMException('Export cancelled', 'AbortError');
      const canvas = document.createElement('canvas');
      canvas.width = draft.width;
      canvas.height = draft.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas recording could not start.');
      drawFrame(ctx, draft, 0, assets);
      stream = canvas.captureStream(30);
      recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: 6_000_000,
      });
      const chunks: BlobPart[] = [];
      let totalBytes = 0;
      const recording = new Promise<Blob>((resolve, reject) => {
        recorder!.ondataavailable = (event) => {
          if (event.data.size) {
            totalBytes += event.data.size;
            chunks.push(event.data);
          }
          if (totalBytes > 512 * 1024 * 1024) {
            controller.abort();
            reject(
              new Error(
                'The export exceeded 512 MB. Shorten the timeline or reduce the artboard size.',
              ),
            );
          }
        };
        recorder!.onerror = () =>
          reject(
            new Error(
              'The browser stopped video encoding. Try a smaller artboard or shorter duration.',
            ),
          );
        recorder!.onstop = () => resolve(new Blob(chunks, { type: mime }));
      });
      recorder.start(1000);
      const started = performance.now();
      const rendering = new Promise<void>((resolve, reject) => {
        const aborted = () =>
          reject(new DOMException('Export cancelled', 'AbortError'));
        controller.signal.addEventListener('abort', aborted, { once: true });
        const tick = (now: number) => {
          if (controller.signal.aborted) return;
          const current = Math.min((now - started) / 1000, draft.duration);
          drawFrame(
            ctx,
            draft,
            Math.min(current, draft.duration - 0.0001),
            assets,
          );
          setProgress(current / draft.duration);
          if (current >= draft.duration) {
            controller.signal.removeEventListener('abort', aborted);
            resolve();
          } else frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      });
      await Promise.race([
        rendering,
        recording.then(() => {
          throw new Error(
            'The browser stopped recording before the timeline finished. Try a shorter export.',
          );
        }),
      ]);
      recorder.stop();
      const blob = await recording;
      const finalized = await fixWebmDuration(blob, draft.duration * 1000, {
        logger: false,
      });
      if (!controller.signal.aborted)
        download(`${artifact.title}.webm`, finalized, mime);
    } catch (error) {
      if ((error as Error).name !== 'AbortError')
        onError((error as Error).message);
    } finally {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', visibility);
      if (recorder?.state !== 'inactive') recorder?.stop();
      stream?.getTracks().forEach((track) => track.stop());
      exportAbort.current = null;
      setExporting(false);
      setProgress(0);
    }
  }

  function addMonogram() {
    if (locked) return;
    const size = Math.min(draft.width, draft.height) * 0.45,
      x = Math.round((draft.width - size) / 2),
      y = Math.round((draft.height - size) / 2);
    const mark = {
      ...newLayer('ellipse', draft),
      x,
      y,
      width: size,
      height: size,
      fill: '#24292e',
    };
    const letter = {
      ...newLayer('text', draft),
      x: x + size * 0.16,
      y: y + size * 0.1,
      width: size * 0.8,
      height: size * 0.8,
      text: artifact.title.slice(0, 1).toUpperCase(),
      fontSize: size * 0.75,
      fill: '#f4f1e9',
      fontFamily: 'Georgia',
    };
    change((content) => ({
      ...content,
      layers: [...content.layers, mark, letter],
    }));
    setSelectedId(letter.id);
  }

  async function importFile(
    event: React.ChangeEvent<HTMLInputElement>,
    kind: 'image' | 'font',
  ) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || locked) return;
    if (kind === 'image' && draftRef.current.layers.length >= 200) {
      onError(
        'This composition already has 200 layers. Delete a layer before importing another image.',
      );
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      onError('Uploads must be 10 MB or smaller.');
      return;
    }
    const target = selectedId;
    if (kind === 'font' && (!selected || selected.type !== 'text')) {
      onError('Select a text layer before importing a WOFF2 font.');
      return;
    }
    setImporting(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const result = await api<{ url: string; mime: string }>(
        `/artifacts/${artifact.id}/files`,
        'POST',
        form,
      );
      if (kind === 'font') {
        if (result.mime !== 'font/woff2')
          throw new Error('Choose a valid WOFF2 font file.');
        const updated = {
          ...draftRef.current,
          layers: draftRef.current.layers.map((layer) =>
            layer.id === target
              ? { ...layer, fontFamily: 'Custom', fontUrl: result.url }
              : layer,
          ),
        };
        await loadAssets(updated);
        if (mounted.current) {
          record();
          setDraft(updated);
        }
      } else {
        if (!result.mime.startsWith('image/'))
          throw new Error('Choose a PNG, JPEG, or WebP image.');
        const size = await imageDimensions(result.url);
        const scale = Math.min(
          1,
          (draftRef.current.width * 0.8) / size.width,
          (draftRef.current.height * 0.8) / size.height,
        );
        const layer = {
          ...newLayer('image', draftRef.current),
          src: result.url,
          text: file.name,
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
        };
        layer.x = (draftRef.current.width - layer.width) / 2;
        layer.y = (draftRef.current.height - layer.height) / 2;
        if (mounted.current) {
          record();
          setDraft((current) => ({
            ...current,
            layers: [...current.layers, layer],
          }));
          setSelectedId(layer.id);
        }
      }
    } catch (error) {
      if (mounted.current) onError((error as Error).message);
    } finally {
      if (mounted.current) setImporting(false);
    }
  }

  return (
    <div
      className={
        'visual-editor ' +
        (video ? 'visual-video ' : '') +
        (brand ? 'visual-brand' : '')
      }
    >
      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        aria-label="Upload image file"
        hidden
        onChange={(event) => importFile(event, 'image')}
      />
      <input
        ref={fontInput}
        type="file"
        accept=".woff2,font/woff2"
        aria-label="Upload WOFF2 font"
        hidden
        onChange={(event) => importFile(event, 'font')}
      />
      <div
        className="visual-toolbar"
        role="toolbar"
        aria-label="Visual design tools"
      >
        <div className="visual-tool-group">
          <IconButton
            label="Add text"
            onClick={() => add('text')}
            disabled={locked || draft.layers.length >= 200}
          >
            <Type />
          </IconButton>
          <IconButton
            label="Add rectangle"
            onClick={() => add('rect')}
            disabled={locked || draft.layers.length >= 200}
          >
            <Square />
          </IconButton>
          <IconButton
            label="Add ellipse"
            onClick={() => add('ellipse')}
            disabled={locked || draft.layers.length >= 200}
          >
            <Circle />
          </IconButton>
          <IconButton
            label="Import image"
            onClick={() => imageInput.current?.click()}
            disabled={locked || draft.layers.length >= 200}
          >
            {importing ? <LoaderCircle className="spin" /> : <ImagePlus />}
          </IconButton>
          {brand && (
            <Button
              size="sm"
              variant="ghost"
              onClick={addMonogram}
              disabled={locked || draft.layers.length > 198}
            >
              Add monogram
            </Button>
          )}
          <span className="toolbar-divider" />
          <IconButton
            label="Undo visual edit"
            onClick={undo}
            disabled={locked || !past.length}
          >
            <Undo2 />
          </IconButton>
          <IconButton
            label="Redo visual edit"
            onClick={redo}
            disabled={locked || !future.length}
          >
            <Redo2 />
          </IconButton>
        </div>
        <div className="visual-tool-group">
          <IconButton
            label="Toggle layers"
            aria-pressed={layersOpen}
            onClick={() => setLayersOpen((value) => !value)}
          >
            <Layers />
          </IconButton>
          <IconButton
            label="Toggle properties"
            aria-pressed={propertiesOpen}
            onClick={() => setPropertiesOpen((value) => !value)}
          >
            <SlidersHorizontal />
          </IconButton>
          <Button size="sm" variant="outline" onClick={exportSvg}>
            <Download size={14} />
            SVG
          </Button>
          <Button size="sm" variant="outline" onClick={exportPng}>
            <Download size={14} />
            PNG
          </Button>
          {video && (
            <Button
              size="sm"
              variant="outline"
              onClick={exportVideo}
              disabled={exporting}
            >
              <Video size={14} />
              WebM
            </Button>
          )}
          <Button
            size="sm"
            onClick={save}
            disabled={locked || !dirty || conflict}
          >
            {saving ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Save size={14} />
            )}
            Save
          </Button>
        </div>
      </div>
      {conflict && (
        <div className="visual-conflict" role="alert">
          <span>
            A teammate saved a newer version. Your draft is preserved. Download
            it before loading the latest version.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              download(
                `${artifact.title}-draft.json`,
                JSON.stringify(draft, null, 2),
              )
            }
          >
            Download draft
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDraft(structuredClone(artifact.content) as VisualContent);
              setSaved(JSON.stringify(artifact.content));
              setVersion(artifact.version);
              setPast([]);
              setFuture([]);
            }}
          >
            Load latest
          </Button>
        </div>
      )}
      {exporting && (
        <div className="visual-export-progress" role="status">
          <LoaderCircle className="spin" size={15} />
          <span>
            Recording WebM · {Math.round(progress * 100)}% · exports in real
            time
          </span>
          <progress max={1} value={progress} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => exportAbort.current?.abort()}
          >
            Cancel export
          </Button>
        </div>
      )}
      <div
        className={
          'visual-workspace ' +
          (layersOpen ? 'with-layers ' : '') +
          (propertiesOpen ? 'with-properties' : '')
        }
      >
        {layersOpen && (
          <aside className="visual-layer-panel" aria-label="Composition layers">
            <div className="visual-panel-heading">
              <h3>Layers</h3>
              <Badge>{draft.layers.length}</Badge>
            </div>
            {draft.layers.length === 0 && (
              <p className="visual-hint">Add text or a shape to begin.</p>
            )}
            <div className="visual-layer-list">
              {[...draft.layers].reverse().map((layer, index) => {
                const Icon =
                  layer.type === 'text'
                    ? Type
                    : layer.type === 'image'
                      ? ImageIcon
                      : layer.type === 'ellipse'
                        ? Circle
                        : Square;
                return (
                  <button
                    key={layer.id}
                    className={
                      'visual-layer-row ' +
                      (selectedId === layer.id ? 'selected' : '')
                    }
                    aria-pressed={selectedId === layer.id}
                    onClick={() => setSelectedId(layer.id)}
                  >
                    <Icon size={14} />
                    <span>
                      {layer.type === 'text'
                        ? layer.text.slice(0, 28) || 'Empty text'
                        : layer.type === 'image'
                          ? layer.text.slice(0, 28) || 'Image'
                          : `${layer.type === 'rect' ? 'Rectangle' : 'Ellipse'} ${draft.layers.length - index}`}
                    </span>
                    {video && !visibleAt(layer, time) && (
                      <span
                        className="visual-layer-inactive"
                        title="Outside current playhead"
                      >
                        ·
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="visual-layer-actions">
              <IconButton
                label="Bring layer forward"
                disabled={
                  locked ||
                  !selected ||
                  draft.layers.indexOf(selected) === draft.layers.length - 1
                }
                onClick={() => reorder(1)}
              >
                <ArrowUp />
              </IconButton>
              <IconButton
                label="Send layer backward"
                disabled={
                  locked || !selected || draft.layers.indexOf(selected) === 0
                }
                onClick={() => reorder(-1)}
              >
                <ArrowDown />
              </IconButton>
              <IconButton
                label="Duplicate layer"
                disabled={locked || !selected || draft.layers.length >= 200}
                onClick={duplicate}
              >
                <Copy />
              </IconButton>
              <IconButton
                label="Delete layer"
                disabled={locked || !selected}
                onClick={remove}
              >
                <Trash2 />
              </IconButton>
            </div>
          </aside>
        )}
        <section
          className="visual-stage"
          aria-label={video ? 'Video composition' : 'Design canvas'}
        >
          <div className="visual-artboard-wrap">
            <svg
              ref={svg}
              className="visual-artboard"
              viewBox={`0 0 ${draft.width} ${draft.height}`}
              width={draft.width}
              height={draft.height}
              role="img"
              aria-label="Editable artifact composition"
              tabIndex={0}
              onPointerDown={(event) => {
                if (
                  event.target === event.currentTarget ||
                  (event.target as Element).getAttribute('data-background') ===
                    'true'
                )
                  setSelectedId(null);
              }}
              onPointerMove={moveGesture}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
              onKeyDown={(event) => {
                if (locked || !selected) return;
                if (event.key === 'Delete' || event.key === 'Backspace') {
                  event.preventDefault();
                  remove();
                }
                if (
                  ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
                    event.key,
                  )
                ) {
                  event.preventDefault();
                  const delta = event.shiftKey ? 10 : 1;
                  layerChange({
                    x:
                      selected.x +
                      (event.key === 'ArrowLeft'
                        ? -delta
                        : event.key === 'ArrowRight'
                          ? delta
                          : 0),
                    y:
                      selected.y +
                      (event.key === 'ArrowUp'
                        ? -delta
                        : event.key === 'ArrowDown'
                          ? delta
                          : 0),
                  });
                }
              }}
            >
              <title>{artifact.title}</title>
              <rect
                data-background="true"
                width={draft.width}
                height={draft.height}
                fill={draft.background}
              />
              {draft.layers
                .filter((layer) => !video || visibleAt(layer, time))
                .map((layer) => (
                  <g
                    key={layer.id}
                    transform={`translate(${layer.x} ${layer.y}) rotate(${layer.rotation} ${layer.width / 2} ${layer.height / 2})`}
                    className={readOnly ? '' : 'visual-object'}
                    onPointerDown={(event) =>
                      startGesture(event, layer, 'move')
                    }
                  >
                    {layer.type === 'image' ? (
                      <image
                        href={layer.src}
                        width={layer.width}
                        height={layer.height}
                        preserveAspectRatio="none"
                      />
                    ) : layer.type === 'rect' ? (
                      <rect
                        width={layer.width}
                        height={layer.height}
                        fill={layer.fill}
                      />
                    ) : layer.type === 'ellipse' ? (
                      <ellipse
                        cx={layer.width / 2}
                        cy={layer.height / 2}
                        rx={layer.width / 2}
                        ry={layer.height / 2}
                        fill={layer.fill}
                      />
                    ) : (
                      <>
                        <defs>
                          <clipPath id={'editor-clip-' + layer.id}>
                            <rect width={layer.width} height={layer.height} />
                          </clipPath>
                        </defs>
                        <rect
                          width={layer.width}
                          height={layer.height}
                          fill="transparent"
                        />
                        <text
                          fontFamily={layerFont(layer)}
                          fontSize={layer.fontSize}
                          fill={layer.fill}
                          clipPath={`url(#editor-clip-${layer.id})`}
                          style={{ userSelect: 'none' }}
                        >
                          {layerLines(layer, (text) =>
                            measure(layer, text),
                          ).map((line, index) => (
                            <tspan
                              key={index}
                              x={0}
                              y={layer.fontSize * (0.85 + index * 1.2)}
                            >
                              {line}
                            </tspan>
                          ))}
                        </text>
                      </>
                    )}
                    {selectedId === layer.id && (
                      <g className="visual-selection" pointerEvents="none">
                        <rect
                          width={layer.width}
                          height={layer.height}
                          fill="none"
                          stroke="#5967c9"
                          strokeWidth={1.5}
                          vectorEffect="non-scaling-stroke"
                        />
                        {!locked && (
                          <rect
                            pointerEvents="all"
                            x={layer.width - 6}
                            y={layer.height - 6}
                            width={12}
                            height={12}
                            fill="white"
                            stroke="#5967c9"
                            strokeWidth={1.5}
                            vectorEffect="non-scaling-stroke"
                            className="visual-resize-handle"
                            onPointerDown={(event) =>
                              startGesture(event, layer, 'resize')
                            }
                          />
                        )}
                      </g>
                    )}
                  </g>
                ))}
            </svg>
          </div>
          <div className="visual-stage-caption">
            <span>
              {draft.width} × {draft.height} px
            </span>
            <span>
              {readOnly
                ? 'View only'
                : selected
                  ? 'Drag to move · corner to resize · arrows to nudge'
                  : 'Select a layer to edit'}
            </span>
          </div>
        </section>
        {propertiesOpen && (
          <aside className="visual-inspector" aria-label="Design properties">
            <div className="visual-panel-heading">
              <h3>{selected ? 'Layer properties' : 'Artboard'}</h3>
              {selected && (
                <IconButton
                  label="Deselect layer"
                  onClick={() => setSelectedId(null)}
                >
                  <X size={14} />
                </IconButton>
              )}
            </div>
            {selected ? (
              <fieldset disabled={locked} className="visual-properties">
                <div className="visual-property-grid">
                  <Numeric
                    label="X"
                    value={selected.x}
                    min={-100000}
                    max={100000}
                    onChange={(x) => layerChange({ x })}
                  />
                  <Numeric
                    label="Y"
                    value={selected.y}
                    min={-100000}
                    max={100000}
                    onChange={(y) => layerChange({ y })}
                  />
                  <Numeric
                    label="Width"
                    value={selected.width}
                    min={1}
                    max={100000}
                    onChange={(width) => layerChange({ width })}
                  />
                  <Numeric
                    label="Height"
                    value={selected.height}
                    min={1}
                    max={100000}
                    onChange={(height) => layerChange({ height })}
                  />
                </div>
                <Numeric
                  label="Rotation · degrees"
                  value={selected.rotation}
                  min={-360}
                  max={360}
                  onChange={(rotation) => layerChange({ rotation })}
                />
                {selected.type !== 'image' && (
                  <Field label="Fill">
                    <input
                      type="color"
                      aria-label="Layer fill"
                      value={selected.fill}
                      onChange={(event) =>
                        layerChange({ fill: event.target.value })
                      }
                    />
                  </Field>
                )}
                {selected.type === 'text' && (
                  <>
                    <Field label="Text">
                      <Textarea
                        aria-label="Layer text"
                        value={selected.text}
                        maxLength={10000}
                        onChange={(event) =>
                          layerChange({ text: event.target.value })
                        }
                      />
                    </Field>
                    <Field label="Typeface">
                      <Select
                        value={selected.fontFamily}
                        onChange={(event) =>
                          layerChange({ fontFamily: event.target.value })
                        }
                      >
                        <option value="Inter">Inter</option>
                        <option value="Georgia">Georgia</option>
                        <option value="monospace">Monospace</option>
                        {selected.fontUrl && (
                          <option value="Custom">Uploaded WOFF2</option>
                        )}
                      </Select>
                    </Field>
                    <Numeric
                      label="Font size"
                      value={selected.fontSize}
                      min={1}
                      max={500}
                      onChange={(fontSize) => layerChange({ fontSize })}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={locked}
                      onClick={() => fontInput.current?.click()}
                    >
                      <Upload size={13} />
                      Upload WOFF2
                    </Button>
                  </>
                )}
                {video && (
                  <>
                    <h4>Clip timing</h4>
                    <Numeric
                      label="Start · seconds"
                      value={selected.start}
                      min={0}
                      max={draft.duration - 0.1}
                      step={0.1}
                      onChange={(start) =>
                        layerChange({
                          start,
                          duration: Math.min(
                            selected.duration,
                            draft.duration - start,
                          ),
                        })
                      }
                    />
                    <Numeric
                      label="Duration · seconds"
                      value={selected.duration}
                      min={0.1}
                      max={Math.max(0.1, draft.duration - selected.start)}
                      step={0.1}
                      onChange={(duration) => layerChange({ duration })}
                    />
                  </>
                )}
              </fieldset>
            ) : (
              <fieldset disabled={locked} className="visual-properties">
                <div className="visual-property-grid">
                  <Numeric
                    label="Width"
                    value={draft.width}
                    min={64}
                    max={4096}
                    onChange={(width) =>
                      change((content) => ({ ...content, width }))
                    }
                  />
                  <Numeric
                    label="Height"
                    value={draft.height}
                    min={64}
                    max={4096}
                    onChange={(height) =>
                      change((content) => ({ ...content, height }))
                    }
                  />
                </div>
                <Field label="Background">
                  <input
                    type="color"
                    aria-label="Artboard background"
                    value={draft.background}
                    onChange={(event) =>
                      change((content) => ({
                        ...content,
                        background: event.target.value,
                      }))
                    }
                  />
                </Field>
                {video && (
                  <Numeric
                    label="Duration · seconds"
                    value={draft.duration}
                    min={1}
                    max={600}
                    step={1}
                    onChange={(duration) => {
                      setPlaying(false);
                      setTime((current) => Math.min(current, duration));
                      change((content) => ({
                        ...content,
                        duration,
                        layers: content.layers.map((layer) => ({
                          ...layer,
                          start: Math.min(layer.start, duration - 0.1),
                          duration: Math.min(
                            layer.duration,
                            duration - Math.min(layer.start, duration - 0.1),
                          ),
                        })),
                      }));
                    }}
                  />
                )}
                <p className="visual-hint">
                  {brand
                    ? 'Compose editable marks and typography, then export SVG for vector workflows or PNG for exact rasterized lettering.'
                    : 'Add text or geometric layers. Every layer remains editable in this artifact.'}
                </p>
              </fieldset>
            )}
          </aside>
        )}
      </div>
      {video && (
        <section className="visual-timeline" aria-label="Video timeline">
          <div className="visual-timeline-controls">
            <IconButton
              label={playing ? 'Pause timeline' : 'Play timeline'}
              onClick={() => setPlaying((value) => !value)}
              disabled={exporting}
            >
              {playing ? <Pause /> : <Play />}
            </IconButton>
            <IconButton
              label="Return to start"
              onClick={() => {
                setPlaying(false);
                setTime(0);
              }}
              disabled={exporting}
            >
              <RotateCcw />
            </IconButton>
            <output aria-label="Playhead position">
              {timeLabel(time)} <span>/ {timeLabel(draft.duration)}</span>
            </output>
            <input
              aria-label="Seek video timeline"
              type="range"
              min={0}
              max={draft.duration}
              step={0.01}
              value={time}
              onChange={(event) => {
                setPlaying(false);
                setTime(Number(event.target.value));
              }}
              disabled={exporting}
            />
            <Badge>30 fps export</Badge>
          </div>
          <div className="visual-timeline-tracks">
            {[...draft.layers].reverse().map((layer) => (
              <div className="visual-timeline-track" key={layer.id}>
                <button
                  className={selectedId === layer.id ? 'selected' : ''}
                  onClick={() => setSelectedId(layer.id)}
                >
                  {layer.type === 'text'
                    ? layer.text.slice(0, 20) || 'Text'
                    : layer.type === 'rect'
                      ? 'Rectangle'
                      : layer.type === 'image'
                        ? 'Image'
                        : 'Ellipse'}
                </button>
                <div
                  className="visual-timeline-lane"
                  onPointerDown={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setPlaying(false);
                    setTime(
                      clamp(
                        ((event.clientX - rect.left) / rect.width) *
                          draft.duration,
                        0,
                        draft.duration,
                      ),
                    );
                  }}
                >
                  <button
                    aria-label={`Select ${layer.type} clip`}
                    className={
                      'visual-timeline-clip ' +
                      (selectedId === layer.id ? 'selected' : '')
                    }
                    style={{
                      left: `${(layer.start / draft.duration) * 100}%`,
                      width: `${(Math.max(0, Math.min(layer.duration, draft.duration - layer.start)) / draft.duration) * 100}%`,
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedId(layer.id);
                    }}
                  >
                    <span>
                      {layer.type === 'text'
                        ? layer.text.slice(0, 40)
                        : layer.type}
                    </span>
                  </button>
                  <span
                    className="visual-playhead"
                    style={{ left: `${(time / draft.duration) * 100}%` }}
                  />
                </div>
              </div>
            ))}
            {draft.layers.length === 0 && (
              <p className="visual-hint">
                Add a layer to create the first clip.
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function Numeric({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  const [input, setInput] = useState(String(Number(value.toFixed(2))));
  useEffect(() => setInput(String(Number(value.toFixed(2)))), [value]);
  return (
    <Field label={label}>
      <Input
        type="number"
        aria-label={label}
        value={input}
        min={min}
        max={max}
        step={step}
        onChange={(event) => setInput(event.target.value)}
        onBlur={() => {
          const parsed = Number(input);
          if (input.trim() && Number.isFinite(parsed))
            onChange(clamp(parsed, min, max));
          else setInput(String(value));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </Field>
  );
}
