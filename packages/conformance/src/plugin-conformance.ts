import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StepResult } from '@ai-bdd/contracts';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
export const PLUGIN_KIT_DIR = join(here, '..', 'plugin');

export interface FakeDaemonScript {
  version: 1;
  /** Deterministic responses keyed by tool name, in call order. */
  responses: Record<string, Array<Record<string, unknown>>>;
}

export interface PluginConformanceCase {
  feature: string;
  /** Expected status per step, in order. */
  steps: Array<{ text: string; status: StepResult['status']; errorCode?: string; resolution: string }>;
}

export function loadScript(): FakeDaemonScript {
  return JSON.parse(readFileSync(join(PLUGIN_KIT_DIR, 'script.json'), 'utf8')) as FakeDaemonScript;
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
        const actual = await options.run(join(PLUGIN_KIT_DIR, 'features', testCase.feature));
        expect(actual.map((step) => step.status)).toEqual(testCase.steps.map((step) => step.status));
        expect(actual.map((step) => step.resolution)).toEqual(testCase.steps.map((step) => step.resolution));
        for (const [index, expected] of testCase.steps.entries()) {
          if (expected.errorCode) expect(actual[index]?.errorCode).toBe(expected.errorCode);
        }
      });
    }
  });
}
