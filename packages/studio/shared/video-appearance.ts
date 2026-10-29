import { filterCss, pathData, type VectorPath } from './visual-design.ts';
import type { TimelineContent, VideoClip } from './video.ts';
import { buildTrueType } from '../client/editors/visual/typeface.ts';
export function clipPath(clip: VideoClip) {
  if (clip.mask === 'ellipse') return 'ellipse(50% 50% at 50% 50%)';
  if (clip.mask !== 'path' || !clip.path) return undefined;
  const scaled: VectorPath = {
    ...clip.path,
    contours: clip.path.contours.map((points) =>
      points.map((point) => ({
        ...point,
        x: (point.x / clip.path!.viewWidth) * clip.width,
        y: (point.y / clip.path!.viewHeight) * clip.height,
      })),
    ),
  };
  return `path('${pathData(scaled)}')`;
}
export function clipAppearance(clip: VideoClip) {
  return {
    filter: filterCss(clip.filters),
    clipPath: clipPath(clip),
    border:
      clip.stroke && clip.strokeWidth
        ? `${clip.strokeWidth}px solid ${clip.stroke}`
        : undefined,
  };
}
export function cropStyle(clip: VideoClip) {
  if (!clip.crop)
    return { width: '100%', height: '100%', objectFit: 'contain' as const };
  return {
    position: 'absolute' as const,
    width: `${100 / clip.crop.width}%`,
    height: `${100 / clip.crop.height}%`,
    left: `${(-clip.crop.x / clip.crop.width) * 100}%`,
    top: `${(-clip.crop.y / clip.crop.height) * 100}%`,
    objectFit: 'fill' as const,
  };
}
export function generatedVideoFont(
  content: Pick<TimelineContent, 'fontDesign'>,
) {
  return content.fontDesign ? buildTrueType(content.fontDesign) : undefined;
}
export function generatedVideoFontURL(
  content: Pick<TimelineContent, 'fontDesign'>,
) {
  const bytes = generatedVideoFont(content);
  if (!bytes) return undefined;
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return 'data:font/ttf;base64,' + btoa(binary);
}
