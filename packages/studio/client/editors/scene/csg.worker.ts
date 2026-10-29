import type { Solid } from '../../../shared/domain.ts';
import { evaluateCad } from './csg.ts';
self.onmessage = (event: MessageEvent<{ solids: Solid[] }>) => {
  try {
    const positions = evaluateCad(event.data.solids);
    self.postMessage(
      { positions },
      { transfer: [positions.buffer as ArrayBuffer] },
    );
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error
          ? error.message
          : 'The solid operation could not be evaluated.',
    });
  }
};
