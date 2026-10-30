import {
  videoContentSchema,
  type VideoClip,
  type VideoKeyframe,
  type VideoProperty,
  type TimelineContent,
} from './video.ts';
export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
export const frameTime = (value: number, fps: number) =>
  Math.round(value * fps) / fps;
export function eased(value: number, easing: VideoKeyframe['easing']) {
  if (easing === 'hold') return value >= 1 ? 1 : 0;
  if (easing === 'ease-in') return value * value;
  if (easing === 'ease-out') return 1 - (1 - value) ** 2;
  if (easing === 'ease-in-out')
    return value < 0.5 ? 2 * value * value : 1 - (-2 * value + 2) ** 2 / 2;
  return value;
}
export function clipValue(
  clip: VideoClip,
  property: VideoProperty,
  time: number,
): number {
  const at = time - clip.start + clip.animationOffset;
  const keys = clip.keyframes
    .filter((key) => key.property === property)
    .sort((a, b) => a.at - b.at);
  if (keys.length === 0) return clip[property];
  if (at <= keys[0]!.at) return keys[0]!.value;
  for (let index = 1; index < keys.length; index++) {
    const previous = keys[index - 1]!,
      next = keys[index]!;
    if (at <= next.at)
      return (
        previous.value +
        (next.value - previous.value) *
          eased((at - previous.at) / (next.at - previous.at), next.easing)
      );
  }
  return keys[keys.length - 1]!.value;
}
export function activeClip(clip: VideoClip, time: number) {
  return time >= clip.start && time < clip.start + clip.duration;
}
export function clipAt(clip: VideoClip, time: number) {
  return Object.fromEntries(
    ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'].map((key) => [
      key,
      clipValue(clip, key as VideoProperty, time),
    ]),
  ) as Record<VideoProperty, number>;
}
export function splitClip(
  content: TimelineContent,
  id: string,
  time: number,
): TimelineContent {
  const clip = content.clips.find((item) => item.id === id);
  if (!clip || clip.locked)
    throw new Error('Select an unlocked clip to split.');
  const cut = frameTime(time - clip.start, content.fps);
  if (cut < 1 / content.fps || cut > clip.duration - 1 / content.fps)
    throw new Error(
      'Move the playhead inside the selected clip before splitting.',
    );
  const right: VideoClip = {
    ...structuredClone(clip),
    id: crypto.randomUUID(),
    start: clip.start + cut,
    duration: clip.duration - cut,
    mediaStart: clip.mediaStart + cut,
    animationOffset: clip.animationOffset + cut,
    name: `${clip.name.slice(0, 170)} · split`,
  };
  const result = {
    ...content,
    clips: content.clips.flatMap((item) =>
      item.id === id ? [{ ...item, duration: cut }, right] : [item],
    ),
  };
  videoContentSchema.parse(result);
  return result;
}
export function trimClip(
  content: TimelineContent,
  id: string,
  start: number,
  end: number,
): TimelineContent {
  const clip = content.clips.find((item) => item.id === id);
  if (!clip || clip.locked) throw new Error('Select an unlocked clip to trim.');
  start = frameTime(start, content.fps);
  end = frameTime(end, content.fps);
  if (
    start < clip.start ||
    end > clip.start + clip.duration + 0.002 ||
    end - start < 1 / content.fps
  )
    throw new Error('Trim points must stay inside the selected clip.');
  const removed = start - clip.start;
  const result = {
    ...content,
    clips: content.clips.map((item) =>
      item.id === id
        ? {
            ...item,
            start,
            duration: end - start,
            mediaStart: item.mediaStart + removed,
            animationOffset: item.animationOffset + removed,
          }
        : item,
    ),
  };
  videoContentSchema.parse(result);
  return result;
}
export function newClip(
  type: VideoClip['type'],
  duration: number,
  track: number,
): VideoClip {
  return {
    id: crypto.randomUUID(),
    type,
    name:
      type === 'text'
        ? 'New title'
        : `${type[0]!.toUpperCase()}${type.slice(1)}`,
    track,
    start: 0,
    duration,
    mediaStart: 0,
    animationOffset: 0,
    x: 100,
    y: 140,
    width: 680,
    height: 160,
    rotation: 0,
    scale: 1,
    opacity: 1,
    fill: '#24292e',
    text: type === 'text' ? 'Build with intent.' : '',
    fontSize: 64,
    fontFamily: 'Inter',
    volume: 1,
    muted: false,
    locked: false,
    keyframes: [],
  };
}
export function nextTrack(
  content: TimelineContent,
  start = 0,
  duration = content.duration,
) {
  for (let track = 0; track <= 199; track++) {
    if (
      !content.clips.some(
        (clip) =>
          clip.track === track &&
          start < clip.start + clip.duration &&
          start + duration > clip.start,
      )
    )
      return track;
  }
  throw new Error('All 200 tracks are occupied at this time.');
}
export function timecode(value: number, fps: number) {
  const frames = Math.max(0, Math.round(value * fps));
  return `${String(Math.floor(frames / fps / 60)).padStart(2, '0')}:${String(Math.floor(frames / fps) % 60).padStart(2, '0')}:${String(frames % fps).padStart(2, '0')}`;
}
