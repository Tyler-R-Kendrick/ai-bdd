import type { DefineConfig } from '../contracts/index.ts';

export const defineConfig: DefineConfig = (c) => c;
export { loadConfig, CONFIG_FILE_NAMES } from './load.ts';
export { resolveConfig } from './resolve.ts';
