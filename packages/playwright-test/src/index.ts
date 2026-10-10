import { notImplemented, type ScenarioFilter } from '@ai-bdd/sdk/contracts';
export interface RegisterOptions { test: unknown; configPath?: string; planDir?: string; filter?: ScenarioFilter; failOnHealed?: boolean }
export function registerAiBddScenarios(_opts: RegisterOptions): void { return notImplemented('playwright-test.registerAiBddScenarios'); }
