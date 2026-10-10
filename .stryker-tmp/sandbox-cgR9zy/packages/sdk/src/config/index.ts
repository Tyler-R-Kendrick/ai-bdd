// @ts-nocheck
import type { DefineConfig } from '../contracts/index.ts';

export const defineConfig: DefineConfig = (c) => c;
export { loadConfig, CONFIG_FILE_NAMES } from './load.ts';
export { resolveConfig, MIN_SECRET_LENGTH } from './resolve.ts';
