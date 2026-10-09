import { readFileSync, readdirSync } from 'node:fs';
import { loadScript } from './fake-daemon.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StepResult } from '@ai-bdd/contracts';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
export const PLUGIN_KIT_DIR = join(here, '..', 'plugin');

import type { FakeDaemonScript } from './fake-daemon.js';
export type { FakeDaemonScript };

export interface PluginConformanceCase {
  feature: string;
  /** Expected status per step, in order. */
  steps: Array<{ text: string; status: StepResult['status']; errorCode?: string; resolution: string }>;
}

export { loadScript };

export type StatusAliases = Record<string, string[]>;

/** The alias table shared by every plugin: expected status -> accepted spellings. */
export function loadStatusAliases(): StatusAliases {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_KIT_DIR, 'status-aliases.json'), 'utf8')) as StatusAliases;
  } catch {
    return {};
  }
}

/** True when `actual` is an accepted spelling of `expected` for this framework. */
export function statusMatches(expected: string, actual: string, aliases: StatusAliases = loadStatusAliases()): boolean {
  if (expected === actual) return true;
  return (aliases[expected] ?? []).includes(actual);
}

export function loadCases(): PluginConformanceCase[] {
  const dir = join(PLUGIN_KIT_DIR, 'expected');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as PluginConformanceCase);
}

export function featureFiles(): string[] {
  const dir = join(PLUGIN_KIT_DIR, 'features');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.feature'))
    .sort()
    .map((file) => join(dir, file));
}

/**
 * The plugin conformance kit (WP-I1b): >= 20 feature files, a scripted fake
 * daemon and the expected result tables. A plugin runs this against
 * `ai-bdd serve --fake` (or its own HTTP client) and compares the mapped
 * statuses.
 */
export function runPluginConformance(options: {
  /** Executes one feature file and returns the per-step results in order. */
  run: (featurePath: string) => Promise<Array<Pick<StepResult, 'text' | 'status' | 'resolution'> & { errorCode?: string }>>;
}): void {
  const cases = loadCases();
  describe('plugin conformance', () => {
    it('ships at least 20 feature files and matching expectations', () => {
      expect(featureFiles().length).toBeGreaterThanOrEqual(20);
      expect(cases.length).toBe(featureFiles().length);
    });

    it('the scripted fake daemon covers every tool the plugins call', () => {
      const script = loadScript();
      for (const tool of ['health', 'open_session', 'register_bindings', 'resolve_step', 'run_step', 'report_binding_result', 'close_session']) {
        expect(script.responses[tool], `script.json is missing ${tool}`).toBeDefined();
      }
    });

    for (const testCase of cases) {
      it(`${testCase.feature}: maps daemon results to framework statuses`, async () => {
        const aliases = loadStatusAliases();
        const actual = await options.run(join(PLUGIN_KIT_DIR, 'features', testCase.feature));
        for (const [index, expected] of testCase.steps.entries()) {
          expect(
            statusMatches(expected.status, actual[index]?.status ?? 'missing', aliases),
            `${testCase.feature} step ${index}: expected ${expected.status}, got ${actual[index]?.status}`,
          ).toBe(true);
        }
        expect(actual.map((step) => step.resolution)).toEqual(testCase.steps.map((step) => step.resolution));
        for (const [index, expected] of testCase.steps.entries()) {
          if (expected.errorCode) expect(actual[index]?.errorCode).toBe(expected.errorCode);
        }
      });
    }
  });
}
