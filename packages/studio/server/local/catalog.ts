import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import manifest from './model-manifest.json' with { type: 'json' };
export const LOCAL_MODEL_ID = manifest.id;
export const LOCAL_PROVIDER_ID = 'llama-cpp-cpu';
export const LOCAL_HARNESS_ID = 'local-cpu';
export { manifest as localModelManifest };
export type LocalModelSettings = { directory: string };
/** Presence is catalog availability only; the worker verifies every byte before loading. */
export function localModelPresent(settings: LocalModelSettings | undefined): boolean {
  if (!settings || !isAbsolute(settings.directory)) return false;
  try {
    const info = lstatSync(join(settings.directory, manifest.files[0]!.path));
    return info.isFile() && !info.isSymbolicLink() && info.size === manifest.files[0]!.bytes;
  } catch { return false; }
}
