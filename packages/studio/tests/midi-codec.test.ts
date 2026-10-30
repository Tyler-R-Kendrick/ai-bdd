import { describe, it, expect } from 'vitest';
import { parseMidi, writeMidi, type MidiData } from 'midi-file';
import { parseMidiFile, writeMidiFile } from '../shared/midi-file.ts';
import {
  midiContentSchema,
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

it('rejects shortening the composition past tempo, meter or preserved event markers', () => {
  const content = initialMidiContent();
  content.lengthBeats = 4;
  for (const patch of [
    {
      tempo: [
        { beat: 0, bpm: 120 },
        { beat: 5, bpm: 90 },
      ],
    },
    {
      timeSignatures: [
        { beat: 0, numerator: 4, denominator: 4 },
        { beat: 5, numerator: 3, denominator: 4 },
      ],
    },
    { meta: [{ tick: 1921, kind: 'meta', type: 6, data: [65] }] },
    {
      tracks: [
        {
          id: 'track',
          title: 'Piano',
          channel: 0,
          instrument: 0,
          notes: [],
          events: [{ tick: 1921, kind: 'midi', data: [0xb0, 7, 90] }],
        },
      ],
    },
  ])
    expect(midiContentSchema.safeParse({ ...content, ...patch }).success).toBe(
      false,
    );
  expect(
    midiContentSchema.safeParse({
      ...content,
      meta: [{ tick: 1920, kind: 'meta', type: 6, data: [65] }],
    }).success,
  ).toBe(true);
});

it('omits muted/unsoloed parts without muting shared channels and scales later preserved CC7', () => {
  const content = midiContentSchema.parse({
    ...initialMidiContent(),
    lengthBeats: 4,
    meta: [
      { kind: 'sysex', tick: 480, type: 0xf0, data: [0x7e, 0x7f, 9, 1, 0xf7] },
    ],
    tracks: [
      {
        id: 'quiet',
        title: 'Muted part',
        channel: 0,
        instrument: 99,
        mute: true,
        notes: [
          { id: 'quiet-note', pitch: 60, start: 0, duration: 2, velocity: 100 },
        ],
        events: [{ kind: 'midi', tick: 240, data: [0xb0, 7, 127] }],
      },
      {
        id: 'shared',
        title: 'Shared channel part',
        channel: 0,
        instrument: 4,
        notes: [
          {
            id: 'shared-note',
            pitch: 64,
            start: 0,
            duration: 2,
            velocity: 100,
          },
        ],
      },
    ],
  });
  const decode = () => parseMidi(writeMidiFile(content));
  let decoded = decode();
  expect(decoded.tracks[1].filter((event) => 'channel' in event)).toHaveLength(
    0,
  );
  expect(
    decoded.tracks[2]
      .filter((event) => event.type === 'noteOn')
      .map((event) => (event as any).noteNumber),
  ).toEqual([64]);
  expect(
    decoded.tracks.flat().filter((event) => event.type === 'controller'),
  ).toHaveLength(0);
  content.tracks[0].mute = false;
  content.tracks[1].solo = true;
  decoded = decode();
  expect(
    decoded.tracks[1].filter((event) => event.type === 'noteOn'),
  ).toHaveLength(0);
  expect(
    decoded.tracks[2].filter((event) => event.type === 'noteOn'),
  ).toHaveLength(1);
  content.tracks[1].solo = false;
  content.tracks[1].mute = true;
  content.tracks[0].gainDb = -6;
  content.tracks[0].events = [
    { kind: 'midi', tick: 0, data: [0xb0, 7, 80] },
    { kind: 'midi', tick: 240, data: [0xb0, 7, 120] },
    { kind: 'midi', tick: 480, data: [0xb0, 10, 64] },
  ];
  decoded = decode();
  expect(
    decoded.tracks[1]
      .filter(
        (event) => event.type === 'controller' && event.controllerType === 7,
      )
      .map((event) => (event as any).value),
  ).toEqual([50, 40, 60]);
  expect(
    decoded.tracks[1].find(
      (event) => event.type === 'controller' && event.controllerType === 10,
    ),
  ).toMatchObject({ value: 64 });
  expect(decoded.tracks[2].filter((event) => 'channel' in event)).toHaveLength(
    0,
  );
});
