/**
 * @ai-bdd/core — the facade a project imports in `ai-bdd.config.ts` and in its
 * local TypeScript bindings.
 *
 * ```ts
 * import { defineConfig } from '@ai-bdd/core';
 * import { playwright } from '@ai-bdd/driver-playwright';
 *
 * export default defineConfig({ drivers: { web: playwright({ browser: 'chromium' }) } });
 * ```
 */
export { defineConfig } from '@ai-bdd/runtime';
export type {
  AiBddConfig,
  DriverConfig,
  ResolvedConfig,
  ReporterName,
  SecretDecl,
} from '@ai-bdd/contracts';

// Local binding API: the same functions a Cucumber-flavoured project already knows.
export {
  bind,
  defineParameterType,
  Given,
  LOCAL_PROVIDER,
  Then,
  When,
  type BindInput,
  type BindingFn,
  type BindingOptions,
  type Registry,
} from '@ai-bdd/registry';

export type * from '@ai-bdd/contracts';
