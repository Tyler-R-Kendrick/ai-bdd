import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import manifest from './model-manifest.json' with { type: 'json' };
export const LOCAL_MODELS = [manifest, ...manifest.alternatives];
// Chat/function compatibility does not qualify native option-likelihood decisions.
export const LOCAL_DECISION_MODELS = LOCAL_MODELS.filter(model => model.nativeDecisions);
export const DEFAULT_LOCAL_MODEL_ID = manifest.id;
export const LOCAL_MODEL_ID = DEFAULT_LOCAL_MODEL_ID;
export const LOCAL_PROVIDER_ID = 'llama-cpp-cpu';
export const LOCAL_HARNESS_ID = 'local-cpu';
export { manifest as localModelManifest };
export type LocalModelSettings = { directory: string; modelId?: string };
export function localModelById(modelId = DEFAULT_LOCAL_MODEL_ID) {
  return LOCAL_MODELS.find((model) => model.id === modelId);
}
export function localModelFingerprint(
  modelId = DEFAULT_LOCAL_MODEL_ID,
): string {
  const model = localModelById(modelId);
  if (!model) throw new Error('Choose an operator-registered local model');
  return [
    'local-native-v1',
    model.id,
    model.runtime,
    model.files[0]!.sha256,
  ].join(':');
}
/** Presence is catalog availability only; the child verifies every byte before loading. */
export function localModelPresent(
  settings: LocalModelSettings | undefined,
  modelId = settings?.modelId ?? DEFAULT_LOCAL_MODEL_ID,
): boolean {
  const model = localModelById(modelId);
  if (!settings || !isAbsolute(settings.directory) || !model) return false;
  try {
    const info = lstatSync(join(settings.directory, model.files[0]!.path));
    return (
      info.isFile() &&
      !info.isSymbolicLink() &&
      info.size === model.files[0]!.bytes
    );
  } catch {
    return false;
  }
}
