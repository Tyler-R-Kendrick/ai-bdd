import type { Layer as BaseLayer } from '../../../shared/domain.ts';
import {
  pathData,
  grayscaleMatrix,
  filterCss,
  type LayerAppearance,
  type FontDesign,
} from '../../../shared/visual-design.ts';
export type Layer = Omit<BaseLayer, 'type' | 'fontFamily'> &
  LayerAppearance & {
    type: BaseLayer['type'] | 'path';
    fontFamily: BaseLayer['fontFamily'] | 'Generated';
  };

export type VisualContent = {
  width: number;
  height: number;
  background: string;
  layers: Layer[];
  duration: number;
  fontDesign?: FontDesign;
};

export const fontStacks: Record<string, string> = {
  Inter: '"Inter Variable", Inter, sans-serif',
  Georgia: 'Georgia, "Times New Roman", serif',
  monospace: 'ui-monospace, SFMono-Regular, Consolas, monospace',
};

export type RenderAssets = {
  images: Map<string, CanvasImageSource>;
  dataUrls: Map<string, string>;
};
export function layerFont(layer: Layer): string {
  if (layer.fontFamily === 'Generated') return '"ArtifactGenerated"';
  return layer.fontFamily === 'Custom' && layer.fontUrl
    ? `"ArtifactFont-${layer.fontUrl.split('/').pop()}"`
    : (fontStacks[layer.fontFamily] ?? fontStacks.Inter!);
}

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function visibleAt(layer: Layer, time: number): boolean {
  return time >= layer.start && time < layer.start + layer.duration;
}

/** Stable wrapping shared by the SVG editor, SVG export, and video renderer. */
export function wrapText(
  text: string,
  width: number,
  measure: (text: string) => number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next) > width) {
        lines.push(line);
        line = '';
      }
      if (measure(word) <= width) {
        line = line ? `${line} ${word}` : word;
        continue;
      }
      for (const character of word) {
        if (line && measure(line + character) > width) {
          lines.push(line);
          line = '';
        }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function layerLines(
  layer: Layer,
  measure?: (text: string) => number,
): string[] {
  return wrapText(
    layer.text,
    layer.width,
    measure ?? ((text) => [...text].length * layer.fontSize * 0.55),
  );
}

export function newLayer(type: Layer['type'], content: VisualContent): Layer {
  const width = Math.min(content.width * 0.5, 480);
  return {
    id: crypto.randomUUID(),
    type,
    x: Math.round((content.width - width) / 2),
    y: Math.round(content.height * 0.35),
    width,
    height: Math.min(160, content.height * 0.35),
    fill: type === 'text' ? '#24292e' : '#6b73d1',
    text: type === 'text' ? 'Your next idea.' : '',
    fontSize: Math.min(64, content.width / 16),
    fontFamily: 'Inter',
    start: 0,
    duration: content.duration,
    rotation: 0,
  };
}

const xml = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (char) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&apos;',
      })[char]!,
  );

