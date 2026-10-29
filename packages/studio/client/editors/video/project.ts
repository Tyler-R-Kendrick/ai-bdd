import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import { normalizeVideo, type TimelineContent } from '../../../shared/video.ts';
import { videoHTML, type VideoAssetMap } from '../../../shared/video-html.ts';
import { api } from '../../lib.ts';
const assetURL = /^\/api\/files\/[0-9a-f-]{36}$/i;
export async function videoProject(
  content: TimelineContent,
  title: string,
): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const assets: VideoAssetMap = {},
    manifest: Record<string, string> = {};
  const refs = new Set(
    content.clips.flatMap((clip) =>
      [clip.src, clip.fontUrl].filter((url): url is string => !!url),
    ),
  );
  let total = 0;
  for (const url of refs) {
    if (!assetURL.test(url))
      throw new Error(
        'Composition assets must be authenticated project uploads.',
      );
    const response = await fetch(url, {
      credentials: 'same-origin',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(
        'A composition asset is unavailable. Check project access and retry.',
      );
    const mime = response.headers.get('content-type')?.split(';')[0] ?? '';
    const bytes = new Uint8Array(await response.arrayBuffer());
    total += bytes.length;
    if (total > 128 * 1024 * 1024)
      throw new Error(
        'Portable video projects are limited to 128 MB of media.',
      );
    const extensions: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'font/woff2': 'woff2',
      'audio/wav': 'wav',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'audio/webm': 'webm',
      'video/webm': 'webm',
      'video/mp4': 'mp4',
    };
    const path =
      'assets/' + url.split('/').pop() + '.' + (extensions[mime] ?? 'bin');
    files[path] = bytes;
    assets[url] = { url: path, mime };
    manifest[url] = path;
  }
  const fontResponse = await fetch(interUrl, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15000),
  });
  if (!fontResponse.ok)
    throw new Error(
      'The built-in font is unavailable. Reload before exporting.',
    );
  files['assets/inter.woff2'] = new Uint8Array(
    await fontResponse.arrayBuffer(),
  );
  files['index.html'] = strToU8(
    videoHTML(content, title, { assets, interFont: 'assets/inter.woff2' }),
  );
  files['studio.json'] = strToU8(
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: 'ai-bdd-video',
        title,
        content,
        assets: manifest,
      },
      null,
      2,
    ),
  );
  files['README.md'] = strToU8(
    `# ${title.replace(/[\r\n]/g, ' ')}\n\nOpen this directory with HyperFrames. The index.html uses documented composition/clip data attributes, local assets, and a registered native seek/pause timeline adapter. Run HyperFrames lint, validate, and render from this directory.\n\nImport this ZIP into ai-bdd Studio to retain the full editable timeline, trim offsets, and keyframes. The native timeline uses the HyperFrames direct-adapter contract (duration/time/seek/play/pause). It bundles no GSAP code. Audio gain automation remains in studio.json; HyperFrames clip volume attributes carry the base gain. No untrusted HTML or JavaScript is executed when reimporting.\n`,
  );
  return zipSync(files, { level: 0 });
}
export async function importVideoProject(
  file: File,
  artifactId: string,
): Promise<TimelineContent> {
  if (file.size > 128 * 1024 * 1024)
    throw new Error('Video project archives are limited to 128 MB.');
  let total = 0;
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (entry) => {
      if (
        entry.name !== 'studio.json' &&
        !/^assets\/[a-zA-Z0-9_.-]+$/.test(entry.name)
      )
        return false;
      total += entry.originalSize;
      if (entry.originalSize > 10 * 1024 * 1024 || total > 128 * 1024 * 1024)
        throw new Error(
          'An imported asset exceeds the 10 MB limit or archive exceeds 128 MB.',
        );
      return true;
    },
  });
  if (!files['studio.json'])
    throw new Error(
      'This archive has no editable Studio video manifest. Export the original project from Studio first.',
    );
  if (files['studio.json'].length > 2 * 1024 * 1024)
    throw new Error('The project manifest exceeds its 2 MB limit.');
  const manifest = JSON.parse(strFromU8(files['studio.json']));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== 'ai-bdd-video' ||
    !manifest.assets ||
    typeof manifest.assets !== 'object'
  )
    throw new Error('Unsupported Studio video project format.');
  const content = normalizeVideo(manifest.content);
  const refs = new Set(
    content.clips.flatMap((clip) =>
      [clip.src, clip.fontUrl].filter((url): url is string => !!url),
    ),
  );
  if (refs.size > 64)
    throw new Error('A video project may import at most 64 assets.');
  const imported = new Map<string, string>();
  for (const url of refs) {
    const path = manifest.assets[url];
    if (
      typeof path !== 'string' ||
      !/^assets\/[a-zA-Z0-9_.-]+$/.test(path) ||
      !files[path]
    )
      throw new Error('A referenced project asset is missing.');
    const body = new FormData();
    body.append(
      'file',
      new Blob([files[path] as Uint8Array<ArrayBuffer>]),
      path.split('/').pop(),
    );
    const result = await api(`/artifacts/${artifactId}/files`, 'POST', body);
    imported.set(url, result.url);
  }
  return {
    ...content,
    clips: content.clips.map((clip) => ({
      ...clip,
      ...(clip.src ? { src: imported.get(clip.src)! } : {}),
      ...(clip.fontUrl ? { fontUrl: imported.get(clip.fontUrl)! } : {}),
    })),
  };
}
