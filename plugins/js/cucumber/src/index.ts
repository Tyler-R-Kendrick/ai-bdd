/**
 * @ai-bdd/cucumber — the cucumber-js plugin.
 *
 * Minimum glue: one import in your cucumber.js profile.
 *
 * ```ts
 * import { register } from '@ai-bdd/cucumber/register';
 * register();
 * ```
 *
 * Bindings declared with `Given`/`When`/`Then`/`bind` stay in this process; the
 * daemon decides which one wins and asks the plugin to invoke it
 * (`invoke-local`), then records the outcome.
 */
export { register, catchAllPattern, type AiBddWorld, type CucumberApi, type CucumberWorld, type RegisterOptions } from './register.js';
export { bind, Given, Then, When, localBindings, LocalBindings, type StepBindingOptions, type StepFunction } from './registry.js';
export { DaemonClient, DaemonError, type DaemonClientOptions } from './client.js';
