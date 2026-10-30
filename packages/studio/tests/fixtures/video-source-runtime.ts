import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { videoHTML } from '../../shared/video-html.ts';
import { newClip } from '../../shared/video-timeline.ts';
import type { TimelineContent } from '../../shared/video.ts';
import { renderVideo } from '../../server/video-renderer.ts';

// Run through the actual development CLI: Vitest's transform does not retain
// esbuild's keepNames helpers, which caused the source-only rendering failure.
const [directory, mode] = process.argv.slice(2);
if (!directory) throw new Error('A fixture output directory is required');
const text = '</script><script>window.__untrusted=true</script>\u2028\u2029';
const content: TimelineContent = {
  width: 129,
  height: 97,
  duration: 1,
  fps: 24,
  background: '#ffffff',
  clips: [
    {
      ...newClip('text', 1, 0),
      id: '00000000-0000-4000-8000-000000000001',
      fontFamily: 'Georgia',
      text,
      x: 0,
      y: 0,
      width: 120,
      height: 90,
      fontSize: 12,
      keyframes: [
        { property: 'x', at: 0, value: 0, easing: 'linear' },
        { property: 'x', at: 1, value: 40, easing: 'linear' },
      ],
    },
  ],
};
if (mode === 'render') {
  for (const format of ['mp4', 'webm'] as const)
    await writeFile(
      join(directory, 'odd.' + format),
      await renderVideo({
        content,
        title: 'Odd-size source-render regression',
        format,
        assets: new Map(),
        signal: AbortSignal.timeout(30000),
      }),
    );
} else {
  for (const renderer of [true, false])
    await writeFile(
      join(directory, renderer ? 'capture.html' : 'portable.html'),
      videoHTML(content, text, { renderer, assets: {} }),
    );
}
