import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import {
  Music2,
  Plus,
  Play,
  Pause,
  SkipBack,
  Save,
  Download,
  Upload,
  Undo2,
  Redo2,
  Trash2,
  Copy,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { MediaProps } from '../App.tsx';
import {
  Button,
  IconButton,
  Input,
  Select,
  Field,
  Badge,
} from '../components/ui.tsx';
import { api, download, ApiError } from '../lib.ts';
import {
  midiContentSchema,
  beatSeconds,
  secondsBeat,
  type MidiContent,
  type MidiTrack,
  type MidiNote,
} from '../../shared/midi.ts';
import {
  MAX_MIDI_FILE_BYTES,
  parseMidiFile,
  writeMidiFile,
} from '../../shared/midi-file.ts';
import {
  gmPrograms,
  newMidiNote,
  newMidiTrack,
  pitchName,
  snapBeat,
} from './midi/model.ts';
import {
  MidiTransport,
  bounceMidiWav,
  MAX_SYNTH_BOUNCE_SECONDS,
} from './midi/synth.ts';
import { PianoRoll } from './midi/PianoRoll.tsx';
import { MidiNumberField } from './midi/NumberField.tsx';
import './midi/editor.css';
const serialized = (content: MidiContent) => JSON.stringify(content),
  safeName = (title: string) =>
    title.replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 100) || 'composition';
