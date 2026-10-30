import { z } from 'zod';
const id = z.string().min(1).max(80),
  beat = z.number().finite().min(0).max(4096);
export const midiNoteSchema = z
  .object({
    id,
    pitch: z.number().int().min(0).max(127),
    start: beat,
    duration: z
      .number()
      .finite()
      .min(1 / 9600)
      .max(4096),
    velocity: z.number().int().min(1).max(127),
    releaseVelocity: z.number().int().min(0).max(127).default(0),
  })
  .strict();
export const midiPreservedEventSchema = z
  .object({
    tick: z.number().int().min(0).max(0x0fffffff),
    kind: z.enum(['midi', 'meta', 'sysex']),
    type: z.number().int().min(0).max(255).optional(),
    data: z.array(z.number().int().min(0).max(255)).max(65536),
  })
  .strict();
export const midiTrackSchema = z
  .object({
    id,
    title: z.string().min(1).max(180),
    channel: z.number().int().min(0).max(15),
    instrument: z.number().int().min(0).max(127),
    gainDb: z.number().finite().min(-60).max(12).default(0),
    mute: z.boolean().default(false),
    solo: z.boolean().default(false),
    notes: z.array(midiNoteSchema).max(10000),
    events: z.array(midiPreservedEventSchema).max(10000).default([]),
  })
  .strict();
export const midiContentSchema = z
  .object({
    schemaVersion: z.literal(1),
    format: z.union([z.literal(0), z.literal(1)]).default(1),
    ppq: z.number().int().min(24).max(9600).default(480),
    lengthBeats: z.number().finite().min(1).max(4096),
    tempo: z
      .array(
        z.object({ beat, bpm: z.number().finite().min(10).max(500) }).strict(),
      )
      .min(1)
      .max(256),
    timeSignatures: z
      .array(
        z
          .object({
            beat,
            numerator: z.number().int().min(1).max(32),
            denominator: z.union([
              z.literal(1),
              z.literal(2),
              z.literal(4),
              z.literal(8),
              z.literal(16),
              z.literal(32),
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    tracks: z.array(midiTrackSchema).max(32),
    sourceSrc: z
      .string()
      .regex(/^\/api\/files\/[0-9a-f-]{36}$/i)
      .optional(),
    meta: z.array(midiPreservedEventSchema).max(10000).default([]),
  })
  .strict()
  .superRefine((content, ctx) => {
    if (content.tempo[0].beat !== 0 || content.timeSignatures[0].beat !== 0)
      ctx.addIssue({
        code: 'custom',
        message: 'Tempo and time signature must begin at beat zero',
      });
    for (const list of [content.tempo, content.timeSignatures])
      for (let i = 1; i < list.length; i++)
        if (list[i].beat <= list[i - 1].beat)
          ctx.addIssue({
            code: 'custom',
            message:
              'Tempo and meter changes must be ordered with unique beats',
          });
    if (
      [...content.tempo, ...content.timeSignatures].some(
        (marker) => marker.beat > content.lengthBeats,
      ) ||
      [
        ...content.meta,
        ...content.tracks.flatMap((track) => track.events),
      ].some(
        (event) => event.tick > Math.round(content.lengthBeats * content.ppq),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'MIDI tempo, meter and preserved events must fit the composition timeline',
      });
    const tracks = new Set<string>(),
      notes = new Set<string>();
    let count = 0,
      totalEvents = content.meta.length,
      totalData = content.meta.reduce(
        (sum, event) => sum + event.data.length,
        0,
      );
    for (const track of content.tracks) {
      if (tracks.has(track.id))
        ctx.addIssue({
          code: 'custom',
          message: 'MIDI track identifiers must be unique',
        });
      tracks.add(track.id);
      totalEvents += track.events.length;
      totalData += track.events.reduce(
        (sum, event) => sum + event.data.length,
        0,
      );
      for (const note of track.notes) {
        count++;
        if (notes.has(note.id))
          ctx.addIssue({
            code: 'custom',
            message: 'MIDI note identifiers must be unique',
          });
        notes.add(note.id);
        if (note.start + note.duration > content.lengthBeats + 0.00001)
          ctx.addIssue({
            code: 'custom',
            message: 'Notes must fit the MIDI timeline',
          });
      }
    }
    if (count > 10000 || totalEvents > 10000 || totalData > 512000)
      ctx.addIssue({
        code: 'custom',
        message: 'MIDI project exceeds its note/event/data budget',
      });
  });
export type MidiContent = z.infer<typeof midiContentSchema>;
export type MidiTrack = z.infer<typeof midiTrackSchema>;
export type MidiNote = z.infer<typeof midiNoteSchema>;
export type MidiPreservedEvent = z.infer<typeof midiPreservedEventSchema>;
export function initialMidiContent(): MidiContent {
  return {
    schemaVersion: 1,
    format: 1,
    ppq: 480,
    lengthBeats: 16,
    tempo: [{ beat: 0, bpm: 120 }],
    timeSignatures: [{ beat: 0, numerator: 4, denominator: 4 }],
    tracks: [],
    meta: [],
  };
}
export function beatSeconds(
  content: Pick<MidiContent, 'tempo'>,
  position: number,
) {
  let result = 0;
  for (let i = 0; i < content.tempo.length; i++) {
    const current = content.tempo[i],
      end = Math.min(position, content.tempo[i + 1]?.beat ?? position);
    if (end > current.beat) result += ((end - current.beat) * 60) / current.bpm;
    if (end >= position) break;
  }
  return result;
}
export function secondsBeat(
  content: Pick<MidiContent, 'tempo'>,
  seconds: number,
) {
  let remaining = Math.max(0, seconds);
  for (let i = 0; i < content.tempo.length; i++) {
    const current = content.tempo[i],
      next = content.tempo[i + 1],
      span = next ? ((next.beat - current.beat) * 60) / current.bpm : Infinity;
    if (remaining <= span) return current.beat + (remaining * current.bpm) / 60;
    remaining -= span;
  }
  return 0;
}
export const midiInstrumentNames = [
  'Acoustic grand piano',
  'Bright piano',
  'Electric grand piano',
  'Honky-tonk piano',
  'Electric piano',
  'FM electric piano',
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
];
