import { z } from 'zod';
const id = z.string().min(1).max(80);
export const ownedAudioSource = z
  .string()
  .regex(/^\/api\/files\/[0-9a-f-]{36}$/i);
const db = z.number().finite().min(-60).max(12);
export const audioClipSchema = z
  .object({
    id,
    title: z.string().min(1).max(180),
    src: ownedAudioSource,
    start: z.number().finite().min(0).max(300),
    offset: z.number().finite().min(0).max(300),
    duration: z.number().finite().min(0.01).max(300),
    gainDb: db.default(0),
    fadeIn: z.number().finite().min(0).max(300).default(0),
    fadeOut: z.number().finite().min(0).max(300).default(0),
    reverse: z.boolean().default(false),
  })
  .strict();
export const audioTrackSchema = z
  .object({
    id,
    title: z.string().min(1).max(180),
    gainDb: db.default(0),
    pan: z.number().finite().min(-1).max(1).default(0),
    mute: z.boolean().default(false),
    solo: z.boolean().default(false),
    effects: z
      .object({
        highpassHz: z.number().finite().min(10).max(10000).default(20),
        lowpassHz: z.number().finite().min(100).max(20000).default(20000),
        compressor: z.boolean().default(false),
      })
      .strict()
      .default({ highpassHz: 20, lowpassHz: 20000, compressor: false }),
    clips: z.array(audioClipSchema).max(128),
  })
  .strict();
export const audioContentSchema = z
  .object({
    schemaVersion: z.literal(1),
    sampleRate: z.union([z.literal(44100), z.literal(48000)]).default(48000),
    duration: z.number().finite().min(0.1).max(300),
    masterGainDb: db.default(0),
    tracks: z.array(audioTrackSchema).max(16),
  })
  .strict()
  .superRefine((content, ctx) => {
    const tracks = new Set<string>(),
      clips = new Set<string>();
    let count = 0;
    for (const track of content.tracks) {
      if (tracks.has(track.id))
        ctx.addIssue({
          code: 'custom',
          message: 'Audio track identifiers must be unique',
        });
      tracks.add(track.id);
      if (track.effects.highpassHz >= track.effects.lowpassHz)
        ctx.addIssue({
          code: 'custom',
          message: 'High-pass frequency must be below low-pass frequency',
        });
      for (const clip of track.clips) {
        count++;
        if (clips.has(clip.id))
          ctx.addIssue({
            code: 'custom',
            message: 'Audio clip identifiers must be unique',
          });
        clips.add(clip.id);
        if (
          clip.start + clip.duration > content.duration + 0.00001 ||
          clip.offset + clip.duration > 300.00001 ||
          clip.fadeIn > clip.duration ||
          clip.fadeOut > clip.duration
        )
          ctx.addIssue({
            code: 'custom',
            message:
              'Clip trims and fades must fit the bounded timeline and source',
          });
      }
    }
    if (count > 128)
      ctx.addIssue({
        code: 'custom',
        message: 'An audio project supports at most 128 clips',
      });
  });
export type AudioClip = z.infer<typeof audioClipSchema>;
export type AudioTrack = z.infer<typeof audioTrackSchema>;
export type AudioContent = z.infer<typeof audioContentSchema>;
export function initialAudioContent(): AudioContent {
  return {
    schemaVersion: 1,
    sampleRate: 48000,
    duration: 10,
    masterGainDb: 0,
    tracks: [],
  };
}
export function audibleAudioTracks(content: AudioContent) {
  const solo = content.tracks.some((track) => track.solo && !track.mute);
  return content.tracks.filter((track) => !track.mute && (!solo || track.solo));
}
export function audioGain(db: number) {
  return Math.pow(10, db / 20);
}
