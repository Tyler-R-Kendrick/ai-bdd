import manifest from './model-manifest.json' with { type: 'json' };

export const LOCAL_DEFAULT_RSS_BYTES = 1073741824;
export const LOCAL_MAX_RSS_BYTES = 1610612736;
const minimumRssBytes = 16777216;
const invalid = () => new Error('Invalid registered local model resource configuration');
const resources = new Map();
for (const model of [manifest, ...manifest.alternatives]) {
  const ceiling = model.workerRssCeilingBytes ?? LOCAL_DEFAULT_RSS_BYTES;
  const useMmap = model.useMmap === undefined ? false : model.useMmap;
  const file = model.files[0];
  if (typeof model.id !== 'string' || resources.has(model.id) || !file ||
    typeof file.path !== 'string' || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 ||
    typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) ||
    !Number.isSafeInteger(ceiling) || ceiling < minimumRssBytes || ceiling > LOCAL_MAX_RSS_BYTES || typeof useMmap !== 'boolean') throw invalid();
  resources.set(model.id, Object.freeze({ modelId: model.id, file: Object.freeze({ ...file }), rssCeilingBytes: ceiling, useMmap }));
}

/** Registered source data only; callers cannot supply a larger resource budget. */
export function localModelResources(modelId) {
  const value = resources.get(modelId);
  if (!value) throw invalid();
  return value;
}

/** The private IPC boundary may lower a model's ceiling, but never raise it. */
export function workerResourceConfiguration(modelId, configuration) {
  const registered = localModelResources(modelId);
  const file = configuration?.file;
  const ceiling = configuration?.rssCeilingBytes;
  if (typeof configuration?.directory !== 'string' || !configuration.directory.startsWith('/') ||
    !file || file.path !== registered.file.path || file.bytes !== registered.file.bytes || file.sha256 !== registered.file.sha256 ||
    !Number.isSafeInteger(ceiling) || ceiling < minimumRssBytes || ceiling > registered.rssCeilingBytes ||
    typeof configuration.useMmap !== 'boolean' || configuration.useMmap !== registered.useMmap) throw invalid();
  return Object.freeze({ ...registered, directory: configuration.directory, rssCeilingBytes: ceiling });
}
