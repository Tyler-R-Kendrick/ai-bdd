import { hkdfSync } from 'node:crypto';
import { isAbsolute } from 'node:path';

export type ManagedT3Settings = {
  readonly toolsDirectory: string;
  readonly stateDirectory?: string;
  /** Server-only checkpoint encryption key; never serialized in capability views. */
  readonly key: Uint8Array;
};

/** Operator configuration only. Artifact/profile content cannot select executables or credentials. */
export function managedT3SettingsFromEnv(
  env: NodeJS.ProcessEnv,
  localModelConfigured: boolean,
): ManagedT3Settings | undefined {
  const toolsDirectory = env.STUDIO_T3_MANAGED_TOOLS_DIR;
  const stateDirectory = env.STUDIO_T3_MANAGED_STATE_DIR;
  if (toolsDirectory && !isAbsolute(toolsDirectory))
    throw new Error('STUDIO_T3_MANAGED_TOOLS_DIR must be an absolute operator directory');
  if (stateDirectory && !isAbsolute(stateDirectory))
    throw new Error('STUDIO_T3_MANAGED_STATE_DIR must be an absolute operator directory');
  const secret = env.STUDIO_T3_STATE_KEY ?? env.STUDIO_JOB_SECRET;
  // Missing optional AI configuration must not prevent authenticated document authoring.
  if (!toolsDirectory || !localModelConfigured || !secret) return undefined;
  if (secret.length < 32)
    throw new Error('The managed T3 checkpoint secret must contain at least32 characters');
  const settings = {
    toolsDirectory,
    ...(stateDirectory ? { stateDirectory } : {}),
  } as ManagedT3Settings;
  Object.defineProperty(settings, 'key', {
    value: new Uint8Array(hkdfSync(
      'sha256', secret, 'ai-bdd-studio', 'managed-t3-checkpoints-v1', 32,
    )),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(settings);
}
