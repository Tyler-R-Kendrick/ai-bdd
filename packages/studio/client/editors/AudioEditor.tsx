import { useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  Scissors,
  Upload,
  Download,
  Save,
  Plus,
  Undo2,
  Redo2,
  Trash2,
  Volume2,
  Music2,
} from 'lucide-react';
import type { MediaProps } from '../App.tsx';
import { api, download, ApiError } from '../lib.ts';
import {
  audioContentSchema,
  audioTrackSchema,
  initialAudioContent,
  type AudioContent,
  type AudioClip,
  type AudioTrack,
} from '../../shared/audio.ts';
import {
  loadAudioSources,
  scheduleAudio,
  toneWav,
  type DecodedSource,
} from './audio/playback.ts';
import './audio/audio.css';
type RenderJob = {
  id: string;
  status: string;
  format: string;
  progress: number;
  artifactVersion: number;
  error?: string;
  downloadUrl?: string;
};
const uid = () => crypto.randomUUID();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clean = (n: number) => Math.round(n * 1000) / 1000;
const normalized = (raw: unknown) =>
  audioContentSchema.safeParse(raw).success
    ? audioContentSchema.parse(raw)
    : initialAudioContent();
function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  onError,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onError: (e: unknown) => void;
}) {
  const [text, setText] = useState(String(clean(value)));
  useEffect(() => setText(String(clean(value))), [value]);
  const commit = () => {
    const next = Number(text);
    if (
      text.trim() === '' ||
      !Number.isFinite(next) ||
      next < min ||
      next > max
    ) {
      setText(String(clean(value)));
      onError(
        new Error(`${label} must be between ${clean(min)} and ${clean(max)}.`),
      );
      return;
    }
    if (next !== value) onChange(next);
  };
  return (
    <label>
      {label}
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </label>
  );
}
function Waveform({
  clip,
  source,
  width,
}: {
  clip: AudioClip;
  source?: DecodedSource;
  width: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const w = Math.max(2, Math.min(1800, Math.round(width))),
      h = 66;
    el.width = w * 2;
    el.height = h * 2;
    const ctx = el.getContext('2d')!;
    ctx.scale(2, 2);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#5062b8';
    ctx.lineWidth = 1;
    if (!source) {
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
      return;
    }
    const channels = Array.from(
        { length: source.buffer.numberOfChannels },
        (_, channel) => source.buffer.getChannelData(channel),
      ),
      rate = source.buffer.sampleRate;
    for (let x = 0; x < w; x++) {
      const fraction = x / w,
        at = clip.reverse
          ? clip.duration - fraction * clip.duration
          : fraction * clip.duration;
      const first = Math.floor((clip.offset + at) * rate),
        span = Math.max(1, Math.floor((clip.duration * rate) / w)),
        stride = Math.max(1, Math.floor(span / 12));
      let peak = 0;
      for (const data of channels)
        for (let i = 0; i < span; i += stride)
          peak = Math.max(
            peak,
            Math.abs(
              data[
                Math.max(
                  0,
                  Math.min(data.length - 1, first + (clip.reverse ? -i : i)),
                )
              ] ?? 0,
            ),
          );
      const fade =
        Math.min(
          1,
          clip.fadeIn ? (fraction * clip.duration) / clip.fadeIn : 1,
        ) *
        Math.min(
          1,
          clip.fadeOut ? ((1 - fraction) * clip.duration) / clip.fadeOut : 1,
        );
      const amplitude =
        Math.min(1, peak * Math.pow(10, clip.gainDb / 20)) * fade * 28;
      ctx.beginPath();
      ctx.moveTo(x, h / 2 - amplitude);
      ctx.lineTo(x, h / 2 + amplitude);
      ctx.stroke();
    }
  }, [clip, source, width]);
  return (
    <canvas
      ref={canvas}
      className="audio-waveform"
      data-source-ready={Boolean(source)}
      aria-hidden="true"
    />
  );
}
export default function AudioEditor({
  artifact,
  readOnly,
  onSave,
  onDirty,
  onError,
}: MediaProps) {
  const [draft, setDraft] = useState<AudioContent>(() =>
      normalized(artifact.content),
    ),
    [saved, setSaved] = useState(() =>
      JSON.stringify(normalized(artifact.content)),
    ),
    [version, setVersion] = useState(artifact.version);
  const [selected, setSelected] = useState(''),
    [trackId, setTrackId] = useState(''),
    [time, setTime] = useState(0),
    [zoom, setZoom] = useState(75),
    [playing, setPlaying] = useState(false),
    [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [conflict, setConflict] = useState(false),
    [, setSourceRevision] = useState(0),
    [jobs, setJobs] = useState<RenderJob[]>([]),
    [format, setFormat] = useState('wav'),
    [error, setError] = useState('');
  const [past, setPast] = useState<AudioContent[]>([]),
    [future, setFuture] = useState<AudioContent[]>([]);
  const context = useRef<AudioContext | null>(null),
    cache = useRef(new Map<string, DecodedSource>()),
    transport = useRef<ReturnType<typeof scheduleAudio> | null>(null),
    current = useRef(draft),
    savedRef = useRef(saved),
    fileInput = useRef<HTMLInputElement>(null),
    projectInput = useRef<HTMLInputElement>(null),
    renderRequest = useRef<{
      version: number;
      format: string;
      id: string;
    } | null>(null),
    mounted = useRef(true);
  current.current = draft;
  savedRef.current = saved;
  const dirty = JSON.stringify(draft) !== saved,
    locked = readOnly || busy || saving || conflict;
  const selectedTrack =
      draft.tracks.find((t) => t.id === trackId) ??
      draft.tracks.find((t) => t.clips.some((c) => c.id === selected)),
    clip = selectedTrack?.clips.find((c) => c.id === selected);
  function fail(e: unknown) {
    const text = message(e);
    if (mounted.current) setError(text);
    onError(text);
  }
  function stop() {
    transport.current?.stop();
    transport.current = null;
    setPlaying(false);
  }
  function mutate(change: (next: AudioContent) => void) {
    if (locked) return;
    stop();
    try {
      const next = structuredClone(current.current);
      change(next);
      const valid = audioContentSchema.parse(next);
      setPast((p) => [...p.slice(-49), current.current]);
      setFuture([]);
      setDraft(valid);
      setError('');
    } catch (e) {
      fail(e);
    }
  }
  function patchClip(patch: Partial<AudioClip>) {
    if (!clip) return;
    const proposed = { ...clip, ...patch },
      source = cache.current.get(clip.src);
    if (
      source &&
      proposed.offset + proposed.duration > source.buffer.duration + 0.002
    ) {
      fail(new Error('The trim extends beyond the decoded audio source.'));
      return;
    }
    mutate((next) => {
      const item = next.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === clip.id)!;
      Object.assign(item, patch);
    });
  }
  function patchTrack(patch: Partial<AudioTrack>) {
    if (!selectedTrack) return;
    mutate((next) =>
      Object.assign(next.tracks.find((t) => t.id === selectedTrack.id)!, patch),
    );
  }
  function audioContext() {
    if (!context.current)
      context.current = new AudioContext({ sampleRate: 48000 });
    return context.current;
  }
  async function loadSources(value = current.current) {
    const ctx = audioContext();
    await loadAudioSources(artifact.id, value, ctx, cache.current);
    if (mounted.current) setSourceRevision((v) => v + 1);
    return ctx;
  }
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      transport.current?.stop();
      void context.current?.close();
      cache.current.clear();
      onDirty(false);
    };
  }, [onDirty]);
  useEffect(() => {
    if (artifact.version <= version) return;
    const incoming = normalized(artifact.content),
      serialized = JSON.stringify(incoming);
    if (
      JSON.stringify(current.current) !== savedRef.current &&
      serialized !== JSON.stringify(current.current)
    ) {
      setConflict(true);
      stop();
      return;
    }
    setDraft(incoming);
    setSaved(serialized);
    setVersion(artifact.version);
    setConflict(false);
  }, [artifact, version]);
  useEffect(() => {
    const controller = new AbortController();
    const value = current.current;
    if (!value.tracks.some((t) => t.clips.length)) return;
    void loadAudioSources(
      artifact.id,
      value,
      audioContext(),
      cache.current,
      controller.signal,
    ).then(
      () => {
        if (!controller.signal.aborted) setSourceRevision((v) => v + 1);
      },
      (e) => {
        if (!controller.signal.aborted) fail(e);
      },
    );
    return () => controller.abort();
  }, [
    artifact.id,
    JSON.stringify(draft.tracks.map((t) => t.clips.map((c) => c.src))),
  ]);
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const values = await api<RenderJob[]>(
          `/artifacts/${artifact.id}/audio/renders`,
        );
        if (alive) setJobs(values);
      } catch (e) {
        if (alive) setError(message(e));
      }
      if (alive) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [artifact.id]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const from = time,
      started = transport.current!.startedAt;
    const tick = () => {
      const next = Math.min(
        draft.duration,
        from + Math.max(0, audioContext().currentTime - started),
      );
      setTime(next);
      if (next >= draft.duration) {
        stop();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  async function play() {
    if (playing) {
      stop();
      return;
    }
    setBusy(true);
    try {
      const ctx = audioContext();
      await ctx.resume();
      await loadSources();
      const from = time >= draft.duration ? 0 : time;
      setTime(from);
      transport.current = scheduleAudio(
        ctx,
        current.current,
        cache.current,
        from,
      );
      setPlaying(true);
      setError('');
    } catch (e) {
      stop();
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (locked) return;
    setSaving(true);
    const value = current.current;
    try {
      await onSave(value, version);
      setSaved(JSON.stringify(value));
      setVersion((v) => v + 1);
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      fail(e);
    } finally {
      setSaving(false);
    }
  }
  async function upload(file: File) {
    if (file.size > 10 * 1024 * 1024)
      throw new Error('Audio sources are limited to 10 MiB.');
    const body = new FormData();
    body.set('file', file);
    const result = await api<{ id: string }>(
      `/artifacts/${artifact.id}/files`,
      'POST',
      body,
    );
    return `/api/files/${result.id}`;
  }
  async function addSource(file: File) {
    if (locked) return;
    setBusy(true);
    stop();
    try {
      const url = await upload(file),
        next = structuredClone(current.current),
        ctx = audioContext();
      const probe = await api<{ duration: number }>(
        `/artifacts/${artifact.id}/audio/sources/${url.split('/').pop()}`,
      );
      const duration = Math.min(300, probe.duration),
        newTrack = audioTrackSchema.parse({
          id: uid(),
          title:
            file.name.replace(/\.[^.]+$/, '').slice(0, 180) || 'Audio track',
          clips: [
            {
              id: uid(),
              title: file.name.slice(0, 180),
              src: url,
              start: 0,
              offset: 0,
              duration,
            },
          ],
        });
      next.duration = Math.max(next.duration, duration);
      next.tracks.push(newTrack);
      const parsed = audioContentSchema.parse(next);
      await loadAudioSources(artifact.id, parsed, ctx, cache.current);
      setPast((p) => [...p.slice(-49), current.current]);
      setFuture([]);
      setDraft(parsed);
      setTrackId(newTrack.id);
      setSelected(newTrack.clips[0]!.id);
      setSourceRevision((v) => v + 1);
      setError('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  function split() {
    if (!clip) return;
    const cut = time - clip.start;
    if (cut < 0.01 || clip.duration - cut < 0.01)
      return fail(
        new Error('Place the playhead inside the selected clip to split it.'),
      );
    mutate((next) => {
      const track = next.tracks.find((t) => t.id === selectedTrack!.id)!,
        index = track.clips.findIndex((c) => c.id === clip.id),
        left = {
          ...clip,
          duration: cut,
          fadeIn: Math.min(clip.fadeIn, cut),
          fadeOut: 0,
        },
        right = {
          ...clip,
          id: uid(),
          title: clip.title + ' · split',
          start: time,
          duration: clip.duration - cut,
          fadeIn: 0,
          fadeOut: Math.min(clip.fadeOut, clip.duration - cut),
        };
      if (clip.reverse) {
        left.offset = clip.offset + clip.duration - cut;
        right.offset = clip.offset;
      } else right.offset = clip.offset + cut;
      track.clips.splice(index, 1, left, right);
    });
  }
  async function render(requestedFormat = format) {
    if (locked || dirty) return;
    setBusy(true);
    try {
      const existing = renderRequest.current;
      if (
        !existing ||
        existing.version !== version ||
        existing.format !== requestedFormat
      )
        renderRequest.current = { version, format: requestedFormat, id: uid() };
      const result = await api<RenderJob>(
        `/artifacts/${artifact.id}/audio/render`,
        'POST',
        {
          version,
          format: requestedFormat,
          idempotencyKey: renderRequest.current!.id,
        },
      );
      setJobs((old) => [result, ...old.filter((j) => j.id !== result.id)]);
      renderRequest.current = null;
      setError('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function exportProject() {
    setBusy(true);
    try {
      const assets: Record<string, { mime: string; data: string }> = {};
      let total = 0;
      for (const url of new Set(
        draft.tracks.flatMap((t) => t.clips.map((c) => c.src)),
      )) {
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok)
          throw new Error('A project source is no longer accessible.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        total += bytes.length;
        if (bytes.length > 10 * 1024 * 1024 || total > 64 * 1024 * 1024)
          throw new Error('Portable project sources exceed their size budget.');
        let raw = '';
        for (let i = 0; i < bytes.length; i += 8192)
          raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
        assets[url] = {
          mime:
            response.headers.get('content-type')?.split(';')[0] ?? 'audio/wav',
          data: btoa(raw),
        };
      }
      download(
        `${artifact.title}.audio.json`,
        JSON.stringify({
          format: 'studio-audio',
          version: 1,
          content: draft,
          assets,
        }),
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function importProject(file: File) {
    if (locked) return;
    setBusy(true);
    stop();
    try {
      if (file.size > 90 * 1024 * 1024)
        throw new Error('Portable audio projects are limited to 90 MiB.');
      const raw = JSON.parse(await file.text());
      if (
        raw.format !== 'studio-audio' ||
        raw.version !== 1 ||
        !raw.assets ||
        typeof raw.assets !== 'object'
      )
        throw new Error('Choose a Studio audio project.');
      const parsed = audioContentSchema.parse(raw.content),
        urls = [
          ...new Set(parsed.tracks.flatMap((t) => t.clips.map((c) => c.src))),
        ];
      if (urls.length > 32) throw new Error('Too many audio project sources.');
      const inputs = new Map<string, File>();
      let total = 0;
      for (const url of urls) {
        const asset = raw.assets[url];
        if (
          !asset ||
          typeof asset.data !== 'string' ||
          asset.data.length > 14 * 1024 * 1024 ||
          typeof asset.mime !== 'string' ||
          !asset.mime.startsWith('audio/') ||
          asset.mime === 'audio/midi'
        )
          throw new Error('A portable source is missing or invalid.');
        const decoded = atob(asset.data);
        total += decoded.length;
        if (decoded.length > 10 * 1024 * 1024 || total > 64 * 1024 * 1024)
          throw new Error('Portable sources exceed their size budget.');
        inputs.set(
          url,
          new File(
            [Uint8Array.from(decoded, (c) => c.charCodeAt(0))],
            'imported-source',
            { type: asset.mime },
          ),
        );
      }
      const mapping = new Map<string, string>();
      for (const [url, input] of inputs) mapping.set(url, await upload(input));
      for (const track of parsed.tracks)
        for (const item of track.clips) item.src = mapping.get(item.src)!;
      await loadSources(parsed);
      setPast((p) => [...p.slice(-49), current.current]);
      setFuture([]);
      setDraft(parsed);
      setSelected('');
      setTrackId(parsed.tracks[0]?.id ?? '');
      setError('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  const number = (
    label: string,
    value: number,
    onChange: (n: number) => void,
    min: number,
    max: number,
    step = 0.01,
  ) => (
    <NumberField
      label={label}
      value={value}
      onChange={onChange}
      min={min}
      max={max}
      step={step}
      disabled={locked}
      onError={fail}
    />
  );
  return (
    <div
      className="audio-editor"
      data-testid="audio-editor"
      role="region"
      aria-label="Audio composition editor"
    >
      <input
        hidden
        ref={fileInput}
        aria-label="Import recorded audio file"
        type="file"
        accept="audio/wav,audio/x-wav,audio/flac,audio/mpeg,audio/mp4,audio/ogg,audio/webm,audio/aiff,.wav,.flac,.mp3,.m4a,.ogg,.aif,.aiff"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void addSource(file);
        }}
      />
      <input
        hidden
        ref={projectInput}
        aria-label="Import portable audio project"
        type="file"
        accept=".json,application/json"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void importProject(file);
        }}
      />
      <div className="audio-toolbar">
        <div className="audio-toolbar-group">
          <Music2 size={18} />
          <strong>Audio studio</strong>
          <span className="audio-status">
            {readOnly
              ? 'View only'
              : dirty
                ? 'Unsaved changes'
                : `Saved · v${version}`}
          </span>
        </div>
        <div className="audio-toolbar-group">
          <button disabled={locked} onClick={() => fileInput.current?.click()}>
            <Upload size={15} />
            Import audio
          </button>
          <button
            disabled={locked}
            onClick={() =>
              void addSource(
                new File([toneWav()], 'A440 tone.wav', { type: 'audio/wav' }),
              )
            }
          >
            <Plus size={15} />
            Tone
          </button>
          <button
            disabled={locked}
            onClick={() =>
              mutate((next) => {
                const track = audioTrackSchema.parse({
                  id: uid(),
                  title: `Track ${next.tracks.length + 1}`,
                  clips: [],
                });
                next.tracks.push(track);
                setTrackId(track.id);
                setSelected('');
              })
            }
          >
            Add track
          </button>
        </div>
        <div className="audio-toolbar-group">
          <button
            aria-label="Undo audio edit"
            disabled={locked || !past.length}
            onClick={() => {
              stop();
              setFuture((f) => [draft, ...f]);
              setDraft(past[past.length - 1]!);
              setPast((p) => p.slice(0, -1));
            }}
          >
            <Undo2 size={15} />
          </button>
          <button
            aria-label="Redo audio edit"
            disabled={locked || !future.length}
            onClick={() => {
              stop();
              setPast((p) => [...p, draft]);
              setDraft(future[0]!);
              setFuture((f) => f.slice(1));
            }}
          >
            <Redo2 size={15} />
          </button>
          <button disabled={locked || !dirty} onClick={() => void save()}>
            <Save size={15} />
            {saving ? 'Saving…' : 'Save audio'}
          </button>
        </div>
      </div>
      {conflict && (
        <div role="alert" className="audio-alert">
          A newer revision arrived. Your local edits are preserved.{' '}
          <button onClick={() => void exportProject()}>
            Download local draft
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  const latest = await api<{ artifact: typeof artifact }>(
                    `/artifacts/${artifact.id}`,
                  );
                  stop();
                  const value = normalized(latest.artifact.content);
                  setDraft(value);
                  setSaved(JSON.stringify(value));
                  setVersion(latest.artifact.version);
                  setConflict(false);
                  setPast([]);
                  setFuture([]);
                } catch (e) {
                  fail(e);
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            Load saved revision
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="audio-alert">
          {error}
          <button aria-label="Dismiss audio error" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}
      <div className="audio-transport">
        <button
          aria-label="Return to audio start"
          onClick={() => {
            stop();
            setTime(0);
          }}
        >
          <SkipBack size={16} />
        </button>
        <button
          className="audio-play"
          disabled={busy}
          onClick={() => void play()}
        >
          {playing ? <Pause size={17} /> : <Play size={17} />}{' '}
          {playing ? 'Pause' : 'Play audio'}
        </button>
        <output aria-label="Audio playhead">
          {time.toFixed(2)} <span>/ {draft.duration.toFixed(2)} s</span>
        </output>
        <label className="audio-seek">
          Seek
          <input
            aria-label="Audio seek"
            type="range"
            min="0"
            max={draft.duration}
            step="0.01"
            value={time}
            onChange={(e) => {
              stop();
              setTime(Number(e.target.value));
            }}
          />
        </label>
        <label>
          Zoom
          <input
            aria-label="Audio zoom"
            type="range"
            min="30"
            max="180"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="audio-timeline-scroll">
        <div
          className="audio-timeline"
          style={{ minWidth: 180 + draft.duration * zoom }}
        >
          <div className="audio-ruler">
            <div>
              TRACKS <span>{draft.tracks.length}</span>
            </div>
            <div
              className="audio-ruler-time"
              style={{ width: draft.duration * zoom }}
              onClick={(e) => {
                stop();
                setTime(
                  Math.min(
                    draft.duration,
                    Math.max(
                      0,
                      (e.clientX -
                        e.currentTarget.getBoundingClientRect().left) /
                        zoom,
                    ),
                  ),
                );
              }}
            >
              {Array.from({ length: Math.ceil(draft.duration) + 1 }, (_, i) => (
                <span key={i} style={{ left: i * zoom }}>
                  {i}s
                </span>
              ))}
              <div className="audio-playhead" style={{ left: time * zoom }} />
            </div>
          </div>
          {!draft.tracks.length && (
            <div className="audio-empty">
              <Volume2 size={30} />
              <h3>A place for every sound</h3>
              <p>
                Import a recording or add a tone, then trim, mix and export your
                tracks.
              </p>
              <button
                disabled={locked}
                onClick={() => fileInput.current?.click()}
              >
                Import your first recording
              </button>
            </div>
          )}
          {draft.tracks.map((track, index) => (
            <div
              className={`audio-track ${selectedTrack?.id === track.id ? 'selected' : ''}`}
              key={track.id}
            >
              <div
                className="audio-track-label"
                onClick={() => {
                  setTrackId(track.id);
                  setSelected(track.clips[0]?.id ?? '');
                }}
              >
                <div>
                  <span className="audio-track-index">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <strong>{track.title}</strong>
                </div>
                <div className="audio-track-buttons">
                  <button
                    aria-label={`Mute ${track.title}`}
                    aria-pressed={track.mute}
                    disabled={locked}
                    onClick={(e) => {
                      e.stopPropagation();
                      mutate((next) => {
                        const t = next.tracks.find((t) => t.id === track.id)!;
                        t.mute = !t.mute;
                      });
                    }}
                  >
                    M
                  </button>
                  <button
                    aria-label={`Solo ${track.title}`}
                    aria-pressed={track.solo}
                    disabled={locked}
                    onClick={(e) => {
                      e.stopPropagation();
                      mutate((next) => {
                        const t = next.tracks.find((t) => t.id === track.id)!;
                        t.solo = !t.solo;
                      });
                    }}
                  >
                    S
                  </button>
                  <span>
                    {track.gainDb > 0 ? '+' : ''}
                    {track.gainDb} dB ·{' '}
                    {track.pan === 0 ? 'C' : track.pan < 0 ? 'L' : 'R'}
                  </span>
                </div>
              </div>
              <div
                className="audio-track-lane"
                style={{
                  width: draft.duration * zoom,
                  backgroundSize: `${zoom}px 100%`,
                }}
              >
                {track.clips.map((item) => (
                  <button
                    key={item.id}
                    className={`audio-clip ${selected === item.id ? 'selected' : ''}`}
                    aria-label={`Select clip ${item.title}`}
                    style={{
                      left: item.start * zoom,
                      width: item.duration * zoom,
                    }}
                    onClick={() => {
                      setTrackId(track.id);
                      setSelected(item.id);
                    }}
                    onPointerDown={(e) => {
                      if (locked) return;
                      const target = e.currentTarget,
                        first = e.clientX,
                        original = item.start;
                      target.setPointerCapture(e.pointerId);
                      let last = original;
                      const move = (event: PointerEvent) => {
                        last = clean(
                          Math.min(
                            draft.duration - item.duration,
                            Math.max(
                              0,
                              original + (event.clientX - first) / zoom,
                            ),
                          ),
                        );
                        target.style.left = `${last * zoom}px`;
                      };
                      const end = () => {
                        target.removeEventListener('pointermove', move);
                        target.removeEventListener('pointerup', end);
                        target.removeEventListener('pointercancel', cancel);
                        target.style.left = `${original * zoom}px`;
                        if (last !== original)
                          mutate((next) => {
                            next.tracks
                              .flatMap((t) => t.clips)
                              .find((c) => c.id === item.id)!.start = last;
                          });
                      };
                      const cancel = () => {
                        target.style.left = `${original * zoom}px`;
                        target.removeEventListener('pointermove', move);
                        target.removeEventListener('pointerup', end);
                        target.removeEventListener('pointercancel', cancel);
                      };
                      target.addEventListener('pointermove', move);
                      target.addEventListener('pointerup', end);
                      target.addEventListener('pointercancel', cancel);
                    }}
                  >
                    <span>
                      {item.title}
                      {item.reverse ? ' ↶' : ''}
                    </span>
                    <Waveform
                      clip={item}
                      source={cache.current.get(item.src)}
                      width={item.duration * zoom}
                    />
                  </button>
                ))}
                <div className="audio-playhead" style={{ left: time * zoom }} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="audio-inspectors">
        <section>
          <h3>
            Clip inspector{' '}
            <span>{clip ? 'Non-destructive edits' : 'Select a waveform'}</span>
          </h3>
          {clip ? (
            <>
              <label>
                Clip name
                <input
                  aria-label="Clip name"
                  value={clip.title}
                  maxLength={180}
                  disabled={locked}
                  onChange={(e) =>
                    patchClip({ title: e.target.value || 'Untitled clip' })
                  }
                />
              </label>
              <label>
                Clip track
                <select
                  aria-label="Clip track"
                  disabled={locked}
                  value={selectedTrack!.id}
                  onChange={(e) => {
                    const targetId = e.target.value;
                    mutate((next) => {
                      const old = next.tracks.find(
                          (t) => t.id === selectedTrack!.id,
                        )!,
                        target = next.tracks.find((t) => t.id === targetId)!;
                      old.clips = old.clips.filter((c) => c.id !== clip.id);
                      target.clips.push(clip);
                      setTrackId(targetId);
                    });
                  }}
                >
                  {draft.tracks.map((track) => (
                    <option key={track.id} value={track.id}>
                      {track.title}
                    </option>
                  ))}
                </select>
              </label>
              <div className="audio-field-grid">
                {number(
                  'Clip start (s)',
                  clip.start,
                  (n) => patchClip({ start: n }),
                  0,
                  draft.duration - clip.duration,
                )}
                {number(
                  'Source offset (s)',
                  clip.offset,
                  (n) => patchClip({ offset: n }),
                  0,
                  Math.max(
                    0,
                    (cache.current.get(clip.src)?.buffer.duration ?? 300) -
                      clip.duration,
                  ),
                )}
                {number(
                  'Clip duration (s)',
                  clip.duration,
                  (n) =>
                    patchClip({
                      duration: n,
                      fadeIn: Math.min(clip.fadeIn, n),
                      fadeOut: Math.min(clip.fadeOut, n),
                    }),
                  0.01,
                  Math.min(
                    draft.duration - clip.start,
                    (cache.current.get(clip.src)?.buffer.duration ?? 300) -
                      clip.offset,
                  ),
                )}
                {number(
                  'Clip gain (dB)',
                  clip.gainDb,
                  (n) => patchClip({ gainDb: n }),
                  -60,
                  12,
                  0.5,
                )}
                {number(
                  'Fade in (s)',
                  clip.fadeIn,
                  (n) => patchClip({ fadeIn: n }),
                  0,
                  clip.duration,
                )}
                {number(
                  'Fade out (s)',
                  clip.fadeOut,
                  (n) => patchClip({ fadeOut: n }),
                  0,
                  clip.duration,
                )}
              </div>
              <div className="audio-toolbar-group">
                <label className="audio-check">
                  <input
                    type="checkbox"
                    checked={clip.reverse}
                    disabled={locked}
                    onChange={(e) => patchClip({ reverse: e.target.checked })}
                  />
                  Reverse audio
                </label>
                <button disabled={locked} onClick={split}>
                  <Scissors size={14} />
                  Split at playhead
                </button>
                <button
                  aria-label="Delete audio clip"
                  disabled={locked}
                  onClick={() =>
                    mutate((next) => {
                      const track = next.tracks.find(
                        (t) => t.id === selectedTrack!.id,
                      )!;
                      track.clips = track.clips.filter((c) => c.id !== clip.id);
                      setSelected('');
                    })
                  }
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </>
          ) : (
            <p className="audio-hint">
              Select a clip to trim its source, move it, add fades or split it
              at the playhead.
            </p>
          )}
        </section>
        <section>
          <h3>
            Track mixer <span>{selectedTrack?.title ?? 'Master'}</span>
          </h3>
          {selectedTrack && (
            <>
              <label>
                Track name
                <input
                  aria-label="Track name"
                  value={selectedTrack.title}
                  maxLength={180}
                  disabled={locked}
                  onChange={(e) =>
                    patchTrack({ title: e.target.value || 'Untitled track' })
                  }
                />
              </label>
              <div className="audio-field-grid">
                {number(
                  'Track gain (dB)',
                  selectedTrack.gainDb,
                  (n) => patchTrack({ gainDb: n }),
                  -60,
                  12,
                  0.5,
                )}
                {number(
                  'Track pan',
                  selectedTrack.pan,
                  (n) => patchTrack({ pan: n }),
                  -1,
                  1,
                  0.1,
                )}
                {number(
                  'High-pass (Hz)',
                  selectedTrack.effects.highpassHz,
                  (n) =>
                    patchTrack({
                      effects: { ...selectedTrack.effects, highpassHz: n },
                    }),
                  10,
                  10000,
                  10,
                )}
                {number(
                  'Low-pass (Hz)',
                  selectedTrack.effects.lowpassHz,
                  (n) =>
                    patchTrack({
                      effects: { ...selectedTrack.effects, lowpassHz: n },
                    }),
                  100,
                  20000,
                  100,
                )}
              </div>
              <div className="audio-toolbar-group">
                <label className="audio-check">
                  <input
                    type="checkbox"
                    disabled={locked}
                    checked={selectedTrack.effects.compressor}
                    onChange={(e) =>
                      patchTrack({
                        effects: {
                          ...selectedTrack.effects,
                          compressor: e.target.checked,
                        },
                      })
                    }
                  />
                  Compressor · 4:1
                </label>
                <button
                  disabled={locked}
                  onClick={() =>
                    mutate((next) => {
                      next.tracks = next.tracks.filter(
                        (t) => t.id !== selectedTrack.id,
                      );
                      setSelected('');
                      setTrackId('');
                    })
                  }
                >
                  Remove track
                </button>
              </div>
            </>
          )}
          <div className="audio-field-grid">
            {number(
              'Project duration (s)',
              draft.duration,
              (n) =>
                mutate((next) => {
                  next.duration = n;
                  setTime((t) => Math.min(t, n));
                }),
              0.1,
              300,
              0.1,
            )}
            {number(
              'Master gain (dB)',
              draft.masterGainDb,
              (n) =>
                mutate((next) => {
                  next.masterGainDb = n;
                }),
              -60,
              12,
              0.5,
            )}
          </div>
        </section>
      </div>
      <section className="audio-export">
        <div>
          <h3>Export & project files</h3>
          <p>
            Mix the saved revision into stereo audio, or keep every source and
            edit in a portable project.
          </p>
        </div>
        <div className="audio-toolbar-group">
          <button disabled={busy} onClick={() => void exportProject()}>
            <Download size={14} />
            Audio project
          </button>
          <button
            disabled={locked}
            onClick={() => projectInput.current?.click()}
          >
            Import project
          </button>
          <label>
            Mix format
            <select
              aria-label="Audio export format"
              value={format}
              onChange={(e) => {
                setFormat(e.target.value);
                renderRequest.current = null;
              }}
            >
              {['wav', 'flac', 'mp3', 'm4a', 'ogg'].map((value) => (
                <option key={value} value={value}>
                  {value.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <button disabled={locked || dirty} onClick={() => void render()}>
            <Download size={14} />
            Render mix
          </button>
        </div>
        {dirty && (
          <span className="audio-hint">
            Save your edits to render this revision.
          </span>
        )}
        {jobs.map((job) => (
          <div className="audio-render-job" key={job.id}>
            <span>
              <strong>{job.format.toUpperCase()}</strong> · v
              {job.artifactVersion} · {job.status}
              {['queued', 'rendering'].includes(job.status)
                ? ` ${Math.round(job.progress * 100)}%`
                : ''}
            </span>
            {job.error && <span role="alert">{job.error}</span>}
            {job.downloadUrl && (
              <button
                onClick={() =>
                  void (async () => {
                    try {
                      const response = await fetch(job.downloadUrl!, {
                        credentials: 'same-origin',
                      });
                      if (!response.ok)
                        throw new Error(
                          'The mix download is no longer accessible.',
                        );
                      download(
                        `${artifact.title}-v${job.artifactVersion}.${job.format}`,
                        await response.blob(),
                        response.headers.get('content-type') ?? 'audio/wav',
                      );
                    } catch (e) {
                      fail(e);
                    }
                  })()
                }
              >
                Download {job.format.toUpperCase()}
              </button>
            )}
            {!readOnly && ['queued', 'rendering'].includes(job.status) && (
              <button
                onClick={() =>
                  void api(
                    `/artifacts/${artifact.id}/audio/renders/${job.id}`,
                    'DELETE',
                  ).catch(fail)
                }
              >
                Cancel render
              </button>
            )}
            {['completed', 'failed', 'cancelled'].includes(job.status) && (
              <button
                disabled={locked || dirty}
                onClick={() => {
                  renderRequest.current = null;
                  setFormat(job.format);
                  void render(job.format);
                }}
              >
                Render again
              </button>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
