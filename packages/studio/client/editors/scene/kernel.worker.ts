import initOpenCascade from 'replicad-opencascadejs';
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { setOC } from 'replicad';
import type { SceneContent } from './model.ts';
import { fetchImport } from './imports.ts';
import { buildExactCad, exactStep, tessellateExactCad } from './kernel.ts';

let initialized: Promise<void> | undefined;
self.onmessage = async (
  event: MessageEvent<{
    id: number;
    content: SceneContent;
    format: 'mesh' | 'step';
  }>,
) => {
  const { id, content, format } = event.data;
  let shape: Awaited<ReturnType<typeof buildExactCad>> = null;
  try {
    initialized ??= initOpenCascade({ locateFile: () => wasmUrl }).then(
      (oc) => {
        setOC(oc);
      },
    );
    await initialized;
    shape = await buildExactCad(content, fetchImport);
    if (format === 'step') {
      if (!shape) throw new Error('Add a solid before exporting STEP.');
      const data = await exactStep(shape, content.unit);
      self.postMessage({ id, data }, { transfer: [data] });
    } else {
      const result = tessellateExactCad(shape);
      self.postMessage(
        { id, ...result },
        { transfer: [result.positions.buffer as ArrayBuffer] },
      );
    }
  } catch (error) {
    self.postMessage({
      id,
      error:
        error instanceof Error
          ? error.message
          : 'The CAD kernel could not evaluate this model.',
    });
  } finally {
    shape?.delete();
  }
};
