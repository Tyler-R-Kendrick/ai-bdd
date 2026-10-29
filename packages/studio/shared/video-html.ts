import type { TimelineContent, VideoClip, VideoKeyframe, VideoProperty } from './video.ts';
import { clipValue, eased } from './video-timeline.ts';
const html = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const scriptJSON = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const cssProperties: Record<VideoProperty, string> = { x: 'left', y: 'top', scale: 'scale', rotation: 'rotation', opacity: 'opacity', volume: 'volume' };
function easeSource(easing: VideoKeyframe['easing']) {
  if (easing === 'hold') return '(p>=1?1:0)';
  if (easing === 'ease-in') return '(p*p)';
  if (easing === 'ease-out') return '(1-(1-p)*(1-p))';
  if (easing === 'ease-in-out') return '(p<.5?2*p*p:1-Math.pow(-2*p+2,2)/2)';
  return 'p';
}
function gsapTimeline(content: TimelineContent) {
  const result: string[] = ['window.__timelines=window.__timelines||{};const tl=gsap.timeline({paused:true});'];
  for (const clip of content.clips.filter((item) => item.type !== 'audio')) {
    const selector = scriptJSON('#clip-' + clip.id);
    for (const property of ['x', 'y', 'scale', 'rotation', 'opacity'] as VideoProperty[]) {
      const css = cssProperties[property];
      result.push(`tl.set(${selector},{${css}:${clipValue(clip, property, clip.start)}},${clip.start});`);
      const keys = clip.keyframes.filter((key) => key.property === property).sort((a, b) => a.at - b.at);
      for (let index = 1; index < keys.length; index++) {
        const previous = keys[index - 1]!, next = keys[index]!;
        const origin = clip.start - clip.animationOffset;
        const start = Math.max(clip.start, origin + previous.at), end = Math.min(clip.start + clip.duration, origin + next.at);
        if (end <= start) continue;
        const fractionStart = (start - origin - previous.at) / (next.at - previous.at), fractionEnd = (end - origin - previous.at) / (next.at - previous.at);
        const e0 = eased(fractionStart, next.easing), e1 = eased(fractionEnd, next.easing);
        const ease = e1 === e0 ? '"none"' : `(p)=>{const e=p=>${easeSource(next.easing)};return (e(${fractionStart}+p*${fractionEnd - fractionStart})-${e0})/${e1 - e0}}`;
        result.push(`tl.fromTo(${selector},{${css}:${clipValue(clip, property, start)}},{${css}:${clipValue(clip, property, end)},duration:${end - start},ease:${ease},immediateRender:false},${start});`);
      }
    }
  }
  result.push('window.__timelines["studio-composition"]=tl;');
  return result.join('\n');
}
function runtime(content: TimelineContent) {
  const w = window as typeof window & { __studioReady: Promise<unknown>; __studioSeek: (time: number) => Promise<void> };
  function easing(p: number, name: string) {
    if (name === 'hold') return p >= 1 ? 1 : 0;
    if (name === 'ease-in') return p * p;
    if (name === 'ease-out') return 1 - (1 - p) ** 2;
    if (name === 'ease-in-out') return p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
    return p;
  }
  function value(clip: VideoClip, property: VideoProperty, t: number) {
    const at = t - clip.start + clip.animationOffset;
    const keys = clip.keyframes.filter((key) => key.property === property).sort((a, b) => a.at - b.at);
    if (!keys.length) return clip[property];
    if (at <= keys[0]!.at) return keys[0]!.value;
    for (let index = 1; index < keys.length; index++) {
      const a = keys[index - 1]!, b = keys[index]!;
      if (at <= b.at) return a.value + (b.value - a.value) * easing((at - a.at) / (b.at - a.at), b.easing);
    }
    return keys[keys.length - 1]!.value;
  }
  function loaded(element: HTMLMediaElement) {
    if (element.readyState >= 1) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { clean(); reject(new Error('Media metadata timed out')); }, 15000);
      const clean = () => { clearTimeout(timeout); element.removeEventListener('loadedmetadata', success); element.removeEventListener('error', error); };
      const success = () => { clean(); resolve(); }, error = () => { clean(); reject(new Error('Media could not be decoded')); };
      element.addEventListener('loadedmetadata', success); element.addEventListener('error', error);
    });
  }
  w.__studioReady = Promise.all([document.fonts.ready, ...Array.from(document.images).map((image) => image.decode()), ...Array.from(document.querySelectorAll('video,audio')).map((element) => loaded(element as HTMLMediaElement))]);
  w.__studioSeek = async (t: number) => {
    await w.__studioReady;
    const seek: Promise<void>[] = [];
    for (const clip of content.clips) {
      const element = document.getElementById('clip-' + clip.id)!;
      const visible = t >= clip.start && t < clip.start + clip.duration;
      element.style.display = visible ? 'block' : 'none';
      if (clip.type !== 'audio') {
        element.style.left = value(clip, 'x', t) + 'px'; element.style.top = value(clip, 'y', t) + 'px';
        element.style.transform = `rotate(${value(clip, 'rotation', t)}deg) scale(${value(clip, 'scale', t)})`;
        element.style.opacity = String(value(clip, 'opacity', t));
      }
      if (visible && clip.type === 'video') {
        const video = element as HTMLVideoElement;
        const position = Math.max(0, Math.min(video.duration - 0.00001, clip.mediaStart + t - clip.start));
        if (Math.abs(video.currentTime - position) > 0.00001) seek.push(new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => { clean(); reject(new Error('Media seek timed out')); }, 10000);
          const clean = () => { clearTimeout(timeout); video.removeEventListener('seeked', done); video.removeEventListener('error', error); };
          const done = () => { clean(); resolve(); }, error = () => { clean(); reject(new Error('Media seek failed')); };
          video.addEventListener('seeked', done); video.addEventListener('error', error); video.currentTime = position;
        }));
      }
    }
    await Promise.all(seek);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  };
}
export type VideoAssetMap = Record<string, { url: string; mime: string }>;
export function videoHTML(content: TimelineContent, title: string, options: { assets: VideoAssetMap; interFont?: string; renderer?: boolean; gsapPath?: string } ) {
  const fonts = new Map<string, string>();
  if (options.interFont) fonts.set('Inter', options.interFont);
  for (const clip of content.clips) if (clip.fontUrl) fonts.set('Font-' + clip.fontUrl.split('/').pop(), options.assets[clip.fontUrl]!.url);
  const css = [...fonts].map(([name, url]) => `@font-face{font-family:'${name}';src:url(${JSON.stringify(url)});font-display:block}`).join('');
  const nodes = content.clips.map((clip) => {
    const asset = clip.src ? options.assets[clip.src] : undefined;
    if (clip.src && !asset) throw new Error('A composition asset is missing');
    const font = clip.fontFamily === 'Custom' ? 'Font-' + clip.fontUrl!.split('/').pop() : clip.fontFamily;
    const attrs = `id="clip-${clip.id}" data-start="${clip.start}" data-duration="${clip.duration}" data-track-index="${clip.track}" data-media-start="${clip.mediaStart}" data-volume="${clip.muted ? 0 : clip.volume}"`;
    const style = `position:absolute;left:${clip.x}px;top:${clip.y}px;width:${clip.width}px;height:${clip.height}px;z-index:${clip.track};opacity:${clip.opacity};transform:rotate(${clip.rotation}deg) scale(${clip.scale});transform-origin:center;${clip.type === 'rect' || clip.type === 'ellipse' ? `background:${clip.fill};` : ''}${clip.type === 'ellipse' ? 'border-radius:50%;' : ''}color:${clip.fill};font-family:'${font}';font-size:${clip.fontSize}px;line-height:1.15;white-space:pre-wrap;overflow:hidden;object-fit:contain;`;
    if (clip.type === 'video') return `<video ${attrs} style="${style}" src="${html(asset!.url)}" muted playsinline preload="auto"></video>`;
    if (clip.type === 'audio') return `<audio ${attrs} src="${html(asset!.url)}" preload="auto"></audio>`;
    if (clip.type === 'image') return `<img ${attrs} style="${style}" src="${html(asset!.url)}" alt="${html(clip.name)}">`;
    return `<div ${attrs} style="${style}">${clip.type === 'text' ? html(clip.text) : ''}</div>`;
  }).join('\n');
  const script = options.renderer ? `<script>(${runtime.toString()})(${scriptJSON(content)});</script>` : `<script src="${html(options.gsapPath ?? 'assets/gsap.min.js')}"></script><script>${gsapTimeline(content)}</script>`;
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title><style>${css}*{box-sizing:border-box}html,body{margin:0;width:${content.width}px;height:${content.height}px;overflow:hidden}#studio-composition{position:relative;width:${content.width}px;height:${content.height}px;background:${content.background};overflow:hidden}</style></head><body><div id="studio-composition" data-composition-id="studio-composition" data-start="0" data-duration="${content.duration}" data-width="${content.width}" data-height="${content.height}">${nodes}</div>${script}</body></html>\n`;
}
