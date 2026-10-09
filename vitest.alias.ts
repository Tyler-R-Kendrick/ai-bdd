import { fileURLToPath } from 'node:url';

function src(pkg: string, file = 'index'): string {
  return fileURLToPath(new URL(`./packages/${pkg}/src/${file}.ts`, import.meta.url));
}

/**
 * Test-time module resolution: every `@ai-bdd/*` specifier resolves to the
 * TypeScript source of the package, so tests never require a prior build.
 * Order matters: longer subpath specifiers must come first.
 */
export const alias: Record<string, string> = {
  '@ai-bdd/models/fake': src('models', 'fake'),
  '@ai-bdd/contracts/helpers': src('contracts', 'helpers'),
  '@ai-bdd/contracts': src('contracts'),
  '@ai-bdd/spec-gauge': src('spec-gauge'),
  '@ai-bdd/spec-gherkin': src('spec-gherkin'),
  '@ai-bdd/spec-directives': src('spec-directives'),
  '@ai-bdd/registry': src('registry'),
  '@ai-bdd/semantic': src('semantic'),
  '@ai-bdd/lock': src('lock'),
  '@ai-bdd/cache': src('cache'),
  '@ai-bdd/models': src('models'),
  '@ai-bdd/evidence': src('evidence'),
  '@ai-bdd/judge': src('judge'),
  '@ai-bdd/assert': src('assert'),
  '@ai-bdd/act': src('act'),
  '@ai-bdd/driver-fake': src('driver-fake'),
  '@ai-bdd/driver-playwright': src('driver-playwright'),
  '@ai-bdd/driver-e2e': src('driver-e2e'),
  '@ai-bdd/driver-cua': src('driver-cua'),
  '@ai-bdd/runtime': src('runtime'),
  '@ai-bdd/daemon': src('daemon'),
  '@ai-bdd/reporters': src('reporters'),
  '@ai-bdd/codegen': src('codegen'),
  '@ai-bdd/conformance': src('conformance'),
  '@ai-bdd/core': src('core'),
  '@ai-bdd/cli': src('cli'),
};
