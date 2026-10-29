import { describe, expect, it } from 'vitest';
import { normalizeVideo, videoContentSchema, type TimelineContent } from '../shared/video.ts';
import { clipValue, newClip, nextTrack, splitClip, trimClip } from '../shared/video-timeline.ts';
import { videoHTML } from '../shared/video-html.ts';
const fixture = (): TimelineContent => ({ width: 640, height: 360, background: '#ffffff', duration: 4, fps: 30,
  clips: [{ ...newClip('text', 4, 0), id: '00000000-0000-4000-8000-000000000001', x: 0, keyframes: [
    { property: 'x', at: 0, value: 0, easing: 'linear' },
    { property: 'x', at: 4, value: 400, easing: 'ease-in-out' },
  ] }] });
describe('Video composition timeline', () => {
  it('normalizes persisted first-generation layers without losing their context', () => {
    const clip = fixture().clips[0]!;
    const { id, type, x, y, width, height, rotation, fill, text, fontSize, fontFamily, start, duration } = clip;
    const result = normalizeVideo({ width: 640, height: 360, background: '#ffffff', duration: 4,
      layers: [{ id, type, x, y, width, height, rotation, fill, text, fontSize, fontFamily, start, duration }] });
    expect(result.clips[0]).toMatchObject({ id, type: 'text', duration: 4, track: 0 });
    expect(result.fps).toBe(30);
  });
  it('preserves exact source trim and nonlinear animation through split and trim', () => {
    const content = fixture(), clip = content.clips[0]!;
    const divided = splitClip(content, clip.id, 2);
    const right = divided.clips[1]!;
    expect(right.mediaStart).toBe(2);
    expect(right.animationOffset).toBe(2);
    for (const time of [2, 2.1, 2.5, 3, 3.9]) expect(clipValue(right, 'x', time)).toBe(clipValue(clip, 'x', time));
    const trimmed = trimClip(divided, right.id, 2.5, 3.5).clips[1]!;
    expect(trimmed.mediaStart).toBe(2.5);
    expect(trimmed.animationOffset).toBe(2.5);
    expect(clipValue(trimmed, 'x', 3)).toBe(clipValue(clip, 'x', 3));
  });
  it('rejects unsafe media, overlap, invalid values, and out-of-range sources', () => {
    const content = fixture();
    expect(videoContentSchema.safeParse({ ...content, clips: [{ ...content.clips[0], type: 'video', src: 'https://example.com/a.mp4' }] }).success).toBe(false);
    expect(videoContentSchema.safeParse({ ...content, clips: [...content.clips, { ...content.clips[0], id: crypto.randomUUID(), start: 1, duration: 2 }] }).success).toBe(false);
    expect(videoContentSchema.safeParse({ ...content, clips: [{ ...content.clips[0], opacity: Infinity }] }).success).toBe(false);
    expect(videoContentSchema.safeParse({ ...content, clips: [{ ...content.clips[0], type: 'audio', src: '/api/files/00000000-0000-4000-8000-000000000002', sourceDuration: 2 }] }).success).toBe(false);
    expect(nextTrack(content)).toBe(1);
  });
  it('exports actual HyperFrames attributes and registered paused GSAP timelines', () => {
    const content = fixture(); content.clips[0]!.text = '</script><img src=x onerror=alert(1)>';
    const source = videoHTML(content, 'A < title', { assets: {} });
    expect(source).toContain('data-composition-id="studio-composition"');
    expect(source).toContain('data-track-index="0"');
    expect(source).toContain('gsap.timeline({paused:true})');
    expect(source).toContain('window.__timelines["studio-composition"]=tl');
    expect(source).toContain('&lt;/script&gt;');
    expect(source).not.toContain('<img src=x');
    expect(source).not.toContain('data-layer');
  });
});
