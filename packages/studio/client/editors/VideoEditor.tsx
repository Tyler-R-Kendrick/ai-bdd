import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { Type, Square, Circle, Upload, Download, Save, Undo2, Redo2, Play, Pause, SkipBack, Scissors, Trash2, Copy, LockKeyhole, LockKeyholeOpen, Volume2, VolumeX, KeyRound, X, Film, Music2, Image as ImageIcon } from 'lucide-react';
import type { MediaProps } from '../App.tsx';
import { Badge, Button, Field, IconButton, Input, Select, Textarea } from '../components/ui.tsx';
import { api, download } from '../lib.ts';
import { normalizeVideo, videoContentSchema, videoProperties, type TimelineContent, type VideoClip, type VideoProperty, type VideoKeyframe } from '../../shared/video.ts';
import { activeClip, clamp, clipAt, clipValue, frameTime, newClip, nextTrack, splitClip, timecode, trimClip } from '../../shared/video-timeline.ts';
import { MediaClip } from './video/MediaClip.tsx';
import { importVideoProject, videoProject } from './video/project.ts';
import './video/editor.css';
type RenderJob = { id: string; artifactVersion: number; format: 'mp4' | 'webm'; status: string; progress: number; downloadUrl: string | null; error: string | null };
function NumberField({ label, value, onCommit, min, max, step = 1, disabled }: { label: string; value: number; onCommit: (value: number) => void; min?: number; max?: number; step?: number; disabled?: boolean }) {
  const [text, setText] = useState(String(Math.round(value * 1000) / 1000));
  useEffect(() => setText(String(Math.round(value * 1000) / 1000)), [value]);
  return <Field label={label}><Input aria-label={label} type="number" min={min} max={max} step={step} value={text} disabled={disabled} onChange={(event) => setText(event.target.value)} onBlur={() => {
    const number = Number(text); if (text.trim() && Number.isFinite(number) && (min === undefined || number >= min) && (max === undefined || number <= max)) onCommit(number);
    else setText(String(value));
  }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></Field>;
}
function mediaMetadata(file: File): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), element = document.createElement(file.type.startsWith('audio/') ? 'audio' : 'video');
    const timeout = setTimeout(() => finish(new Error('Media metadata timed out. Try a smaller supported file.')), 15000);
    const finish = (error?: Error) => { clearTimeout(timeout); element.removeAttribute('src'); element.load(); URL.revokeObjectURL(url); if (error) reject(error); };
    element.preload = 'metadata';
    element.onloadedmetadata = () => {
      const duration = element.duration, width = 'videoWidth' in element ? element.videoWidth : 0, height = 'videoHeight' in element ? element.videoHeight : 0;
      if (!Number.isFinite(duration) || duration <= 0 || duration > 36000 || width * height > 64_000_000) return finish(new Error('Media duration or decoded dimensions exceed the supported limits.'));
      resolve({ duration, width, height }); finish();
    };
    element.onerror = () => finish(new Error('The browser cannot decode this media. Use MP4, WebM, WAV, MP3, or Ogg.'));
    element.src = url;
  });
}
export default function VideoEditor({ artifact, readOnly, onSave, onDirty, onError }: MediaProps) {
  const [draft, setDraft] = useState<TimelineContent>(() => normalizeVideo(artifact.content));
  const [saved, setSaved] = useState(() => JSON.stringify(normalizeVideo(artifact.content))), [version, setVersion] = useState(artifact.version);
  const [selected, setSelected] = useState<string | null>(null), [time, setTime] = useState(0), [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false), [busy, setBusy] = useState(false), [conflict, setConflict] = useState(false);
  const [past, setPast] = useState<TimelineContent[]>([]), [future, setFuture] = useState<TimelineContent[]>([]);
  const [zoom, setZoom] = useState(70), [keyProperty, setKeyProperty] = useState<VideoProperty>('opacity'), [easing, setEasing] = useState<VideoKeyframe['easing']>('ease-out');
  const [jobs, setJobs] = useState<RenderJob[]>([]), [stageWidth, setStageWidth] = useState(640), [stageHeight, setStageHeight] = useState(400);
  const stage = useRef<HTMLDivElement>(null), fileInput = useRef<HTMLInputElement>(null), projectInput = useRef<HTMLInputElement>(null), captionsInput = useRef<HTMLInputElement>(null);
  const current = useRef(draft), savedRef = useRef(saved), mounted = useRef(true), poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  current.current = draft; savedRef.current = saved;
  const dirty = JSON.stringify(draft) !== saved, locked = readOnly || saving || busy || conflict;
  const clip = draft.clips.find((item) => item.id === selected), scale = Math.max(0.02, Math.min(1, (stageWidth - 36) / draft.width, (stageHeight - 50) / draft.height));
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (poll.current) clearTimeout(poll.current); onDirty(false); }; }, [onDirty]);
  useEffect(() => {
    if (artifact.version <= version) return;
    const incoming = normalizeVideo(artifact.content), serialized = JSON.stringify(incoming);
    if (JSON.stringify(current.current) !== savedRef.current && serialized !== JSON.stringify(current.current)) { setConflict(true); return; }
    setDraft(incoming); setSaved(serialized); setVersion(artifact.version); setConflict(false);
  }, [artifact, version]);
  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(([entry]) => { setStageWidth(entry!.contentRect.width); setStageHeight(entry!.contentRect.height); }); observer.observe(stage.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!playing) return;
    let handle = 0, last: number | undefined;
    const tick = (now: number) => { const elapsed = last === undefined ? 0 : Math.min(0.2, (now - last) / 1000); last = now;
      setTime((old) => { const next = old + elapsed; if (next >= current.current.duration) { setPlaying(false); return current.current.duration; } return next; }); handle = requestAnimationFrame(tick); };
    handle = requestAnimationFrame(tick); return () => cancelAnimationFrame(handle);
  }, [playing]);
  const report = (error: unknown) => onError(error instanceof Error ? error.message : String(error));
  function change(next: TimelineContent, remember = true) {
    if (locked) return;
    try { videoContentSchema.parse(next); if (remember) { setPast((items) => [...items.slice(-49), structuredClone(current.current)]); setFuture([]); } setDraft(next); }
    catch (error) { report(error); }
  }
  function patch(values: Partial<VideoClip>) { if (clip && !clip.locked) change({ ...draft, clips: draft.clips.map((item) => item.id === clip.id ? { ...item, ...values } : item) }); }
  function undo() { const previous = past.at(-1); if (!previous || locked) return; setFuture((items) => [structuredClone(draft), ...items]); setPast(past.slice(0, -1)); setDraft(previous); }
  function redo() { const next = future[0]; if (!next || locked) return; setPast((items) => [...items, structuredClone(draft)]); setFuture(future.slice(1)); setDraft(next); }
  function add(type: 'text' | 'rect' | 'ellipse') { try { const item = newClip(type, draft.duration, nextTrack(draft)); if (type !== 'text') Object.assign(item, { fill: '#6b73d1', width: 240, height: 160 }); change({ ...draft, clips: [...draft.clips, item] }); setSelected(item.id); } catch (error) { report(error); } }
  function remove() { if (clip && !clip.locked) { change({ ...draft, clips: draft.clips.filter((item) => item.id !== clip.id) }); setSelected(null); } }
  function duplicate() { if (!clip || clip.locked) return; try { const copy = { ...structuredClone(clip), id: crypto.randomUUID(), name: `${clip.name.slice(0, 170)} copy`, track: nextTrack(draft, clip.start, clip.duration) }; change({ ...draft, clips: [...draft.clips, copy] }); setSelected(copy.id); } catch (error) { report(error); } }
  async function save() {
    if (locked || !dirty) return false;
    setSaving(true);
    try { videoContentSchema.parse(draft); await onSave(draft, version); setSaved(JSON.stringify(draft)); setVersion(version + 1); return true; }
    catch (error) { report(error); return false; } finally { if (mounted.current) setSaving(false); }
  }
  async function imported(file?: File) {
    if (!file || locked) return;
    setBusy(true);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Media uploads are limited to 10 MB per file.');
      const type = file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('image/') ? 'image' : null;
      if (!type) throw new Error('Choose an image, video, or audio file.');
      const metadata = type === 'image' ? undefined : await mediaMetadata(file);
      const body = new FormData(); body.append('file', file);
      const result = await api(`/artifacts/${artifact.id}/files`, 'POST', body);
      if (!result.mime.startsWith(type + '/')) throw new Error('The uploaded file does not match its declared media type.');
      const duration = Math.min(draft.duration, metadata?.duration ?? draft.duration);
      const item = newClip(type, duration, nextTrack(draft, 0, duration));
      Object.assign(item, { src: result.url, name: file.name.slice(0, 180), ...(metadata ? { sourceDuration: metadata.duration } : {}), x: type === 'audio' ? 0 : 50, y: type === 'audio' ? 0 : 50, width: draft.width - 100, height: draft.height - 100 });
      setPast((items) => [...items.slice(-49), structuredClone(draft)]); setFuture([]); setDraft({ ...draft, clips: [...draft.clips, item] }); setSelected(item.id);
    } catch (error) { report(error); } finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  async function portable() { setBusy(true); try { const bytes = await videoProject(draft, artifact.title); download(`${artifact.title}.hyperframes.zip`, bytes as Uint8Array<ArrayBuffer>, 'application/zip'); } catch (error) { report(error); } finally { setBusy(false); } }
  async function projectImport(file?: File) { if (!file || locked) return; setBusy(true); try { if (file.name.endsWith('.json') && file.size > 2_000_000) throw new Error('The composition JSON exceeds the 2 MB limit.'); const content = file.name.endsWith('.json') ? normalizeVideo(JSON.parse(await file.text())) : await importVideoProject(file, artifact.id); setPast((items) => [...items.slice(-49), structuredClone(draft)]); setFuture([]); setDraft(content); setTime(0); setSelected(null); } catch (error) { report(error); } finally { setBusy(false); if (projectInput.current) projectInput.current.value = ''; } }
  async function captions(file?: File) { if (!file || locked) return; try {
    if (file.size > 1_000_000) throw new Error('Caption files are limited to 1 MB.');
    const text = (await file.text()).replace(/^WEBVTT[^\n]*\n/, '').replace(/\r/g, '');
    const stamp = (value: string) => value.replace(',', '.').split(':').reduce((sum, number) => sum * 60 + Number(number), 0);
    const next = structuredClone(draft);
    for (const block of text.split(/\n\s*\n/)) { const lines = block.trim().split('\n'), index = lines.findIndex((line) => line.includes('-->')); if (index < 0) continue;
      const times = lines[index]!.match(/([\d:. ,]+)\s*-->\s*([\d:.,]+)/); if (!times) throw new Error('A caption cue has invalid timing.');
      const start = stamp(times[1]!.trim()), end = stamp(times[2]!.trim()); if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0 || end > draft.duration) throw new Error('Caption cues must fit inside the composition duration.');
      const item = newClip('text', end - start, nextTrack(next, start, end - start)); Object.assign(item, { start, text: lines.slice(index + 1).join('\n').replace(/<[^>]*>/g, ''), name: 'Caption', x: draft.width * 0.08, y: draft.height * 0.78, width: draft.width * 0.84, height: draft.height * 0.18, fontSize: Math.max(24, draft.height / 20) }); next.clips.push(item);
    }
    if (next.clips.length === draft.clips.length) throw new Error('No timed caption cues were found. Choose an SRT or WebVTT file.'); change(next);
  } catch (error) { report(error); } finally { if (captionsInput.current) captionsInput.current.value = ''; } }
  async function startRender(format: 'mp4' | 'webm') {
    if (readOnly || conflict || busy || saving) return;
    if (dirty && !await save()) return;
    setBusy(true); setPlaying(false);
    try {
      const bundle = await api(`/artifacts/${artifact.id}`);
      const result: RenderJob = await api(`/artifacts/${artifact.id}/video/render`, 'POST', { version: bundle.artifact.version, format });
      setJobs((items) => [result, ...items.filter((item) => item.id !== result.id)]);
      const check = async () => {
        try {
          const job: RenderJob = await api(`/artifacts/${artifact.id}/video/renders/${result.id}`);
          if (!mounted.current) return;
          setJobs((items) => items.map((item) => item.id === job.id ? job : item));
          if (['queued', 'rendering'].includes(job.status)) { poll.current = setTimeout(check, 700); return; }
          setBusy(false);
          if (job.status === 'completed' && job.downloadUrl) { const response = await fetch(job.downloadUrl, { credentials: 'same-origin', redirect: 'error' }); if (!response.ok) throw new Error('The completed video could not be downloaded. Check project access.'); const bytes = await response.blob(); download(`${artifact.title}-v${job.artifactVersion}.${format}`, bytes, `video/${format}`); }
          else if (job.status !== 'cancelled') onError(job.error ?? 'The video render did not finish. Retry after checking renderer configuration.');
        } catch (error) { if (mounted.current) { setBusy(false); report(error); } }
      }; await check();
    } catch (error) { report(error); setBusy(false); }
  }
  useEffect(() => { void api<RenderJob[]>(`/artifacts/${artifact.id}/video/renders`).then((history) => { if (mounted.current) setJobs(history); }).catch(() => {}); }, [artifact.id]);
  useEffect(() => {
    if (clip?.type === 'audio' && keyProperty !== 'volume') setKeyProperty('volume');
    if (clip && !['audio', 'video'].includes(clip.type) && keyProperty === 'volume') setKeyProperty('opacity');
  }, [clip?.id, clip?.type, keyProperty]);
  const fontRefs = [...new Set(draft.clips.map((item) => item.fontUrl).filter((url): url is string => !!url))].sort().join(',');
  useEffect(() => {
    const controller = new AbortController(), fonts: FontFace[] = [];
    void Promise.all(fontRefs ? fontRefs.split(',').map(async (url) => {
      const response = await fetch(url, { credentials: 'same-origin', redirect: 'error', signal: controller.signal });
      if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'font/woff2') throw new Error('A custom video font is unavailable. Check project access.');
      const bytes = await response.arrayBuffer(); if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('The custom font exceeds 10 MB.');
      const font = new FontFace('ArtifactFont-' + url.split('/').pop(), bytes); await font.load();
      if (!controller.signal.aborted) { document.fonts.add(font); fonts.push(font); }
    }) : []).catch((error) => { if (!controller.signal.aborted) onError((error as Error).message); });
    return () => { controller.abort(); for (const font of fonts) document.fonts.delete(font); };
  }, [fontRefs, onError]);
  const gesture = useRef<{ id: string; mode: 'stage' | 'move' | 'trim-left' | 'trim-right'; x: number; y: number; base: TimelineContent } | null>(null);
  function drag(event: PointerEvent<HTMLElement>, item: VideoClip, mode: 'stage' | 'move' | 'trim-left' | 'trim-right') {
    setSelected(item.id); if (locked || item.locked || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); setPlaying(false); gesture.current = { id: item.id, mode, x: event.clientX, y: event.clientY, base: structuredClone(draft) }; event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLElement>) {
    const active = gesture.current; if (!active || locked) return; const source = active.base.clips.find((item) => item.id === active.id)!;
    try {
      let next: TimelineContent;
      if (active.mode === 'stage') next = { ...active.base, clips: active.base.clips.map((item) => item.id === active.id ? { ...item, x: Math.round(source.x + (event.clientX - active.x) / scale), y: Math.round(source.y + (event.clientY - active.y) / scale) } : item) };
      else { const delta = (event.clientX - active.x) / zoom;
        if (active.mode === 'trim-left') next = trimClip(active.base, active.id, clamp(source.start + delta, source.start, source.start + source.duration - 1 / draft.fps), source.start + source.duration);
        else if (active.mode === 'trim-right') next = trimClip(active.base, active.id, source.start, clamp(source.start + source.duration + delta, source.start + 1 / draft.fps, source.start + source.duration));
        else next = { ...active.base, clips: active.base.clips.map((item) => item.id === active.id ? { ...item, start: frameTime(clamp(source.start + delta, 0, draft.duration - source.duration), draft.fps) } : item) };
      }
      videoContentSchema.parse(next); setDraft(next);
    } catch { /* Dragging into an occupied track or outside trim bounds leaves the last valid position. */ }
  }
  function end(event: PointerEvent<HTMLElement>) { if (!gesture.current) return; if (JSON.stringify(current.current) !== JSON.stringify(gesture.current.base)) { setPast((items) => [...items.slice(-49), gesture.current!.base]); setFuture([]); } gesture.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }
  const tracks = Math.max(2, ...draft.clips.map((item) => item.track + 1));
  const running = jobs.find((job) => ['queued', 'rendering'].includes(job.status));
  return <div className="video-editor" aria-label="Video composition editor">
    <div className="video-tools" role="toolbar" aria-label="Video editing tools">
      <div className="video-tool-group"><IconButton label="Undo" disabled={locked || !past.length} onClick={undo}><Undo2 /></IconButton><IconButton label="Redo" disabled={locked || !future.length} onClick={redo}><Redo2 /></IconButton></div>
      <div className="video-tool-group"><Button size="sm" variant="ghost" disabled={locked} onClick={() => add('text')}><Type />Add text</Button><IconButton label="Add rectangle" disabled={locked} onClick={() => add('rect')}><Square /></IconButton><IconButton label="Add ellipse" disabled={locked} onClick={() => add('ellipse')}><Circle /></IconButton><Button size="sm" variant="ghost" disabled={locked} onClick={() => fileInput.current?.click()}><Upload />Import media</Button><Button size="sm" variant="ghost" disabled={locked} onClick={() => captionsInput.current?.click()}>Captions</Button></div>
      <span className="video-tools-spacer" />
      <Badge>{conflict ? 'Newer revision available' : dirty ? 'Unsaved changes' : `Revision ${version}`}</Badge>
      <Button size="sm" disabled={locked || !dirty} onClick={() => void save()}><Save />{saving ? 'Saving…' : 'Save'}</Button>
    </div>
    {conflict && <div className="video-conflict" role="alert">A teammate saved a newer revision. Your draft is retained.<Button size="sm" variant="outline" onClick={() => { download(`${artifact.title}-draft.json`, JSON.stringify(draft, null, 2)); }}>Download draft</Button><Button size="sm" variant="outline" onClick={() => { const content = normalizeVideo(artifact.content); setDraft(content); setSaved(JSON.stringify(content)); setVersion(artifact.version); setConflict(false); setPast([]); setFuture([]); }}>Load latest</Button></div>}
    <div className="video-workspace">
      <aside className="video-inspector" aria-label="Video composition properties">
        <div className="video-section-title"><Film size={15} /><strong>Composition</strong></div>
        <div className="video-field-pair"><NumberField label="Width" value={draft.width} min={64} max={4096} disabled={locked} onCommit={(width) => change({ ...draft, width })} /><NumberField label="Height" value={draft.height} min={64} max={4096} disabled={locked} onCommit={(height) => change({ ...draft, height })} /></div>
        <div className="video-field-pair"><NumberField label="Duration" value={draft.duration} min={1} max={600} step={0.1} disabled={locked} onCommit={(duration) => { const next = { ...draft, duration, clips: draft.clips.filter((item) => item.start < duration).map((item) => ({ ...item, duration: Math.min(item.duration, duration - item.start) })) }; change(next); setTime(Math.min(time, duration)); }} /><Field label="Frame rate"><Select aria-label="Frame rate" value={draft.fps} disabled={locked} onChange={(event) => change({ ...draft, fps: Number(event.target.value) as 24 | 30 | 60 })}><option value={24}>24 fps</option><option value={30}>30 fps</option><option value={60}>60 fps</option></Select></Field></div>
        <Field label="Background"><Input aria-label="Background" type="color" value={draft.background} disabled={locked} onChange={(event) => change({ ...draft, background: event.target.value })} /></Field>
        <div className="video-section-title"><strong>{clip ? 'Selected clip' : 'Clip properties'}</strong>{clip && <IconButton label={clip.locked ? 'Unlock clip' : 'Lock clip'} disabled={locked} onClick={() => change({ ...draft, clips: draft.clips.map((item) => item.id === clip.id ? { ...item, locked: !item.locked } : item) })}>{clip.locked ? <LockKeyhole /> : <LockKeyholeOpen />}</IconButton>}</div>
        {!clip ? <p className="video-empty-hint">Select a clip on the canvas or timeline to edit its timing, appearance, and keyframes.</p> : <>
          <Field label="Clip name"><Input aria-label="Clip name" value={clip.name} disabled={locked || clip.locked} maxLength={180} onChange={(event) => patch({ name: event.target.value || 'Untitled clip' })} /></Field>
          {clip.type === 'text' && <Field label="Layer text"><Textarea aria-label="Layer text" value={clip.text} disabled={locked || clip.locked} maxLength={10000} onChange={(event) => patch({ text: event.target.value })} /></Field>}
          <NumberField label="Track" value={clip.track + 1} min={1} max={32} disabled={locked || clip.locked} onCommit={(track) => patch({ track: Math.round(track) - 1 })} />
          <div className="video-field-pair"><NumberField label="Clip start" value={clip.start} min={0} max={draft.duration - clip.duration} step={1 / draft.fps} disabled={locked || clip.locked} onCommit={(start) => patch({ start })} /><NumberField label="Clip duration" value={clip.duration} min={1 / draft.fps} max={draft.duration - clip.start} step={1 / draft.fps} disabled={locked || clip.locked} onCommit={(duration) => patch({ duration })} /></div>
          {(clip.type === 'audio' || clip.type === 'video') && <><NumberField label="Source in" value={clip.mediaStart} min={0} max={Math.max(0, (clip.sourceDuration ?? 36000) - clip.duration)} step={1 / draft.fps} disabled={locked || clip.locked} onCommit={(mediaStart) => patch({ mediaStart })} /><div className="video-field-pair"><NumberField label="Volume" value={clip.volume} min={0} max={1} step={0.05} disabled={locked || clip.locked} onCommit={(volume) => patch({ volume })} /><Button variant="outline" size="sm" disabled={locked || clip.locked} onClick={() => patch({ muted: !clip.muted })}>{clip.muted ? <VolumeX /> : <Volume2 />}{clip.muted ? 'Unmute' : 'Mute'}</Button></div></>}
          {clip.type !== 'audio' && <><div className="video-field-pair"><NumberField label="X" value={clip.x} disabled={locked || clip.locked} onCommit={(x) => patch({ x })} /><NumberField label="Y" value={clip.y} disabled={locked || clip.locked} onCommit={(y) => patch({ y })} /></div><div className="video-field-pair"><NumberField label="Clip width" value={clip.width} min={1} max={16384} disabled={locked || clip.locked} onCommit={(width) => patch({ width })} /><NumberField label="Clip height" value={clip.height} min={1} max={16384} disabled={locked || clip.locked} onCommit={(height) => patch({ height })} /></div><div className="video-field-pair"><NumberField label="Rotation" value={clip.rotation} disabled={locked || clip.locked} onCommit={(rotation) => patch({ rotation })} /><NumberField label="Opacity" value={clip.opacity} min={0} max={1} step={0.05} disabled={locked || clip.locked} onCommit={(opacity) => patch({ opacity })} /></div><NumberField label="Scale" value={clip.scale} min={0.01} max={100} step={0.05} disabled={locked || clip.locked} onCommit={(scale) => patch({ scale })} />{['text', 'rect', 'ellipse'].includes(clip.type) && <Field label="Clip color"><Input aria-label="Clip color" type="color" value={clip.fill} disabled={locked || clip.locked} onChange={(event) => patch({ fill: event.target.value })} /></Field>}{clip.type === 'text' && <NumberField label="Font size" value={clip.fontSize} min={1} max={500} disabled={locked || clip.locked} onCommit={(fontSize) => patch({ fontSize })} />}</>}
          <div className="video-edit-actions"><IconButton label="Duplicate clip" disabled={locked || clip.locked} onClick={duplicate}><Copy /></IconButton><IconButton label="Delete clip" disabled={locked || clip.locked} onClick={remove}><Trash2 /></IconButton><Button size="sm" variant="outline" disabled={locked || clip.locked} onClick={() => { try { change(splitClip(draft, clip.id, time)); } catch (error) { report(error); } }}><Scissors />Split</Button></div>
          <div className="video-section-title"><KeyRound size={14} /><strong>Keyframes</strong></div>
          <div className="video-field-pair"><Select aria-label="Animated property" value={keyProperty} onChange={(event) => setKeyProperty(event.target.value as VideoProperty)}>{videoProperties.filter((property) => clip.type === 'audio' ? property === 'volume' : property !== 'volume' || clip.type === 'video').map((property) => <option key={property} value={property}>{property[0]!.toUpperCase() + property.slice(1)}</option>)}</Select><Select aria-label="Keyframe easing" value={easing} onChange={(event) => setEasing(event.target.value as VideoKeyframe['easing'])}><option value="linear">Linear</option><option value="ease-in">Ease in</option><option value="ease-out">Ease out</option><option value="ease-in-out">Ease in/out</option><option value="hold">Hold</option></Select></div>
          <Button size="sm" variant="outline" disabled={locked || clip.locked || !activeClip(clip, time)} onClick={() => { const at = frameTime(time - clip.start + clip.animationOffset, draft.fps); patch({ keyframes: [...clip.keyframes.filter((key) => key.property !== keyProperty || Math.abs(key.at - at) > 0.00001), { property: keyProperty, at, value: clipValue(clip, keyProperty, time), easing }] }); }}>Add keyframe at playhead</Button>
          <div className="video-keyframes">{clip.keyframes.filter((key) => key.property === keyProperty).sort((a, b) => a.at - b.at).map((key) => <div className="video-keyframe" key={`${key.property}:${key.at}`}><button onClick={() => { setPlaying(false); setTime(clamp(clip.start + key.at - clip.animationOffset, 0, draft.duration)); }}>{timecode(clip.start + key.at - clip.animationOffset, draft.fps)}</button><NumberField label={`${key.property} at ${key.at}s`} value={key.value} disabled={locked || clip.locked} onCommit={(value) => patch({ keyframes: clip.keyframes.map((entry) => entry === key ? { ...entry, value } : entry) })} /><IconButton label={`Remove ${key.property} keyframe at ${key.at}s`} disabled={locked || clip.locked} onClick={() => patch({ keyframes: clip.keyframes.filter((entry) => entry !== key) })}><X /></IconButton></div>)}</div>
        </>}
      </aside>
      <div className="video-stage-column">
        <div className="video-stage" ref={stage}>
          <div className="video-artboard-shell" style={{ width: draft.width * scale, height: draft.height * scale }}>
            <div className="video-artboard" role="img" aria-label={`Video preview at ${timecode(time, draft.fps)}`} style={{ width: draft.width, height: draft.height, background: draft.background, transform: `scale(${scale})` }}>
              {draft.clips.map((item) => { const sampled = clipAt(item, time); const style: CSSProperties = { left: sampled.x, top: sampled.y, width: item.width, height: item.height, transform: `rotate(${sampled.rotation}deg) scale(${sampled.scale})`, opacity: sampled.opacity, zIndex: item.track, display: activeClip(item, time) && item.type !== 'audio' ? 'block' : 'none', color: item.fill, background: ['rect', 'ellipse'].includes(item.type) ? item.fill : undefined, borderRadius: item.type === 'ellipse' ? '50%' : undefined, fontSize: item.fontSize, fontFamily: item.fontFamily === 'Custom' ? `'ArtifactFont-${item.fontUrl?.split('/').pop()}'` : item.fontFamily };
                return <div key={item.id} className={`video-preview-clip ${selected === item.id ? 'is-selected' : ''}`} style={style} data-clip-id={item.id} onPointerDown={(event) => drag(event, item, 'stage')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>{item.type === 'text' ? item.text : item.type === 'image' ? <img src={item.src} alt={item.name} draggable={false} /> : item.type === 'video' || item.type === 'audio' ? <MediaClip clip={item} time={time} playing={playing} onError={onError} /> : null}</div>;
              })}
            </div>
          </div>
          <div className="video-stage-meta">{draft.width} × {draft.height}<span>{draft.fps} fps</span><span>{draft.clips.length} {draft.clips.length === 1 ? 'clip' : 'clips'}</span></div>
        </div>
        <div className="video-transport"><IconButton label="Go to start" onClick={() => { setPlaying(false); setTime(0); }}><SkipBack /></IconButton><IconButton label={playing ? 'Pause video' : 'Play video'} onClick={() => { if (time >= draft.duration) setTime(0); setPlaying(!playing); }}>{playing ? <Pause /> : <Play />}</IconButton><output aria-label="Playhead time">{timecode(time, draft.fps)}</output><Input type="range" aria-label="Video playhead" min={0} max={draft.duration} step={1 / draft.fps} value={time} onChange={(event) => { setPlaying(false); setTime(Number(event.target.value)); }} /><span>{timecode(draft.duration, draft.fps)}</span></div>
        <div className="video-export"><Button size="sm" variant="outline" disabled={busy} onClick={() => download(`${artifact.title}.video.json`, JSON.stringify(draft, null, 2))}>Project JSON</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void portable()}><Download />HyperFrames ZIP</Button><Button size="sm" variant="ghost" disabled={locked} onClick={() => projectInput.current?.click()}>Import project</Button><span className="video-tools-spacer" /><Button size="sm" variant="outline" disabled={readOnly || conflict || busy || saving} onClick={() => void startRender('webm')}>WebM</Button><Button size="sm" disabled={readOnly || conflict || busy || saving} onClick={() => void startRender('mp4')}><Download />Render MP4</Button></div>
        {running && <div className="video-render-status" role="status"><span>{running.status === 'queued' ? 'Render queued' : `Rendering ${Math.round(running.progress * 100)}%`} · revision {running.artifactVersion}</span><progress value={running.progress} max={1} /><Button size="sm" variant="ghost" onClick={() => void api(`/artifacts/${artifact.id}/video/renders/${running.id}`, 'DELETE').then(() => setBusy(false)).catch(report)}>Cancel render</Button></div>}
      </div>
    </div>
    <div className="video-timeline">
      <div className="video-timeline-heading"><strong>Timeline</strong><span>Drag clips to move · drag ends to trim</span><span className="video-tools-spacer" /><label>Zoom<Input aria-label="Timeline zoom" type="range" min={20} max={180} value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label></div>
      <div className="video-timeline-scroll"><div className="video-timeline-content" style={{ width: Math.max(500, draft.duration * zoom + 114) }}>
        <div className="video-time-ruler"><span>Tracks</span>{Array.from({ length: Math.ceil(draft.duration) + 1 }, (_, index) => index).filter((index) => draft.duration <= 60 || index % 5 === 0).map((second) => <button key={second} style={{ left: 114 + second * zoom }} onClick={() => { setPlaying(false); setTime(second); }}>{second}s</button>)}</div>
        {Array.from({ length: tracks }, (_, index) => <div className="video-track" key={index}><div className="video-track-label">Track {index + 1}</div>{draft.clips.filter((item) => item.track === index).map((item) => <div key={item.id} className={`video-timeline-clip ${item.type} ${selected === item.id ? 'is-selected' : ''} ${item.locked ? 'is-locked' : ''}`} role="button" tabIndex={0} aria-label={`${item.name}, track ${index + 1}, ${item.start.toFixed(2)} to ${(item.start + item.duration).toFixed(2)} seconds`} aria-pressed={selected === item.id} style={{ left: 114 + item.start * zoom, width: Math.max(5, item.duration * zoom) }} onPointerDown={(event) => drag(event, item, 'move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onClick={() => setSelected(item.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { setSelected(item.id); event.preventDefault(); } if (!locked && !item.locked && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); change({ ...draft, clips: draft.clips.map((entry) => entry.id === item.id ? { ...entry, start: frameTime(clamp(entry.start + (event.key === 'ArrowLeft' ? -1 : 1) / draft.fps, 0, draft.duration - entry.duration), draft.fps) } : entry) }); } }}><span className="video-trim-handle start" onPointerDown={(event) => drag(event, item, 'trim-left')} />{item.type === 'audio' ? <Music2 size={13} /> : item.type === 'video' ? <Film size={13} /> : item.type === 'image' ? <ImageIcon size={13} /> : <Type size={13} />}<span>{item.name}</span>{item.locked && <LockKeyhole size={11} />}<span className="video-trim-handle end" onPointerDown={(event) => drag(event, item, 'trim-right')} /></div>)}</div>)}
        <div className="video-playhead" style={{ left: 114 + time * zoom }} aria-hidden="true" />
      </div></div>
    </div>
    <input ref={fileInput} className="sr-only" aria-label="Import video, audio, or image file" type="file" accept="video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg,audio/webm,image/png,image/jpeg,image/webp" disabled={locked} onChange={(event) => void imported(event.target.files?.[0])} />
    <input ref={projectInput} className="sr-only" aria-label="Import HyperFrames Studio project" type="file" accept=".zip,.json,application/zip,application/json" disabled={locked} onChange={(event) => void projectImport(event.target.files?.[0])} />
    <input ref={captionsInput} className="sr-only" aria-label="Import SRT or WebVTT captions" type="file" accept=".srt,.vtt,text/vtt" disabled={locked} onChange={(event) => void captions(event.target.files?.[0])} />
  </div>;
}