export function svgSource(
  content: VisualContent,
  time?: number,
  measure?: (layer: Layer, text: string) => number,
  assets?: RenderAssets,
): string {
  const layers = content.layers.filter(
    (layer) => time === undefined || visibleAt(layer, time),
  );
  const customFonts = [
    ...new Set(
      layers
        .filter((layer) => layer.fontFamily === 'Custom' && layer.fontUrl)
        .map((layer) => layer.fontUrl!),
    ),
  ]
    .map((url) => {
      const data = assets?.dataUrls.get(url);
      if (!data)
        throw new Error('Load custom font assets before exporting SVG.');
      return `@font-face{font-family:"ArtifactFont-${url.split('/').pop()}";src:url("${data}") format("woff2");}`;
    })
    .join('');
  const inter = assets?.dataUrls.get('font:Inter');
  const generated = assets?.dataUrls.get('font:Generated');
  if (layers.some((l) => l.fontFamily === 'Generated') && !generated)
    throw new Error('Load the designed typeface before exporting SVG.');
  const fonts =
    (generated
      ? `@font-face{font-family:"ArtifactGenerated";src:url("${generated}") format("truetype");}`
      : '') +
    customFonts +
    (inter
      ? `@font-face{font-family:"Inter Variable";src:url("${inter}") format("woff2");font-weight:100 900;}`
      : '');
  const body = layers
    .map((layer) => {
      const shape =
        layer.type === 'image'
          ? (() => {
              const source = layer.src && assets?.dataUrls.get(layer.src);
              if (!source)
                throw new Error('Load image assets before exporting SVG.');
              const crop = layer.crop ?? { x: 0, y: 0, width: 1, height: 1 };
              return `<svg width="${layer.width}" height="${layer.height}" viewBox="${crop.x} ${crop.y} ${crop.width} ${crop.height}" preserveAspectRatio="none" overflow="hidden"><image width="1" height="1" href="${source}" preserveAspectRatio="none"/></svg>`;
            })()
          : layer.type === 'path' && layer.path
            ? `<svg width="${layer.width}" height="${layer.height}" viewBox="0 0 ${layer.path.viewWidth} ${layer.path.viewHeight}" preserveAspectRatio="none"><path d="${pathData(layer.path)}" fill="${layer.path.closed ? layer.fill : 'none'}" stroke="${layer.stroke ?? layer.fill}" stroke-width="${layer.strokeWidth ?? (layer.path.closed ? 0 : 2)}"/></svg>`
            : layer.type === 'rect'
              ? `<rect width="${layer.width}" height="${layer.height}" fill="${layer.fill}" stroke="${layer.stroke ?? layer.fill}" stroke-width="${layer.strokeWidth ?? 0}"/>`
              : layer.type === 'ellipse'
                ? `<ellipse cx="${layer.width / 2}" cy="${layer.height / 2}" rx="${layer.width / 2}" ry="${layer.height / 2}" fill="${layer.fill}" stroke="${layer.stroke ?? layer.fill}" stroke-width="${layer.strokeWidth ?? 0}"/>`
                : `<defs><clipPath id="clip-${layer.id}"><rect width="${layer.width}" height="${layer.height}"/></clipPath></defs><text font-family="${xml(layerFont(layer))}" font-size="${layer.fontSize}" fill="${layer.fill}" clip-path="url(#clip-${layer.id})">${layerLines(
                    layer,
                    measure ? (text) => measure(layer, text) : undefined,
                  )
                    .map(
                      (line, i) =>
                        `<tspan x="0" y="${layer.fontSize * (0.85 + i * 1.2)}">${xml(line)}</tspan>`,
                    )
                    .join('')}</text>`;
      const maskId = `mask-${layer.id}`;
      const mask =
        layer.mask === 'ellipse'
          ? `<ellipse cx="${layer.width / 2}" cy="${layer.height / 2}" rx="${layer.width / 2}" ry="${layer.height / 2}"/>`
          : layer.mask === 'path' && layer.path
            ? `<path d="${pathData(layer.path)}" transform="scale(${layer.width / layer.path.viewWidth} ${layer.height / layer.path.viewHeight})"/>`
            : '';
      const f = layer.filters,
        margin = Math.ceil((f?.blur ?? 0) * 3),
        filterId = maskId + '-filter';
      const filter = f
        ? `<filter id="${filterId}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="${-margin}" y="${-margin}" width="${layer.width + margin * 2}" height="${layer.height + margin * 2}" color-interpolation-filters="sRGB"><feComponentTransfer>${['R', 'G', 'B'].map((channel) => `<feFunc${channel} type="linear" slope="${f.brightness * f.contrast}" intercept="${(1 - f.contrast) / 2}"/>`).join('')}</feComponentTransfer><feColorMatrix type="saturate" values="${f.saturation}"/><feColorMatrix type="matrix" values="${grayscaleMatrix(f.grayscale)}"/><feGaussianBlur stdDeviation="${f.blur}"/></filter>`
        : '';
      return `<g transform="translate(${layer.x} ${layer.y}) rotate(${layer.rotation} ${layer.width / 2} ${layer.height / 2})" opacity="${layer.opacity ?? 1}">${mask || filter ? `<defs>${mask ? `<clipPath id="${maskId}">${mask}</clipPath>` : ''}${filter}</defs>` : ''}<g${mask ? ` clip-path="url(#${maskId})"` : ''}${filter ? ` filter="url(#${filterId})"` : ''}>${shape}</g></g>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${content.width}" height="${content.height}" viewBox="0 0 ${content.width} ${content.height}" role="img"><title>Artifact composition</title>${fonts ? `<style>${fonts}</style>` : ''}<rect width="${content.width}" height="${content.height}" fill="${content.background}"/>${body}</svg>`;
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  content: VisualContent,
  time?: number,
  assets?: RenderAssets,
): void {
  ctx.save();
  ctx.fillStyle = content.background;
  ctx.fillRect(0, 0, content.width, content.height);
  for (const layer of content.layers) {
    if (time !== undefined && !visibleAt(layer, time)) continue;
    ctx.save();
    ctx.translate(layer.x + layer.width / 2, layer.y + layer.height / 2);
    ctx.rotate((layer.rotation * Math.PI) / 180);
    ctx.translate(-layer.width / 2, -layer.height / 2);
    ctx.fillStyle = layer.fill;
    ctx.globalAlpha = layer.opacity ?? 1;
    ctx.filter = filterCss(layer.filters);
    if (layer.mask === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(
        layer.width / 2,
        layer.height / 2,
        layer.width / 2,
        layer.height / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.clip();
    } else if (layer.mask === 'path' && layer.path) {
      ctx.save();
      ctx.scale(
        layer.width / layer.path.viewWidth,
        layer.height / layer.path.viewHeight,
      );
      ctx.clip(new Path2D(pathData(layer.path)));
      ctx.scale(
        layer.path.viewWidth / layer.width,
        layer.path.viewHeight / layer.height,
      );
    }
    ctx.strokeStyle = layer.stroke ?? layer.fill;
    ctx.lineWidth = layer.strokeWidth ?? 0;
    if (layer.type === 'image') {
      const image = layer.src && assets?.images.get(layer.src);
      if (!image)
        throw new Error(
          'An image asset could not be loaded. Reload this artifact before exporting.',
        );
      const crop = layer.crop ?? { x: 0, y: 0, width: 1, height: 1 };
      const source = image as HTMLImageElement;
      const width = source.naturalWidth ?? source.width,
        height = source.naturalHeight ?? source.height;
      ctx.drawImage(
        image,
        crop.x * width,
        crop.y * height,
        crop.width * width,
        crop.height * height,
        0,
        0,
        layer.width,
        layer.height,
      );
    } else if (layer.type === 'path' && layer.path) {
      ctx.save();
      ctx.scale(
        layer.width / layer.path.viewWidth,
        layer.height / layer.path.viewHeight,
      );
      const path = new Path2D(pathData(layer.path));
      if (layer.path.closed) ctx.fill(path);
      if ((layer.strokeWidth ?? (layer.path.closed ? 0 : 2)) > 0) {
        ctx.lineWidth = layer.strokeWidth ?? 2;
        ctx.stroke(path);
      }
      ctx.restore();
    } else if (layer.type === 'rect') {
      ctx.fillRect(0, 0, layer.width, layer.height);
      if ((layer.strokeWidth ?? 0) > 0)
        ctx.strokeRect(0, 0, layer.width, layer.height);
    } else if (layer.type === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(
        layer.width / 2,
        layer.height / 2,
        layer.width / 2,
        layer.height / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      if ((layer.strokeWidth ?? 0) > 0) ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.rect(0, 0, layer.width, layer.height);
      ctx.clip();
      ctx.font = `${layer.fontSize}px ${layerFont(layer)}`;
      ctx.textBaseline = 'alphabetic';
      layerLines(layer, (text) => ctx.measureText(text).width).forEach(
        (line, i) => {
          ctx.fillText(line, 0, layer.fontSize * (0.85 + i * 1.2));
        },
      );
    }
    if (layer.mask === 'path' && layer.path) ctx.restore();
    ctx.restore();
  }
  ctx.restore();
}

/** Hit-independent geometry for a rotated lower-right resize handle. */
export function resized(
  layer: Layer,
  dx: number,
  dy: number,
): Pick<Layer, 'width' | 'height'> {
  const radians = (-layer.rotation * Math.PI) / 180;
  return {
    width: clamp(
      layer.width + dx * Math.cos(radians) - dy * Math.sin(radians),
      1,
      100000,
    ),
    height: clamp(
      layer.height + dx * Math.sin(radians) + dy * Math.cos(radians),
      1,
      100000,
    ),
  };
}

export function timeLabel(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)
    .toString()
    .padStart(
      2,
      '0',
    )}:${(whole % 60).toString().padStart(2, '0')}.${Math.floor((seconds % 1) * 10)}`;
}
