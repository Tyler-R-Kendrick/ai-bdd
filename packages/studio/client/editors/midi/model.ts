import {
  midiContentSchema,
  type MidiContent,
  type MidiNote,
  type MidiTrack,
} from '../../../shared/midi.ts';
export const pitchName = (pitch: number) =>
  ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][
    pitch % 12
  ] + String(Math.floor(pitch / 12) - 1);
export const snapBeat = (beat: number, grid: number) =>
  Math.round(beat / grid) * grid;
export function newMidiTrack(content: MidiContent): MidiTrack {
  const used = new Set(content.tracks.map((t) => t.channel));
  const channel =
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 9].find(
      (c) => !used.has(c),
    ) ?? 0;
  return {
    id: crypto.randomUUID(),
    title: 'Instrument ' + (content.tracks.length + 1),
    channel,
    instrument: 0,
    gainDb: 0,
    mute: false,
    solo: false,
    notes: [],
    events: [],
  };
}
export function newMidiNote(
  content: MidiContent,
  start: number,
  pitch = 60,
  duration = 1,
): MidiNote {
  return {
    id: crypto.randomUUID(),
    pitch: Math.max(0, Math.min(127, Math.round(pitch))),
    start: Math.max(0, Math.min(content.lengthBeats - 1 / 9600, start)),
    duration: Math.max(
      1 / 9600,
      Math.min(duration, content.lengthBeats - Math.max(0, start)),
    ),
    velocity: 100,
    releaseVelocity: 0,
  };
}
export function moveMidiNote(
  content: MidiContent,
  trackId: string,
  noteId: string,
  start: number,
  pitch: number,
) {
  const result = structuredClone(content),
    note = result.tracks
      .find((t) => t.id === trackId)
      ?.notes.find((n) => n.id === noteId);
  if (!note) throw new Error('Select a note before editing it');
  note.start = Math.max(
    0,
    Math.min(content.lengthBeats - note.duration, start),
  );
  note.pitch = Math.max(0, Math.min(127, Math.round(pitch)));
  return midiContentSchema.parse(result);
}
export function resizeMidiNote(
  content: MidiContent,
  trackId: string,
  noteId: string,
  duration: number,
) {
  const result = structuredClone(content),
    note = result.tracks
      .find((t) => t.id === trackId)
      ?.notes.find((n) => n.id === noteId);
  if (!note) throw new Error('Select a note before editing it');
  note.duration = Math.max(
    1 / 9600,
    Math.min(content.lengthBeats - note.start, duration),
  );
  return midiContentSchema.parse(result);
}
export function barMarkers(content: MidiContent) {
  const markers: { beat: number; bar: number; meter: string }[] = [];
  let bar = 1;
  for (let i = 0; i < content.timeSignatures.length; i++) {
    const meter = content.timeSignatures[i]!,
      end = Math.min(
        content.lengthBeats,
        content.timeSignatures[i + 1]?.beat ?? content.lengthBeats,
      ),
      length = (meter.numerator * 4) / meter.denominator;
    for (let beat = meter.beat; beat < end - 1e-6; beat += length)
      markers.push({
        beat,
        bar: bar++,
        meter: meter.numerator + '/' + meter.denominator,
      });
  }
  return markers;
}
export const gmPrograms = [
  'Acoustic grand piano',
  'Bright acoustic piano',
  'Electric grand piano',
  'Honky-tonk piano',
  'Electric piano 1',
  'Electric piano 2',
  'Harpsichord',
  'Clavinet',
  'Celesta',
  'Glockenspiel',
  'Music box',
  'Vibraphone',
  'Marimba',
  'Xylophone',
  'Tubular bells',
  'Dulcimer',
  'Drawbar organ',
  'Percussive organ',
  'Rock organ',
  'Church organ',
  'Reed organ',
  'Accordion',
  'Harmonica',
  'Tango accordion',
  'Acoustic guitar (nylon)',
  'Acoustic guitar (steel)',
  'Electric guitar (jazz)',
  'Electric guitar (clean)',
  'Electric guitar (muted)',
  'Overdriven guitar',
  'Distortion guitar',
  'Guitar harmonics',
  'Acoustic bass',
  'Electric bass (finger)',
  'Electric bass (pick)',
  'Fretless bass',
  'Slap bass 1',
  'Slap bass 2',
  'Synth bass 1',
  'Synth bass 2',
  'Violin',
  'Viola',
  'Cello',
  'Contrabass',
  'Tremolo strings',
  'Pizzicato strings',
  'Orchestral harp',
  'Timpani',
  'String ensemble 1',
  'String ensemble 2',
  'Synth strings 1',
  'Synth strings 2',
  'Choir aahs',
  'Voice oohs',
  'Synth voice',
  'Orchestra hit',
  'Trumpet',
  'Trombone',
  'Tuba',
  'Muted trumpet',
  'French horn',
  'Brass section',
  'Synth brass 1',
  'Synth brass 2',
  'Soprano sax',
  'Alto sax',
  'Tenor sax',
  'Baritone sax',
  'Oboe',
  'English horn',
  'Bassoon',
  'Clarinet',
  'Piccolo',
  'Flute',
  'Recorder',
  'Pan flute',
  'Blown bottle',
  'Shakuhachi',
  'Whistle',
  'Ocarina',
  'Lead 1 (square)',
  'Lead 2 (sawtooth)',
  'Lead 3 (calliope)',
  'Lead 4 (chiff)',
  'Lead 5 (charang)',
  'Lead 6 (voice)',
  'Lead 7 (fifths)',
  'Lead 8 (bass + lead)',
  'Pad 1 (new age)',
  'Pad 2 (warm)',
  'Pad 3 (polysynth)',
  'Pad 4 (choir)',
  'Pad 5 (bowed)',
  'Pad 6 (metallic)',
  'Pad 7 (halo)',
  'Pad 8 (sweep)',
  'FX 1 (rain)',
  'FX 2 (soundtrack)',
  'FX 3 (crystal)',
  'FX 4 (atmosphere)',
  'FX 5 (brightness)',
  'FX 6 (goblins)',
  'FX 7 (echoes)',
  'FX 8 (sci-fi)',
  'Sitar',
  'Banjo',
  'Shamisen',
  'Koto',
  'Kalimba',
  'Bag pipe',
  'Fiddle',
  'Shanai',
  'Tinkle bell',
  'Agogo',
  'Steel drums',
  'Woodblock',
  'Taiko drum',
  'Melodic tom',
  'Synth drum',
  'Reverse cymbal',
  'Guitar fret noise',
  'Breath noise',
  'Seashore',
  'Bird tweet',
  'Telephone ring',
  'Helicopter',
  'Applause',
  'Gunshot',
];
