import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import type { MidiContent } from '../../../shared/midi.ts';
import {
  barMarkers,
  moveMidiNote,
  pitchName,
  resizeMidiNote,
  snapBeat,
} from './model.ts';
const ROW = 19,
  KEYS = 64,
  HEADER = 28;
export function PianoRoll({
  content,
  trackId,
  selected,
  onSelect,
  onChange,
  onDraw,
  onAudition,
  beat,
  zoom,
  snap,
  locked,
  onViewport,
}: {
  content: MidiContent;
  trackId: string | null;
  selected: string | null;
  onSelect: (id: string, trackId: string) => void;
  onChange: (content: MidiContent, remember?: boolean) => void;
  onDraw: (beat: number, pitch: number) => void;
  onAudition: (pitch: number) => void;
  beat: number;
  zoom: number;
  snap: number;
  locked: boolean;
  onViewport?: (left: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null),
    drag = useRef<{
      pointerId: number;
      trackId: string;
      noteId: string;
      base: MidiContent;
      x: number;
      y: number;
      start: number;
      pitch: number;
      duration: number;
      resize: boolean;
      changed: boolean;
    } | null>(null),
    pattern = 'midi-grid-' + useId().replaceAll(':', '');
  const [viewport, setViewport] = useState({
    left: 0,
    top: 0,
    width: 700,
    height: 470,
  });
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = (127 - 76) * ROW;
    const resize = () =>
      setViewport({
        left: element.scrollLeft,
        top: element.scrollTop,
        width: element.clientWidth,
        height: element.clientHeight,
      });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (locked) drag.current = null;
  }, [locked]);
  const width = Math.max(1, content.lengthBeats * zoom),
    start = Math.max(0, (viewport.left - KEYS) / zoom - 2),
    end = (viewport.left + viewport.width) / zoom + 2,
    low = 127 - Math.ceil((viewport.top + viewport.height - HEADER) / ROW) - 1,
    high = 127 - Math.floor((viewport.top - HEADER) / ROW) + 1;
  const pointer = (event: {
    currentTarget: SVGSVGElement;
    clientX: number;
    clientY: number;
  }) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      beat: (event.clientX - bounds.left) / zoom,
      pitch: 127 - Math.floor((event.clientY - bounds.top) / ROW),
    };
  };
  const begin = (
    event: PointerEvent<SVGGElement | SVGRectElement>,
    trackId: string,
    noteId: string,
    resize = false,
  ) => {
    event.stopPropagation();
    onSelect(noteId, trackId);
    if (locked) return;
    const note = content.tracks
      .find((t) => t.id === trackId)!
      .notes.find((n) => n.id === noteId)!;
    drag.current = {
      pointerId: event.pointerId,
      trackId,
      noteId,
      base: content,
      x: event.clientX,
      y: event.clientY,
      start: note.start,
      pitch: note.pitch,
      duration: note.duration,
      resize,
      changed: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  return (
    <div
      className="midi-roll-scroll"
      ref={scroller}
      onScroll={(event) => {
        const e = event.currentTarget;
        onViewport?.(e.scrollLeft);
        setViewport({
          left: e.scrollLeft,
          top: e.scrollTop,
          width: e.clientWidth,
          height: e.clientHeight,
        });
      }}
      aria-label="Scrollable piano roll"
    >
      <div
        className="midi-roll-inner"
        style={{ width: width + KEYS, height: 128 * ROW + HEADER }}
      >
        <div className="midi-ruler">
          <svg width={width + KEYS} height={HEADER} aria-hidden="true">
            <rect width="100%" height="100%" fill="#282733" />
            {barMarkers(content)
              .filter((mark) => mark.beat >= start - 8 && mark.beat <= end)
              .map((mark) => (
                <g key={mark.beat}>
                  <line
                    x1={KEYS + mark.beat * zoom}
                    y1="14"
                    x2={KEYS + mark.beat * zoom}
                    y2="28"
                    stroke="#88839a"
                  />
                  <text
                    x={KEYS + mark.beat * zoom + 6}
                    y="17"
                    fill="#c5c0d7"
                    fontSize="11"
                  >
                    {mark.bar} <tspan opacity=".55">{mark.meter}</tspan>
                  </text>
                </g>
              ))}
            <line
              x1={KEYS + beat * zoom}
              x2={KEYS + beat * zoom}
              y1="0"
              y2="28"
              stroke="#f5ca84"
              strokeWidth="2"
            />
          </svg>
        </div>
        <div className="midi-piano">
          {Array.from({ length: 128 }, (_, i) => 127 - i).map((pitch) => (
            <button
              key={pitch}
              className={[1, 3, 6, 8, 10].includes(pitch % 12) ? 'black' : ''}
              style={{ height: ROW }}
              aria-label={'Audition ' + pitchName(pitch)}
              onClick={() => onAudition(pitch)}
            >
              <span>{pitchName(pitch)}</span>
            </button>
          ))}
        </div>
        <svg
          className="midi-grid"
          width={width}
          height={128 * ROW}
          role="application"
          aria-label="MIDI piano roll"
          tabIndex={0}
          onDoubleClick={(event) => {
            if (locked || !trackId) return;
            const point = pointer(event);
            onDraw(
              Math.max(
                0,
                Math.min(
                  content.lengthBeats - snap,
                  snapBeat(point.beat, snap),
                ),
              ),
              Math.max(0, Math.min(127, point.pitch)),
            );
          }}
          onPointerMove={(event) => {
            const state = drag.current;
            if (!state || locked || state.pointerId !== event.pointerId) return;
            const delta = snapBeat((event.clientX - state.x) / zoom, snap),
              pitch = state.pitch - Math.round((event.clientY - state.y) / ROW);
            if (!delta && pitch === state.pitch && !state.changed) return;
            const next = state.resize
              ? resizeMidiNote(
                  state.base,
                  state.trackId,
                  state.noteId,
                  Math.max(snap, state.duration + delta),
                )
              : moveMidiNote(
                  state.base,
                  state.trackId,
                  state.noteId,
                  state.start + delta,
                  pitch,
                );
            onChange(next, !state.changed);
            state.changed = true;
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          <defs>
            <pattern
              id={pattern}
              width={zoom}
              height={ROW}
              patternUnits="userSpaceOnUse"
            >
              <rect width={zoom} height={ROW} fill="#211f2a" />
              <path
                d={`M ${zoom} 0 L 0 0 0 ${ROW}`}
                fill="none"
                stroke="#3a3547"
                strokeWidth="1"
              />
              {[0.25, 0.5, 0.75].map((value) => (
                <line
                  key={value}
                  x1={zoom * value}
                  x2={zoom * value}
                  y1="0"
                  y2={ROW}
                  stroke="#2d2938"
                />
              ))}
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#${pattern})`} />
          {Array.from({ length: 128 }, (_, i) => 127 - i)
            .filter((p) => [1, 3, 6, 8, 10].includes(p % 12))
            .map((pitch) => (
              <rect
                key={pitch}
                x="0"
                y={(127 - pitch) * ROW}
                width="100%"
                height={ROW}
                fill="#000"
                opacity=".15"
              />
            ))}
          {content.tracks.flatMap((track, index) =>
            track.notes
              .filter(
                (note) =>
                  note.start + note.duration >= start &&
                  note.start <= end &&
                  note.pitch >= low &&
                  note.pitch <= high,
              )
              .map((note) => (
                <g
                  role="button"
                  tabIndex={track.id === trackId ? 0 : -1}
                  aria-label={`${track.title}: ${pitchName(note.pitch)}, beat ${Number(note.start.toFixed(3))}, velocity ${note.velocity}`}
                  key={note.id}
                  className={`midi-note ${note.id === selected ? 'selected' : ''} ${track.id === trackId ? 'active-track' : 'other-track'}`}
                  style={
                    {
                      '--note-color': [
                        '#a58cff',
                        '#6bd8c4',
                        '#ffab95',
                        '#edca79',
                        '#8dc3ff',
                      ][index % 5],
                    } as React.CSSProperties
                  }
                  onPointerDown={(event) => begin(event, track.id, note.id)}
                  onFocus={() => onSelect(note.id, track.id)}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <rect
                    x={note.start * zoom + 1}
                    y={(127 - note.pitch) * ROW + 2}
                    width={Math.max(5, note.duration * zoom - 2)}
                    height={ROW - 4}
                    rx="3"
                  />
                  <rect
                    className="midi-note-velocity"
                    x={note.start * zoom + 2}
                    y={(127 - note.pitch) * ROW + ROW - 5}
                    width={Math.max(
                      2,
                      ((note.duration * zoom - 4) * note.velocity) / 127,
                    )}
                    height="2"
                  />
                  {note.duration * zoom > 45 && (
                    <text
                      x={note.start * zoom + 5}
                      y={(127 - note.pitch) * ROW + 13}
                      fontSize="10"
                    >
                      {pitchName(note.pitch)}
                    </text>
                  )}
                  <rect
                    className="midi-note-handle"
                    x={(note.start + note.duration) * zoom - 7}
                    y={(127 - note.pitch) * ROW + 2}
                    width="6"
                    height={ROW - 4}
                    onPointerDown={(event) =>
                      begin(event, track.id, note.id, true)
                    }
                  />
                </g>
              )),
          )}
          <line
            x1={beat * zoom}
            x2={beat * zoom}
            y1="0"
            y2="100%"
            stroke="#f5ca84"
            strokeWidth="2"
            pointerEvents="none"
          />
        </svg>
      </div>
    </div>
  );
}
