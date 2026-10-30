import { pathData } from './visual-design.ts';
import {
  clipAppearance,
  cropStyle,
  generatedVideoFontURL,
} from './video-appearance.ts';
import type { TimelineContent, VideoClip, VideoProperty } from './video.ts';
const html = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const scriptJSON = (value: unknown) =>
  JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
function runtime(content: TimelineContent) {
  const w = window as typeof window & {
    __studioReady: Promise<unknown>;
    __studioSeek: (time: number) => Promise<void>;
  };
  function easing(p: number, name: string) {
    if (name === 'hold') return p >= 1 ? 1 : 0;
    if (name === 'ease-in') return p * p;
    if (name === 'ease-out') return 1 - (1 - p) ** 2;
    if (name === 'ease-in-out')
      return p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
    return p;
  }
  function value(clip: VideoClip, property: VideoProperty, t: number) {
    const at = t - clip.start + clip.animationOffset;
    const keys = clip.keyframes
      .filter((key) => key.property === property)
      .sort((a, b) => a.at - b.at);
    if (!keys.length) return clip[property];
    if (at <= keys[0]!.at) return keys[0]!.value;
    for (let index = 1; index < keys.length; index++) {
      const a = keys[index - 1]!,
        b = keys[index]!;
      if (at <= b.at)
        return (
          a.value +
          (b.value - a.value) * easing((at - a.at) / (b.at - a.at), b.easing)
        );
    }
    return keys[keys.length - 1]!.value;
  }
  function loaded(element: HTMLMediaElement) {
    if (element.readyState >= 1) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clean();
        reject(new Error('Media metadata timed out'));
      }, 15000);
      const clean = () => {
        clearTimeout(timeout);
        element.removeEventListener('loadedmetadata', success);
        element.removeEventListener('error', error);
      };
      const success = () => {
          clean();
          resolve();
        },
        error = () => {
          clean();
          reject(new Error('Media could not be decoded'));
        };
      element.addEventListener('loadedmetadata', success);
      element.addEventListener('error', error);
    });
  }
  w.__studioReady = Promise.all([
    document.fonts.ready,
    ...content.clips
      .filter(
        (clip) =>
          clip.type === 'text' &&
          ['Inter', 'Custom', 'Generated'].includes(clip.fontFamily),
      )
      .map(async (clip) => {
        const name =
          clip.fontFamily === 'Custom'
            ? 'Font-' + clip.fontUrl!.split('/').pop()
            : clip.fontFamily === 'Generated'
              ? 'ArtifactGenerated'
              : 'Inter';
        try {
          const faces = await document.fonts.load(
            `${clip.fontSize}px "${name}"`,
            clip.text || 'A',
          );
          if (!faces.length || faces.some((font) => font.status !== 'loaded'))
            throw new Error('Font face unavailable');
        } catch {
          throw new Error(
            'A composition font could not be decoded. Reimport a valid font before rendering.',
          );
        }
      }),
    ...Array.from(document.images).map((image) => image.decode()),
    ...Array.from(document.querySelectorAll('video,audio')).map((element) =>
      loaded(element as HTMLMediaElement),
    ),
  ]);
  function visual(t: number) {
    for (const clip of content.clips) {
      const element = document.getElementById('clip-' + clip.id)!;
      element.style.display =
        t >= clip.start && t < clip.start + clip.duration ? 'block' : 'none';
      if (clip.type !== 'audio') {
        element.style.left = value(clip, 'x', t) + 'px';
        element.style.top = value(clip, 'y', t) + 'px';
        element.style.transform = `rotate(${value(clip, 'rotation', t)}deg) scale(${value(clip, 'scale', t)})`;
        element.style.opacity = String(value(clip, 'opacity', t));
      }
    }
  }
  w.__studioSeek = async (t: number) => {
    await w.__studioReady;
    visual(t);
    const seek: Promise<void>[] = [];
    for (const clip of content.clips) {
      const element = document.getElementById('clip-' + clip.id)!;
      const visible = t >= clip.start && t < clip.start + clip.duration;
      if (visible && clip.type === 'video') {
        const video = element as HTMLVideoElement;
        const position = Math.max(
          0,
          Math.min(video.duration - 0.00001, clip.mediaStart + t - clip.start),
        );
        if (Math.abs(video.currentTime - position) > 0.00001)
          seek.push(
            new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => {
                clean();
                reject(new Error('Media seek timed out'));
              }, 10000);
              const clean = () => {
                clearTimeout(timeout);
                video.removeEventListener('seeked', done);
                video.removeEventListener('error', error);
              };
              const done = () => {
                  clean();
                  resolve();
                },
                error = () => {
                  clean();
                  reject(new Error('Media seek failed'));
                };
              video.addEventListener('seeked', done);
              video.addEventListener('error', error);
              video.currentTime = position;
            }),
          );
      }
    }
    await Promise.all(seek);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  };
}
declare global {
  interface Window {
    __timelines?: Record<string, unknown>;
  }
}
function timelineRuntime(content: TimelineContent) {
  function easing(p: number, name: string) {
    if (name === 'hold') return p >= 1 ? 1 : 0;
    if (name === 'ease-in') return p * p;
    if (name === 'ease-out') return 1 - (1 - p) ** 2;
    if (name === 'ease-in-out')
      return p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
    return p;
  }
  function value(clip: VideoClip, property: VideoProperty, t: number) {
    const at = t - clip.start + clip.animationOffset;
    const keys = clip.keyframes
      .filter((key) => key.property === property)
      .sort((a, b) => a.at - b.at);
    if (!keys.length) return clip[property];
    if (at <= keys[0]!.at) return keys[0]!.value;
    for (let index = 1; index < keys.length; index++) {
      const a = keys[index - 1]!,
        b = keys[index]!;
      if (at <= b.at)
        return (
          a.value +
          (b.value - a.value) * easing((at - a.at) / (b.at - a.at), b.easing)
        );
    }
    return keys[keys.length - 1]!.value;
  }
  function visual(t: number) {
    for (const clip of content.clips) {
      const element = document.getElementById('clip-' + clip.id)!;
      element.style.display =
        t >= clip.start && t < clip.start + clip.duration ? 'block' : 'none';
      if (clip.type !== 'audio') {
        element.style.left = value(clip, 'x', t) + 'px';
        element.style.top = value(clip, 'y', t) + 'px';
        element.style.transform = `rotate(${value(clip, 'rotation', t)}deg) scale(${value(clip, 'scale', t)})`;
        element.style.opacity = String(value(clip, 'opacity', t));
      }
    }
  }
  let time = 0,
    paused = true,
    rate = 1;
  const seek = (next: number) => {
    time = Math.max(0, Math.min(content.duration, Number(next) || 0));
    visual(time);
    return timeline;
  };
  const timeline = {
    duration: () => content.duration,
    totalDuration: () => content.duration,
    time: (next?: number) => (next === undefined ? time : seek(next)),
    totalTime: (next?: number) => (next === undefined ? time : seek(next)),
    progress: (next?: number) =>
      next === undefined
        ? time / content.duration
        : seek(next * content.duration),
    seek,
    play: (at?: number) => {
      if (at !== undefined) seek(at);
      paused = false;
      return timeline;
    },
    pause: (at?: number) => {
      paused = true;
      if (at !== undefined) seek(at);
      return timeline;
    },
    paused: (next?: boolean) =>
      next === undefined ? paused : next ? timeline.pause() : timeline.play(),
    timeScale: (next?: number) => {
      if (next === undefined) return rate;
      rate = Math.max(0.01, Number(next) || 1);
      return timeline;
    },
    getChildren: () => [],
    getLabelsArray: () => [],
    kill: () => timeline.pause(),
  };
  window.__timelines = window.__timelines || {};
  window.__timelines['studio-composition'] = timeline;
  visual(0);
}
export type VideoAssetMap = Record<string, { url: string; mime: string }>;
export function videoHTML(
  content: TimelineContent,
  title: string,
  options: { assets: VideoAssetMap; interFont?: string; renderer?: boolean },
) {
  const fonts = new Map<string, string>();
  if (options.interFont) fonts.set('Inter', options.interFont);
  const generated = generatedVideoFontURL(content);
  if (generated) fonts.set('ArtifactGenerated', generated);
  for (const clip of content.clips)
    if (clip.fontUrl)
      fonts.set(
        'Font-' + clip.fontUrl.split('/').pop(),
        options.assets[clip.fontUrl]!.url,
      );
  const css = [...fonts]
    .map(
      ([name, url]) =>
        `@font-face{font-family:'${name}';src:url(${JSON.stringify(url)});font-display:block}`,
    )
    .join('');
  const nodes = content.clips
    .map((clip) => {
      const asset = clip.src ? options.assets[clip.src] : undefined;
      if (clip.src && !asset) throw new Error('A composition asset is missing');
      const font =
        clip.fontFamily === 'Generated'
          ? 'ArtifactGenerated'
          : clip.fontFamily === 'Custom'
            ? 'Font-' + clip.fontUrl!.split('/').pop()
            : clip.fontFamily;
      const attrs = `class="clip" id="clip-${clip.id}" data-start="${clip.start}" data-duration="${clip.duration}" data-track-index="${clip.track}" data-media-start="${clip.mediaStart}" data-volume="${clip.muted ? 0 : clip.volume}"`;
      const appearance = clipAppearance(clip);
      const style = `filter:${appearance.filter};${appearance.clipPath ? `clip-path:${appearance.clipPath};` : ''}${appearance.border ? `border:${appearance.border};` : ''}position:absolute;left:${clip.x}px;top:${clip.y}px;width:${clip.width}px;height:${clip.height}px;z-index:${clip.track};opacity:${clip.opacity};transform:rotate(${clip.rotation}deg) scale(${clip.scale});transform-origin:center;${clip.type === 'rect' || clip.type === 'ellipse' ? `background:${clip.fill};` : ''}${clip.type === 'ellipse' ? 'border-radius:50%;' : ''}color:${clip.fill};font-family:'${font}';font-size:${clip.fontSize}px;line-height:1.15;white-space:pre-wrap;overflow:hidden;object-fit:contain;`;
      if (clip.type === 'video')
        return `<video ${attrs} style="${style}" src="${html(asset!.url)}" muted playsinline preload="auto"></video>${!clip.muted && !options.renderer ? `<audio class="clip" id="audio-${clip.id}" data-start="${clip.start}" data-duration="${clip.duration}" data-track-index="${200 + clip.track}" data-media-start="${clip.mediaStart}" data-volume="${clip.volume}" src="${html(asset!.url)}"></audio>` : ''}`;
      if (clip.type === 'audio')
        return `<audio ${attrs} src="${html(asset!.url)}" preload="auto"></audio>`;
      if (clip.type === 'path')
        return `<div ${attrs} style="${style}"><svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${clip.path!.viewWidth} ${clip.path!.viewHeight}"><path d="${pathData(clip.path!)}" fill="${clip.fill}" stroke="${clip.stroke ?? 'none'}" stroke-width="${clip.strokeWidth ?? 0}"></path></svg></div>`;
      if (clip.type === 'image') {
        const crop = cropStyle(clip);
        return `<div ${attrs} style="${style}"><img src="${html(asset!.url)}" alt="${html(clip.name)}" style="position:${crop.position ?? 'static'};width:${crop.width};height:${crop.height};left:${crop.left ?? 0};top:${crop.top ?? 0};object-fit:${crop.objectFit}"></div>`;
      }
      return `<div ${attrs} style="${style}">${clip.type === 'text' ? html(clip.text) : ''}</div>`;
    })
    .join('\n');
  // tsx/esbuild keepNames inserts __name calls into these trusted functions.
  // Function#toString omits the compiler's module-scoped helper, so supply its
  // name-only behavior inside this script's lexical scope for dev and exports.
  // Keep user data exclusively in scriptJSON; never interpolate it as code.
  const script = `<script>{const __name=(target,name)=>Object.defineProperty(target,"name",{value:name,configurable:true});(${options.renderer ? runtime.toString() : timelineRuntime.toString()})(${scriptJSON(content)});}</script>`;
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title><style>${css}*{box-sizing:border-box}html,body{margin:0;width:${content.width}px;height:${content.height}px;overflow:hidden}#studio-composition{position:relative;width:${content.width}px;height:${content.height}px;background:${content.background};overflow:hidden}</style></head><body><div id="studio-composition" data-composition-id="studio-composition" data-start="0" data-duration="${content.duration}" data-fps="${content.fps}" data-width="${content.width}" data-height="${content.height}">${nodes}</div>${script}</body></html>\n`;
}
