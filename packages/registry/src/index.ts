/**
 * @ai-bdd/registry — the binding registry and exact matching.
 *
 * Patterns may be Cucumber Expressions (`{string}`, `{int}`, ...), anchored
 * regular expressions, or Gauge `<param>` templates. The registry is the single
 * source of truth for the BindingSet the resolver and the lockfile hash.
 */
export {
  createRegistry,
  LOCAL_PROVIDER,
  type BindingFn,
  type BindingOptions,
  type BindInput,
  type RegistryOptions,
  type BindingRegistry,
  type Registry,
} from './registry.js';
export {
  compilePattern,
  parameterTypeRegistry,
  registerParameterType,
  type CompiledMatch,
  type CompiledPattern,
  type CustomParameterTypeDef,
} from './expressions.js';
export { bind, Given, When, Then, defineParameterType, defaultBindingRegistry } from './global.js';
