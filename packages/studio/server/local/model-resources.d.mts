export const LOCAL_DEFAULT_RSS_BYTES: number;
export const LOCAL_MAX_RSS_BYTES: number;
export type LocalModelResources = Readonly<{
  modelId: string;
  file: Readonly<{ path: string; bytes: number; sha256: string }>;
  rssCeilingBytes: number;
}>;
export function localModelResources(modelId: string): LocalModelResources;
export function workerResourceConfiguration(modelId: unknown, configuration: unknown): LocalModelResources & Readonly<{ directory: string }>;
