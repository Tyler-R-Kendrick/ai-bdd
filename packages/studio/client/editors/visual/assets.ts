import type { RenderAssets, VisualContent } from './render.ts';
import { buildTrueType } from './typeface.ts';
import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';

const assetPath = /^\/api\/files\/[0-9a-f-]{36}$/i;
const decoded = new Map<
  string,
  Promise<{ image?: HTMLImageElement; dataUrl: string }>
>();
const loadedFonts = new Set<FontFace>();
let generation = 0;
let interData: Promise<string> | undefined;

export function clearAssetCache(): void {
  generation++;
  decoded.clear();
  for (const font of loadedFonts) document.fonts.delete(font);
  loadedFonts.clear();
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The asset could not be read.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

function imageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timeout = setTimeout(() => {
      image.src = '';
      reject(new Error('Image decoding timed out. Try a smaller image.'));
    }, 15000);
    image.onload = () => {
      clearTimeout(timeout);
      if (
        image.naturalWidth > 16384 ||
        image.naturalHeight > 16384 ||
        image.naturalWidth * image.naturalHeight > 64_000_000
      )
        reject(
          new Error('Image exceeds 64 megapixels. Resize it before importing.'),
        );
      else resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('The browser could not decode this image.'));
    };
    image.src = url;
  });
}

async function load(url: string, kind: 'image' | 'font') {
  if (!assetPath.test(url))
    throw new Error(
      'Artifact assets must come from an authenticated workspace upload.',
    );
  const key = kind + ':' + url;
  let pending = decoded.get(key);
  if (!pending) {
    const currentGeneration = generation;
    pending = (async () => {
      const response = await fetch(url, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      if (!response.ok)
        throw new Error(
          'An artifact asset is unavailable. Check your project access and reload.',
        );
      const mime = response.headers.get('content-type')?.split(';')[0];
      if (
        kind === 'font'
          ? mime !== 'font/woff2'
          : !['image/png', 'image/jpeg', 'image/webp'].includes(mime ?? '')
      )
        throw new Error('The uploaded asset has an unsupported media type.');
      const blob = await response.blob();
      if (blob.size > 10 * 1024 * 1024)
        throw new Error('The asset exceeds the 10 MB upload limit.');
      const encoded = await dataUrl(blob);
      if (kind === 'image')
        return { image: await imageFromUrl(encoded), dataUrl: encoded };
      // A binary FontFace respects the app's self-only font policy without adding a data: source exception.
      const font = new FontFace(
        'ArtifactFont-' + url.split('/').pop(),
        await blob.arrayBuffer(),
      );
      await font.load();
      if (currentGeneration !== generation)
        throw new DOMException('Editor closed', 'AbortError');
      document.fonts.add(font);
      loadedFonts.add(font);
      return { dataUrl: encoded };
    })();
    decoded.set(key, pending);
    // Failed authorization or decode attempts must remain retryable.
    void pending.catch(() => {
      if (decoded.get(key) === pending) decoded.delete(key);
    });
    // Bound decoded resources retained by an editor tab.
    if (decoded.size > 12) decoded.delete(decoded.keys().next().value!);
  }
  return pending;
}

export async function loadAssets(
  content: VisualContent,
  signal?: AbortSignal,
): Promise<RenderAssets> {
  const assets: RenderAssets = { images: new Map(), dataUrls: new Map() };
  if (
    content.fontDesign &&
    content.layers.some((l) => l.fontFamily === 'Generated')
  ) {
    const bytes = buildTrueType(content.fontDesign);
    const font = new FontFace(
      'ArtifactGenerated',
      new Uint8Array(bytes).buffer,
    );
    await font.load();
    if (signal?.aborted)
      throw new DOMException('Export cancelled', 'AbortError');
    for (const loaded of loadedFonts)
      if (loaded.family === 'ArtifactGenerated') {
        document.fonts.delete(loaded);
        loadedFonts.delete(loaded);
      }
    document.fonts.add(font);
    loadedFonts.add(font);
    assets.dataUrls.set(
      'font:Generated',
      await dataUrl(
        new Blob([new Uint8Array(bytes).buffer], { type: 'font/ttf' }),
      ),
    );
  }

  const requests = new Map<string, 'image' | 'font'>();
  for (const layer of content.layers) {
    if (layer.type === 'image' && layer.src) requests.set(layer.src, 'image');
    if (layer.fontFamily === 'Custom' && layer.fontUrl)
      requests.set(layer.fontUrl, 'font');
  }
  for (const [url, kind] of requests) {
    if (signal?.aborted)
      throw new DOMException('Export cancelled', 'AbortError');
    const loaded = await load(url, kind);
    assets.dataUrls.set(url, loaded.dataUrl);
    if (loaded.image) {
      const existing = [...assets.images.values()].reduce(
        (count, image) =>
          count +
          (image as HTMLImageElement).naturalWidth *
            (image as HTMLImageElement).naturalHeight,
        0,
      );
      if (
        existing + loaded.image.naturalWidth * loaded.image.naturalHeight >
        64_000_000
      )
        throw new Error(
          'This composition exceeds the 64 megapixel decoded-image export budget. Resize or remove image layers.',
        );
      assets.images.set(url, loaded.image);
    }
  }
  if (
    content.layers.some(
      (layer) => layer.type === 'text' && layer.fontFamily === 'Inter',
    )
  ) {
    if (!interData)
      interData = fetch(interUrl, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(15000),
      }).then(async (response) => {
        if (!response.ok)
          throw new Error(
            'The built-in Inter font could not be loaded. Reload the editor before exporting.',
          );
        return dataUrl(await response.blob());
      });
    try {
      assets.dataUrls.set('font:Inter', await interData);
    } catch (error) {
      interData = undefined;
      throw error;
    }
  }
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
  return assets;
}

export async function imageDimensions(
  url: string,
): Promise<{ width: number; height: number }> {
  const loaded = await load(url, 'image');
  return {
    width: loaded.image!.naturalWidth,
    height: loaded.image!.naturalHeight,
  };
}
