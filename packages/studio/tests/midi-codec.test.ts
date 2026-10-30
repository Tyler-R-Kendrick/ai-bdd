import { describe, it, expect } from 'vitest';
import { parseMidi, writeMidi, type MidiData } from 'midi-file';
import { parseMidiFile, writeMidiFile } from '../shared/midi-file.ts';
import {
  beatSeconds,
  secondsBeat,
  initialMidiContent,
} from '../shared/midi.ts';
function source(format: 0 | 1 = 1) {
  const notes: MidiData['tracks'][number] = [
    { deltaTime: 0, type: 'trackName', text: 'Piano fixture' },
    { deltaTime: 0, type: 'programChange', channel: 0, programNumber: 4 },
    {
      deltaTime: 0,
      type: 'controller',
      channel: 0,
      controllerType: 64,
      value: 127,
    },
    { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
    {
      deltaTime: 240,
      type: 'noteOn',
      channel: 0,
      noteNumber: 64,
      velocity: 80,
    },
    {
      deltaTime: 240,
      type: 'noteOff',
      channel: 0,
      noteNumber: 60,
      velocity: 12,
    },
    {
      deltaTime: 240,
      type: 'noteOff',
      channel: 0,
      noteNumber: 64,
      velocity: 0,
    },
    {
      deltaTime: 0,
      type: 'controller',
      channel: 0,
      controllerType: 64,
      value: 0,
    },
    { deltaTime: 0, type: 'pitchBend', channel: 0, value: 100 },
    { deltaTime: 0, type: 'endOfTrack' },
  ];
  const conductor: MidiData['tracks'][number] = [
    { deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 },
    {
      deltaTime: 0,
      type: 'timeSignature',
      numerator: 7,
      denominator: 8,
      metronome: 24,
      thirtyseconds: 8,
    },
    { deltaTime: 960, type: 'setTempo', microsecondsPerBeat: 666667 },
    { deltaTime: 0, type: 'sequencerSpecific', data: [1, 2, 3] },
    { deltaTime: 0, type: 'sysEx', data: [0x7e, 0x7f, 9, 1, 0xf7] },
    { deltaTime: 0, type: 'endOfTrack' },
  ];
  return Uint8Array.from(
    writeMidi(
      {
        header: { format, numTracks: format === 0 ? 1 : 2, ticksPerBeat: 480 },
        tracks:
          format === 0
            ? [[...conductor.slice(0, 2), ...notes]]
            : [conductor, notes],
      },
      { running: true, useByte9ForNoteOff: true },
    ),
  );
}
function noteOns(data: MidiData) {
  return data.tracks.flatMap((track) => {
    let tick = 0;
    return track.flatMap((event) => {
      tick += event.deltaTime;
      return event.type === 'noteOn'
        ? [
            {
              tick,
              pitch: event.noteNumber,
              velocity: event.velocity,
              channel: event.channel,
            },
          ]
        : [];
    });
  });
}
describe('independently decoded Standard MIDI Files', () => {
  for (const format of [0, 1] as const)
    it(`preserves untouched format ${format} bytes exactly, including running status and metadata`, () => {
      const bytes = source(format),
        project = parseMidiFile(bytes);
      expect(project.format).toBe(format);
      expect(project.tracks[0].notes.map((note) => note.pitch)).toEqual([
        60, 64,
      ]);
      expect(project.tracks[0].instrument).toBe(4);
      expect(project.tracks[0].notes[0].duration).toBe(1);
      expect(project.tracks[0].notes[0].releaseVelocity).toBe(12);
      expect(
        writeMidiFile(
          {
            ...project,
            sourceSrc: '/api/files/00000000-0000-4000-8000-000000000001',
          },
          { original: bytes },
        ),
      ).toEqual(bytes);
    });
  it('exports actual edited note ticks/velocity, tempo, meter, programs, controllers and SysEx through an independent parser', () => {
    const project = parseMidiFile(source());
    project.tracks[0].notes[0].start = 2;
    project.tracks[0].notes[0].velocity = 55;
    project.tracks[0].instrument = 19;
    project.lengthBeats = 8;
    const bytes = writeMidiFile(project),
      decoded = parseMidi(bytes);
    expect(decoded.header).toMatchObject({
      format: 1,
      ticksPerBeat: 480,
      numTracks: 2,
    });
    expect(noteOns(decoded)).toContainEqual({
      tick: 960,
      pitch: 60,
      velocity: 55,
      channel: 0,
    });
    expect(
      decoded.tracks
        .flat()
        .some(
          (event) =>
            event.type === 'programChange' && event.programNumber === 19,
        ),
    ).toBe(true);
    expect(
      decoded.tracks
        .flat()
        .some(
          (event) =>
            event.type === 'controller' &&
            event.controllerType === 64 &&
            event.value === 127,
        ),
    ).toBe(true);
    expect(decoded.tracks.flat().some((event) => event.type === 'sysEx')).toBe(
      true,
    );
    expect(
      decoded.tracks
        .flat()
        .some(
          (event) =>
            event.type === 'timeSignature' &&
            event.numerator === 7 &&
            event.denominator === 8,
        ),
    ).toBe(true);
    expect(
      parseMidiFile(bytes).tracks[0].notes.find((note) => note.pitch === 60),
    ).toMatchObject({ start: 2, velocity: 55 });
  });
  it('converts edited projects into valid type 0 and round-trips tempo-aware seek positions', () => {
    const project = parseMidiFile(source());
    project.format = 0;
    const bytes = writeMidiFile(project),
      decoded = parseMidi(bytes);
    expect(decoded.header).toMatchObject({ format: 0, numTracks: 1 });
    expect(noteOns(decoded)).toHaveLength(2);
    for (const beat of [0, 1, 2, 3, 4, 7])
      expect(secondsBeat(project, beatSeconds(project, beat))).toBeCloseTo(
        beat,
        10,
      );
  });
  it('supports SMPTE time division and byte-exact untouched export while normalizing editable beat timing', () => {
    const bytes = Uint8Array.from(
      writeMidi({
        header: {
          format: 0,
          numTracks: 1,
          framesPerSecond: 25,
          ticksPerFrame: 40,
        },
        tracks: [
          [
            {
              deltaTime: 0,
              type: 'noteOn',
              channel: 0,
              noteNumber: 69,
              velocity: 100,
            },
            {
              deltaTime: 1000,
              type: 'noteOff',
              channel: 0,
              noteNumber: 69,
              velocity: 0,
            },
            { deltaTime: 0, type: 'endOfTrack' },
          ],
        ],
      }),
    );
    const project = parseMidiFile(bytes);
    expect(project.ppq).toBe(480);
    expect(project.tracks[0].notes[0].duration).toBe(2);
    expect(writeMidiFile(project, { original: bytes })).toEqual(bytes);
  });
  it('rejects malformed/truncated chunks, unbounded VLQs, and invalid raw preserved events', () => {
    const bytes = source();
    for (let length = 0; length < bytes.length; length++)
      expect(() => parseMidiFile(bytes.subarray(0, length))).toThrow();
    const invalid = source();
    invalid[0] = 0;
    expect(() => parseMidiFile(invalid)).toThrow('header');
    const project = initialMidiContent();
    project.meta = [{ kind: 'midi', tick: 0, data: [0x90, 60, 100] }];
    expect(() => writeMidiFile(project)).toThrow('channel event');
  });
});
