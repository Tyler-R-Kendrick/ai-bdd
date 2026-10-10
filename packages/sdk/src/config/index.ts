import { notImplemented, type DefineConfig, type LoadConfig, type ResolveConfig } from '../contracts/index.ts';
export const defineConfig: DefineConfig = (c) => c;
export const loadConfig: LoadConfig = () => notImplemented('config.loadConfig');
export const resolveConfig: ResolveConfig = () => notImplemented('config.resolveConfig');
