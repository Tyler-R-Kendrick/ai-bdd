import { z } from 'zod';

export const videoProperties = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'] as const;
export type VideoProperty = (typeof videoProperties)[number];
const coordinate = z.number().finite().min(-100000).max(100000);
const localAsset = z.string().regex(/^\/api\/files\/[0-9a-f-]{36}$/i);
export const videoKeyframeSchema = z.object({
  property: z.enum(videoProperties),
  at: z.number().finite().min(0).max(1200),
  value: coordinate,
  easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold']),
}).strict().superRefine((frame, context) => {
  if ((frame.property === 'opacity' || frame.property === 'volume') && (frame.value < 0 || frame.value > 1))
    context.addIssue({ code: 'custom', message: 'Opacity and volume keyframes must be between zero and one' });
  if (frame.property === 'scale' && (frame.value < 0.01 || frame.value > 100))
    context.addIssue({ code: 'custom', message: 'Scale keyframes must be between 0.01 and 100' });
});
export const videoClipSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(['text', 'rect', 'ellipse', 'image', 'video', 'audio']),
  name: z.string().trim().min(1).max(180),
  track: z.number().int().min(0).max(31),
  start: z.number().finite().min(0).max(600),
  duration: z.number().finite().min(0.01).max(600),
  mediaStart: z.number().finite().min(0).max(36000),
  animationOffset: z.number().finite().min(0).max(600),
  sourceDuration: z.number().finite().min(0.01).max(36000).optional(),
  x: coordinate, y: coordinate,
  width: z.number().finite().min(1).max(16384),
  height: z.number().finite().min(1).max(16384),
  rotation: coordinate,
  scale: z.number().finite().min(0.01).max(100),
  opacity: z.number().finite().min(0).max(1),
  fill: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  text: z.string().max(10000),
  fontSize: z.number().finite().min(1).max(500),
  fontFamily: z.enum(['Inter', 'Georgia', 'monospace', 'Custom']),
  volume: z.number().finite().min(0).max(1),
  muted: z.boolean(),
  locked: z.boolean(),
  src: localAsset.optional(),
  fontUrl: localAsset.optional(),
  keyframes: z.array(videoKeyframeSchema).max(128),
}).strict().superRefine((clip, context) => {
  if (['image', 'video', 'audio'].includes(clip.type) && !clip.src)
    context.addIssue({ code: 'custom', path: ['src'], message: 'Media clips require an authenticated project upload' });
  if (clip.fontFamily === 'Custom' && !clip.fontUrl)
    context.addIssue({ code: 'custom', path: ['fontUrl'], message: 'Custom fonts require an uploaded font' });
  if (clip.sourceDuration !== undefined && clip.mediaStart + clip.duration > clip.sourceDuration + 0.002)
    context.addIssue({ code: 'custom', path: ['duration'], message: 'Trim range exceeds the uploaded media duration' });
  const keys = new Set<string>();
  for (const frame of clip.keyframes) {
    const key = frame.property + ':' + frame.at;
    if (keys.has(key)) context.addIssue({ code: 'custom', path: ['keyframes'], message: 'A property can have only one keyframe at each time' });
    keys.add(key);
  }
});
export type VideoClip = z.infer<typeof videoClipSchema>;
export type VideoKeyframe = z.infer<typeof videoKeyframeSchema>;
const legacyLayer = z.object({
  id: z.string().uuid(), type: z.enum(['rect', 'ellipse', 'text', 'image']),
  x: coordinate, y: coordinate,
  width: z.number().finite().min(1).max(100000), height: z.number().finite().min(1).max(100000),
  fill: z.string().regex(/^#[0-9a-fA-F]{6}$/), text: z.string().max(10000),
  fontSize: z.number().finite().min(1).max(500), fontFamily: z.enum(['Inter', 'Georgia', 'monospace', 'Custom']),
  start: z.number().finite().min(0).max(600), duration: z.number().finite().min(0.1).max(600),
  rotation: coordinate, src: localAsset.optional(), fontUrl: localAsset.optional(),
}).strict();
export const videoContentSchema = z.object({
  width: z.number().int().min(64).max(4096), height: z.number().int().min(64).max(4096),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  duration: z.number().finite().min(1).max(600),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).optional(),
  layers: z.array(legacyLayer).max(200).optional(),
  clips: z.array(videoClipSchema).max(200).optional(),
}).strict().superRefine((content, context) => {
  if (!content.clips && !content.layers)
    context.addIssue({ code: 'custom', message: 'Video content requires clips or legacy layers' });
  const ids = new Set<string>();
  for (const clip of content.clips ?? []) {
    if (ids.has(clip.id)) context.addIssue({ code: 'custom', path: ['clips'], message: 'Clip identifiers must be unique' });
    ids.add(clip.id);
    if (clip.start + clip.duration > content.duration + 0.002)
      context.addIssue({ code: 'custom', path: ['clips'], message: 'Clips must fit inside the composition duration' });
  }
  const clips = [...(content.clips ?? [])].sort((a, b) => a.track - b.track || a.start - b.start);
  for (let index = 1; index < clips.length; index++) {
    const previous = clips[index - 1]!, current = clips[index]!;
    if (previous.track === current.track && current.start < previous.start + previous.duration - 0.002)
      context.addIssue({ code: 'custom', path: ['clips'], message: 'Clips on the same track may not overlap; use another track for overlays' });
  }
});
export type VideoContent = z.infer<typeof videoContentSchema>;
export type TimelineContent = Omit<VideoContent, 'clips' | 'fps'> & { clips: VideoClip[]; fps: 24 | 30 | 60 };

export function normalizeVideo(value: unknown): TimelineContent {
  const content = videoContentSchema.parse(value);
  const clips = content.clips ?? (content.layers ?? []).map((layer, index) => videoClipSchema.parse({
    ...layer, name: layer.text.trim().slice(0, 180) || `${layer.type} ${index + 1}`,
    track: index % 32, mediaStart: 0, animationOffset: 0, scale: 1, opacity: 1,
    volume: 1, muted: false, locked: false, keyframes: [],
    duration: Math.max(0.01, Math.min(layer.duration, content.duration - layer.start)),
  }));
  return { ...content, fps: content.fps ?? 30, clips };
}