export function MidiEditor({
  artifact,
  readOnly,
  onSave,
  onDirty,
  onError,
}: MediaProps) {
  const [draft, setDraft] = useState(() =>
      midiContentSchema.parse(artifact.content),
    ),
    [saved, setSaved] = useState(() =>
      serialized(midiContentSchema.parse(artifact.content)),
    ),
    [version, setVersion] = useState(artifact.version),
    [conflict, setConflict] = useState(false),
    [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [playing, setPlaying] = useState(false),
    [starting, setStarting] = useState(false),
    [seconds, setSeconds] = useState(0),
    [selectedTrack, setSelectedTrack] = useState<string | null>(null),
    [selectedNote, setSelectedNote] = useState<string | null>(null),
    [past, setPast] = useState<MidiContent[]>([]),
    [future, setFuture] = useState<MidiContent[]>([]),
    [zoom, setZoom] = useState(60),
    [snap, setSnap] = useState(0.25),
    [notice, setNotice] = useState(''),
    [rollLeft, setRollLeft] = useState(0);
  const transport = useRef(new MidiTransport()),
    current = useRef(draft),
    savedRef = useRef(saved),
    source = useRef<{ src: string; bytes: Uint8Array } | null>(null),
    importInput = useRef<HTMLInputElement>(null),
    mounted = useRef(true);
  current.current = draft;
  savedRef.current = saved;
  const requiredLength=Math.max(1,...draft.tempo.map(t=>t.beat),...draft.timeSignatures.map(t=>t.beat),...draft.meta.map(e=>e.tick/draft.ppq),...draft.tracks.flatMap(t=>[...t.notes.map(n=>n.start+n.duration),...t.events.map(e=>e.tick/draft.ppq)]));
  const dirty = serialized(draft) !== saved,
    locked = readOnly || conflict || busy || saving,
    track = draft.tracks.find((t) => t.id === selectedTrack) ?? draft.tracks[0],
    note = track?.notes.find((n) => n.id === selectedNote),
    duration = beatSeconds(draft, draft.lengthBeats),
    beat = secondsBeat(draft, seconds),
    totalNotes = draft.tracks.reduce((sum, t) => sum + t.notes.length, 0);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void transport.current.close();
      onDirty(false);
    };
  }, [onDirty]);
  useEffect(() => {
    if (artifact.version <= version) return;
    const incoming = midiContentSchema.parse(artifact.content),
      value = serialized(incoming);
    if (
      serialized(current.current) !== savedRef.current &&
      value !== serialized(current.current)
    ) {
      setConflict(true);
      transport.current.stop();
      setPlaying(false);
      return;
    }
    setDraft(incoming);
    setSaved(value);
    setVersion(artifact.version);
    setConflict(false);
  }, [artifact, version]);
  const report = (error: unknown) =>
    onError(error instanceof Error ? error.message : String(error));
  function change(next: MidiContent, remember = true) {
    if (locked) return;
    try {
      const valid = midiContentSchema.parse(next);
      if (serialized(valid) === serialized(current.current)) return;
      transport.current.stop();
      setPlaying(false);
      if (remember) {
        setPast((items) => [
          ...items.slice(-49),
          structuredClone(current.current),
        ]);
        setFuture([]);
      }
      current.current = valid;
      setDraft(valid);
      setNotice('');
    } catch (error) {
      report(error);
    }
  }
  function updateTrack(update: Partial<MidiTrack>) {
    if (!track) return;
    change({
      ...draft,
      tracks: draft.tracks.map((t) =>
        t.id === track.id ? { ...t, ...update } : t,
      ),
    });
  }
  function updateNote(update: Partial<MidiNote>) {
    if (!track || !note) return;
    updateTrack({
      notes: track.notes.map((n) =>
        n.id === note.id ? { ...n, ...update } : n,
      ),
    });
  }
  function addTrack() {
    const track = newMidiTrack(draft);
    change({ ...draft, tracks: [...draft.tracks, track] });
    setSelectedTrack(track.id);
    setSelectedNote(null);
  }
  function addNote(start = snapBeat(beat, snap), pitch = 60) {
    if (!track || locked) return;
    const added = newMidiNote(
      draft,
      Math.max(0, Math.min(draft.lengthBeats - snap, start)),
      pitch,
      Math.min(1, snap * 4),
    );
    updateTrack({ notes: [...track.notes, added] });
    setSelectedNote(added.id);
    setSelectedTrack(track.id);
  }
  function removeNote() {
    if (!note || !track) return;
    updateTrack({ notes: track.notes.filter((n) => n.id !== note.id) });
    setSelectedNote(null);
  }
  function duplicate() {
    if (!note || !track) return;
    const copied = {
      ...note,
      id: crypto.randomUUID(),
      start: Math.min(draft.lengthBeats - note.duration, note.start + snap),
    };
    updateTrack({ notes: [...track.notes, copied] });
    setSelectedNote(copied.id);
  }
  function history(direction: 'undo' | 'redo') {
    if (locked) return;
    const from = direction === 'undo' ? past : future,
      next = from.at(-1);
    if (!next) return;
    transport.current.stop();
    setPlaying(false);
    if (direction === 'undo') {
      setPast(past.slice(0, -1));
      setFuture([...future, structuredClone(draft)]);
    } else {
      setFuture(future.slice(0, -1));
      setPast([...past, structuredClone(draft)]);
    }
    current.current = next;
    setDraft(next);
    setSelectedNote(null);
  }
  function key(event: KeyboardEvent) {
    if (
      locked ||
      (event.target instanceof HTMLElement &&
        (event.target.matches('input,textarea,select') ||
          event.target.isContentEditable))
    )
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      history(event.shiftKey ? 'redo' : 'undo');
    } else if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'd' &&
      note
    ) {
      event.preventDefault();
      duplicate();
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && note) {
      event.preventDefault();
      removeNote();
    } else if (
      note &&
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    ) {
      event.preventDefault();
      updateNote(
        event.key === 'ArrowUp'
          ? { pitch: Math.min(127, note.pitch + 1) }
          : event.key === 'ArrowDown'
            ? { pitch: Math.max(0, note.pitch - 1) }
            : {
                start: Math.max(
                  0,
                  Math.min(
                    draft.lengthBeats - note.duration,
                    note.start + (event.key === 'ArrowLeft' ? -snap : snap),
                  ),
                ),
              },
      );
    }
  }
  async function play(at = seconds) {
    if (playing || starting) {
      transport.current.stop();
      setPlaying(false);
      setStarting(false);
      return;
    }
    setStarting(true);
    try {
      const started = await transport.current.play(
        current.current,
        at >= duration ? 0 : at,
        (value) => {
          if (mounted.current) setSeconds(value);
        },
        () => {
          if (mounted.current) setPlaying(false);
        },
      );
      if (started && mounted.current) setPlaying(true);
    } catch (error) {
      report(error);
    } finally {
      if (mounted.current) setStarting(false);
    }
  }
  function seek(beat: number) {
    transport.current.stop();
    setPlaying(false);
    setStarting(false);
    setSeconds(
      beatSeconds(draft, Math.max(0, Math.min(draft.lengthBeats, beat))),
    );
  }
  async function original() {
    if (!draft.sourceSrc) return undefined;
    if (source.current?.src === draft.sourceSrc) return source.current.bytes;
    const response = await fetch(draft.sourceSrc, {
      credentials: 'same-origin',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(
        'The original MIDI source is unavailable. Restore project access before exporting.',
      );
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_MIDI_FILE_BYTES)
      throw new Error('The original MIDI source exceeds 10 MiB');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The MIDI source returned no data');
    const chunks: Uint8Array[] = [];
    let count = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        count += part.value.byteLength;
        if (count > MAX_MIDI_FILE_BYTES)
          throw new Error('The original MIDI source exceeds 10 MiB');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    parseMidiFile(bytes);
    source.current = { src: draft.sourceSrc, bytes };
    return bytes;
  }
  async function exportMidi() {
    setBusy(true);
    try {
      const bytes = writeMidiFile(current.current, {
        original: await original(),
      });
      download(
        safeName(artifact.title) + '.mid',
        bytes.slice().buffer as ArrayBuffer,
        'audio/midi',
      );
      setNotice(
        'MIDI exported. Unchanged imports retain their exact original bytes.',
      );
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  async function bounce() {
    setBusy(true);
    transport.current.stop();
    setPlaying(false);
    try {
      const bytes = await bounceMidiWav(current.current);
      download(
        safeName(artifact.title) + '-synth.wav',
        bytes.buffer as ArrayBuffer,
        'audio/wav',
      );
      setNotice(
        'Oscillator synth WAV rendered locally. MIDI instrument samples and system-exclusive programs are not included.',
      );
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  async function importMidi(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || locked) return;
    setBusy(true);
    try {
      if (file.size > MAX_MIDI_FILE_BYTES)
        throw new Error('Choose a Standard MIDI File of at most 10 MiB');
      const bytes = new Uint8Array(await file.arrayBuffer()),
        parsed = parseMidiFile(bytes),
        form = new FormData();
      form.append('file', file);
      const uploaded = await api<{ url: string }>(
        `/artifacts/${artifact.id}/files`,
        'POST',
        form,
      );
      if (!mounted.current) return;
      const next = { ...parsed, sourceSrc: uploaded.url };
      setPast((items) => [
        ...items.slice(-49),
        structuredClone(current.current),
      ]);
      setFuture([]);
      source.current = { src: uploaded.url, bytes };
      transport.current.stop();
      setPlaying(false);
      current.current = next;
      setDraft(next);
      setSelectedTrack(parsed.tracks[0]?.id ?? null);
      setSelectedNote(null);
      setSeconds(0);
      setNotice(
        'Imported ' +
          file.name +
          '. Notes, tempo, meter, controllers, and system events are retained. Save this artifact to persist the import.',
      );
    } catch (error) {
      report(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function save() {
    if (locked) return;
    setSaving(true);
    try {
      const content = midiContentSchema.parse(current.current);
      await onSave(content, version);
      setSaved(serialized(content));
      setVersion(version + 1);
      setNotice('MIDI arrangement saved.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      report(error);
    } finally {
      setSaving(false);
    }
  }
  function tempo(index: number, value: Partial<MidiContent['tempo'][number]>) {
    change({
      ...draft,
      tempo: draft.tempo
        .map((entry, i) => (i === index ? { ...entry, ...value } : entry))
        .sort((a, b) => a.beat - b.beat),
    });
  }
  function meter(
    index: number,
    value: Partial<MidiContent['timeSignatures'][number]>,
  ) {
    change({
      ...draft,
      timeSignatures: draft.timeSignatures
        .map((entry, i) => (i === index ? { ...entry, ...value } : entry))
        .sort((a, b) => a.beat - b.beat),
    });
  }
  const number = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    update: (value: number) => void,
    disabled = locked,
  ) => (
    <MidiNumberField
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={update}
    />
  );

  return (
    <section
      className="midi-editor"
      aria-label="MIDI composition editor"
      onKeyDown={key}
    >
      <header className="midi-toolbar">
        <div className="midi-heading">
          <Music2 />
          <div>
            <strong>Note studio</strong>
            <small>
              {draft.tracks.length} tracks · {totalNotes} notes ·{' '}
              {duration.toFixed(2)} seconds
            </small>
          </div>
          <Badge>{readOnly ? 'View only' : 'MIDI ' + draft.format}</Badge>
        </div>
        <div className="midi-toolbar-actions">
          <IconButton
            label="Undo MIDI edit"
            disabled={locked || !past.length}
            onClick={() => history('undo')}
          >
            <Undo2 />
          </IconButton>
          <IconButton
            label="Redo MIDI edit"
            disabled={locked || !future.length}
            onClick={() => history('redo')}
          >
            <Redo2 />
          </IconButton>
          <Button
            variant="outline"
            disabled={locked}
            onClick={() => importInput.current?.click()}
          >
            <Upload />
            Import MIDI
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void exportMidi()}
          >
            <Download />
            Export MIDI
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void bounce()}
          >
            <Download />
            Bounce synth WAV
          </Button>
          <Button disabled={locked || !dirty} onClick={() => void save()}>
            <Save />
            {saving ? 'Saving…' : 'Save MIDI'}
          </Button>
        </div>
        <input
          hidden
          ref={importInput}
          type="file"
          accept=".mid,.midi,audio/midi,audio/x-midi"
          aria-label="Import Standard MIDI File"
          disabled={locked}
          onChange={(event) => void importMidi(event)}
        />
      </header>
      {conflict && (
        <div className="midi-conflict" role="alert">
          <p>
            A collaborator saved a newer version. Your local notes and imported
            source remain in this draft. Export them before loading the latest
            arrangement.
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void exportMidi()}
          >
            Export draft MIDI
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              transport.current.stop();
              setPlaying(false);
              const incoming = midiContentSchema.parse(artifact.content);
              current.current = incoming;
              setDraft(incoming);
              setSaved(serialized(incoming));
              setVersion(artifact.version);
              setPast([]);
              setFuture([]);
              setConflict(false);
              setSeconds(0);
              setSelectedNote(null);
            }}
          >
            Load latest MIDI
          </Button>
        </div>
      )}
      {notice && (
        <p className="midi-notice" role="status">
          {notice}
        </p>
      )}
      <div className="midi-transport">
        <IconButton
          label="Return MIDI transport to start"
          onClick={() => seek(0)}
        >
          <SkipBack />
        </IconButton>
        <Button
          variant="secondary"
          disabled={starting || busy}
          onClick={() => void play()}
        >
          {playing ? <Pause /> : <Play />}
          {starting ? 'Starting audio…' : playing ? 'Pause MIDI' : 'Play MIDI'}
        </Button>
        <output aria-label="MIDI playhead">
          {seconds.toFixed(2)}s <span>· Beat {beat.toFixed(2)}</span>
        </output>
        <input
          aria-label="MIDI seek beat"
          type="range"
          min="0"
          max={draft.lengthBeats}
          step="0.01"
          value={beat}
          onChange={(event) => seek(Number(event.currentTarget.value))}
        />
        <label>
          Snap
          <Select
            aria-label="MIDI grid snap"
            value={snap}
            onChange={(event) => setSnap(Number(event.currentTarget.value))}
          >
            {[1, 0.5, 0.25, 0.125, 0.0625].map((value) => (
              <option value={value} key={value}>
                {value === 1 ? '1 beat' : '1/' + 1 / value + ' beat'}
              </option>
            ))}
          </Select>
        </label>
        <label>
          Zoom
          <input
            aria-label="MIDI piano roll zoom"
            type="range"
            min="20"
            max="120"
            value={zoom}
            onChange={(event) => setZoom(Number(event.currentTarget.value))}
          />
        </label>
      </div>
      <div className="midi-workspace">
        <aside className="midi-tracks" aria-label="MIDI tracks">
          <header>
            <strong>Instruments</strong>
            <IconButton
              label="Add MIDI track"
              disabled={locked || draft.tracks.length >= 32}
              onClick={addTrack}
            >
              <Plus />
            </IconButton>
          </header>
          {draft.tracks.map((item, index) => (
            <div
              key={item.id}
              className={
                track?.id === item.id ? 'midi-track selected' : 'midi-track'
              }
            >
              <button
                className="midi-track-select"
                onClick={() => {
                  setSelectedTrack(item.id);
                  setSelectedNote(null);
                }}
              >
                <i
                  style={{
                    background: [
                      '#a58cff',
                      '#6bd8c4',
                      '#ffab95',
                      '#edca79',
                      '#8dc3ff',
                    ][index % 5],
                  }}
                />
                <strong>{item.title}</strong>
                <small>
                  {item.channel === 9
                    ? 'Percussion'
                    : 'Ch ' + (item.channel + 1)}{' '}
                  · {item.notes.length} notes
                </small>
              </button>
              <div>
                <IconButton
                  label={(item.mute ? 'Unmute ' : 'Mute ') + item.title}
                  disabled={locked}
                  onClick={() =>
                    change({
                      ...draft,
                      tracks: draft.tracks.map((t) =>
                        t.id === item.id ? { ...t, mute: !t.mute } : t,
                      ),
                    })
                  }
                >
                  {item.mute ? <VolumeX /> : <Volume2 />}
                </IconButton>
                <button
                  className={item.solo ? 'midi-solo active' : 'midi-solo'}
                  aria-label={'Solo ' + item.title}
                  aria-pressed={item.solo}
                  disabled={locked}
                  onClick={() =>
                    change({
                      ...draft,
                      tracks: draft.tracks.map((t) =>
                        t.id === item.id ? { ...t, solo: !t.solo } : t,
                      ),
                    })
                  }
                >
                  S
                </button>
              </div>
            </div>
          ))}
          {!draft.tracks.length && (
            <div className="midi-empty">
              <p>
                Add an instrument track, then draw notes or import a MIDI file.
              </p>
              <Button disabled={locked} onClick={addTrack}>
                <Plus />
                Add instrument
              </Button>
            </div>
          )}
        </aside>
        <main className="midi-score">
          <div className="midi-score-tools">
            <span>
              {track?.title ?? 'Piano roll'}{' '}
              <small>
                Double-click to draw · drag to move · right edge to resize
              </small>
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={locked || !track}
              onClick={() => addNote()}
            >
              <Plus />
              Add note
            </Button>
          </div>
          <PianoRoll
            content={draft}
            trackId={track?.id ?? null}
            selected={selectedNote}
            onSelect={(id, trackId) => {
              setSelectedNote(id);
              setSelectedTrack(trackId);
            }}
            onChange={change}
            onDraw={addNote}
            onAudition={(pitch) =>
              void transport.current
                .audition(pitch, track?.instrument ?? 0, track?.channel ?? 0)
                .catch(report)
            }
            beat={beat}
            zoom={zoom}
            snap={snap}
            locked={locked}
            onViewport={setRollLeft}
          />
          <div className="midi-velocity-lane" aria-label="Note velocity lane">
            {track?.notes
              .filter(
                (n) =>
                  n.start * zoom - rollLeft > -64 &&
                  n.start * zoom - rollLeft < 2000,
              )
              .map((n) => (
                <button
                  key={n.id}
                  aria-label={
                    'Velocity ' + n.velocity + ' for ' + pitchName(n.pitch)
                  }
                  onClick={() => setSelectedNote(n.id)}
                  style={{
                    left: n.start * zoom + 64 - rollLeft,
                    height: (n.velocity / 127) * 36,
                    bottom: 0,
                  }}
                  className={n.id === selectedNote ? 'selected' : ''}
                />
              ))}
            <span>VELOCITY</span>
          </div>
        </main>
        <aside className="midi-inspector" aria-label="MIDI inspector">
          <details open>
            <summary>Selected note</summary>
            {note ? (
              <>
                <div className="midi-note-title">
                  <strong>{pitchName(note.pitch)}</strong>
                  <IconButton
                    label="Duplicate MIDI note"
                    disabled={locked}
                    onClick={duplicate}
                  >
                    <Copy />
                  </IconButton>
                  <IconButton
                    label="Delete MIDI note"
                    disabled={locked}
                    onClick={removeNote}
                  >
                    <Trash2 />
                  </IconButton>
                </div>
                {number('Note pitch (MIDI)', note.pitch, 0, 127, 1, (pitch) =>
                  updateNote({ pitch: Math.round(pitch) }),
                )}
                {number(
                  'Note start (beats)',
                  note.start,
                  0,
                  draft.lengthBeats - note.duration,
                  snap,
                  (start) => updateNote({ start }),
                )}
                {number(
                  'Note duration (beats)',
                  note.duration,
                  1 / draft.ppq,
                  draft.lengthBeats - note.start,
                  snap,
                  (duration) => updateNote({ duration }),
                )}
                {number('Note velocity', note.velocity, 1, 127, 1, (velocity) =>
                  updateNote({ velocity: Math.round(velocity) }),
                )}
              </>
            ) : (
              <p>
                Select a note in the piano roll to edit its pitch, timing, and
                velocity.
              </p>
            )}
          </details>
          {track && (
            <details open>
              <summary>Instrument track</summary>
              <Field label="Track name">
                <Input
                  aria-label="MIDI track name"
                  value={track.title}
                  maxLength={180}
                  disabled={locked}
                  onChange={(event) =>
                    updateTrack({
                      title: event.currentTarget.value || 'Instrument',
                    })
                  }
                />
              </Field>
              <Field label="General MIDI program">
                <Select
                  aria-label="MIDI track program"
                  value={track.instrument}
                  disabled={locked}
                  onChange={(event) =>
                    updateTrack({
                      instrument: Number(event.currentTarget.value),
                    })
                  }
                >
                  {gmPrograms.map((name, index) => (
                    <option value={index} key={index}>
                      {index + 1} · {name}
                    </option>
                  ))}
                </Select>
              </Field>
              {number(
                'MIDI track channel',
                track.channel + 1,
                1,
                16,
                1,
                (value) => updateTrack({ channel: Math.round(value) - 1 }),
              )}
              {number(
                'MIDI track gain (dB)',
                track.gainDb,
                -60,
                12,
                0.5,
                (gainDb) => updateTrack({ gainDb }),
              )}
              <Button
                variant="ghost"
                disabled={locked}
                onClick={() => {
                  change({
                    ...draft,
                    tracks: draft.tracks.filter((t) => t.id !== track.id),
                  });
                  setSelectedTrack(null);
                  setSelectedNote(null);
                }}
              >
                <Trash2 />
                Remove track
              </Button>
              <Button
                variant="outline"
                disabled={locked || !track.notes.length}
                onClick={() =>
                  updateTrack({
                    notes: track.notes.map((note) => ({
                      ...note,
                      start: Math.max(
                        0,
                        Math.min(
                          draft.lengthBeats - note.duration,
                          snapBeat(note.start, snap),
                        ),
                      ),
                    })),
                  })
                }
              >
                Quantize track starts
              </Button>
            </details>
          )}
          <details open>
            <summary>Composition</summary>
            {number(
              'Composition length (beats)',
              draft.lengthBeats,
              requiredLength,
              4096,
              1,
              (lengthBeats) => change({ ...draft, lengthBeats }),
            )}
            <Field label="MIDI file format">
              <Select
                aria-label="MIDI file format"
                value={draft.format}
                disabled={locked}
                onChange={(event) =>
                  change({
                    ...draft,
                    format: Number(event.currentTarget.value) as 0 | 1,
                  })
                }
              >
                <option value="0">SMF 0 · single track</option>
                <option value="1">SMF 1 · multitrack</option>
              </Select>
            </Field>
            {number('MIDI ticks per beat', draft.ppq, 24, 9600, 1, (ppq) => {
              const ratio = Math.round(ppq) / draft.ppq;
              change({
                ...draft,
                ppq: Math.round(ppq),
                meta: draft.meta.map((e) => ({
                  ...e,
                  tick: Math.round(e.tick * ratio),
                })),
                tracks: draft.tracks.map((t) => ({
                  ...t,
                  events: t.events.map((e) => ({
                    ...e,
                    tick: Math.round(e.tick * ratio),
                  })),
                })),
              });
            })}
          </details>
          <details>
            <summary>Tempo map</summary>
            {draft.tempo.map((entry, index) => (
              <div className="midi-map-entry" key={index}>
                {number(
                  'Tempo change ' + (index + 1) + ' beat',
                  entry.beat,
                  0,
                  draft.lengthBeats,
                  0.25,
                  (value) => tempo(index, { beat: value }),
                  locked || index === 0,
                )}
                {number(
                  'Tempo change ' + (index + 1) + ' BPM',
                  entry.bpm,
                  10,
                  500,
                  1,
                  (bpm) => tempo(index, { bpm }),
                )}
                {index > 0 && (
                  <Button
                    variant="ghost"
                    disabled={locked}
                    onClick={() =>
                      change({
                        ...draft,
                        tempo: draft.tempo.filter((_, i) => i !== index),
                      })
                    }
                  >
                    Remove tempo
                  </Button>
                )}
              </div>
            ))}
            <Button
              variant="outline"
              disabled={locked || draft.tempo.length >= 256}
              onClick={() => {
                const position = snapBeat(beat, snap);
                if (draft.tempo.some((t) => t.beat === position)) {
                  report(
                    new Error('A tempo change already exists at this beat'),
                  );
                  return;
                }
                change({
                  ...draft,
                  tempo: [...draft.tempo, { beat: position, bpm: 120 }].sort(
                    (a, b) => a.beat - b.beat,
                  ),
                });
              }}
            >
              Add tempo at playhead
            </Button>
          </details>
          <details>
            <summary>Time signatures</summary>
            {draft.timeSignatures.map((entry, index) => (
              <div className="midi-map-entry" key={index}>
                {number(
                  'Meter change ' + (index + 1) + ' beat',
                  entry.beat,
                  0,
                  draft.lengthBeats,
                  0.25,
                  (value) => meter(index, { beat: value }),
                  locked || index === 0,
                )}
                {number(
                  'Meter change ' + (index + 1) + ' numerator',
                  entry.numerator,
                  1,
                  32,
                  1,
                  (value) => meter(index, { numerator: Math.round(value) }),
                )}
                <Field label={'Meter change ' + (index + 1) + ' denominator'}>
                  <Select
                    aria-label={'Meter change ' + (index + 1) + ' denominator'}
                    disabled={locked}
                    value={entry.denominator}
                    onChange={(event) =>
                      meter(index, {
                        denominator: Number(event.currentTarget.value) as
                          | 1
                          | 2
                          | 4
                          | 8
                          | 16
                          | 32,
                      })
                    }
                  >
                    {[1, 2, 4, 8, 16, 32].map((value) => (
                      <option value={value} key={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                </Field>
                {index > 0 && (
                  <Button
                    variant="ghost"
                    disabled={locked}
                    onClick={() =>
                      change({
                        ...draft,
                        timeSignatures: draft.timeSignatures.filter(
                          (_, i) => i !== index,
                        ),
                      })
                    }
                  >
                    Remove meter
                  </Button>
                )}
              </div>
            ))}
            <Button
              variant="outline"
              disabled={locked || draft.timeSignatures.length >= 128}
              onClick={() => {
                const position = snapBeat(beat, snap);
                if (draft.timeSignatures.some((t) => t.beat === position)) {
                  report(
                    new Error('A time signature already exists at this beat'),
                  );
                  return;
                }
                change({
                  ...draft,
                  timeSignatures: [
                    ...draft.timeSignatures,
                    { beat: position, numerator: 4, denominator: 4 as const },
                  ].sort((a, b) => a.beat - b.beat),
                });
              }}
            >
              Add meter at playhead
            </Button>
          </details>
        </aside>
      </div>
      <footer className="midi-footer">
        <span>
          Oscillator audition · not sampled General MIDI instruments. Synth
          bounce ≤ {MAX_SYNTH_BOUNCE_SECONDS}s, 64 voices.
        </span>
        <span>
          {draft.meta.length +
            draft.tracks.reduce((sum, t) => sum + t.events.length, 0)}{' '}
          preserved controller/meta/system events
        </span>
        {new Set(draft.tracks.map((t) => t.channel)).size <
          draft.tracks.length && (
          <span>
            Shared channels: MIDI instruments/controllers apply to the same
            channel; synth audition treats tracks separately.
          </span>
        )}
      </footer>
    </section>
  );
}
export default MidiEditor;
