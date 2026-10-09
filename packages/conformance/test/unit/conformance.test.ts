import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS } from '@ai-bdd/contracts';
import {
  featureFiles,
  loadCases,
  loadScript,
  runDriverConformance,
  runPluginConformance,
  validateToolPayload,
} from '../../src/index.js';

/**
 * A reference in-process "plugin" written in TypeScript. It consumes the
 * scripted fake daemon responses exactly like a real language plugin would and
 * maps the daemon's `StepResult` to a framework status.
 */
function referencePlugin(featurePath: string): Array<{ text: string; status: string; resolution: string; errorCode?: string }> {
  const script = loadScript();
  const text = readFileSync(featurePath, 'utf8');
  const steps = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(Given|When|Then|And|But|\*)\s/u.test(line))
    .map((line) => line.replace(/^(Given|When|Then|And|But|\*)\s+/u, ''));

  const resolveQueue = [...script.responses.resolve_step];
  const results: Array<{ text: string; status: string; resolution: string; errorCode?: string }> = [];

  for (const stepText of steps) {
    const resolved = resolveQueue.find((entry) => entry.text === stepText);
    if (!resolved) throw new Error(`script.json has no resolve_step response for "${stepText}"`);
    const resolution = (resolved.resolution as { type: string }).type;
    if (resolution === 'exact' || resolution === 'semantic') {
      const response = script.responses.report_binding_result.find((entry) => entry.text === stepText) ?? script.responses.report_binding_result[0]!;
      results.push({ text: stepText, status: String(response.status), resolution });
      continue;
    }
    if (resolution === 'agent') {
      const response = script.responses.run_step.find((entry) => entry.text === stepText);
      if (!response) throw new Error(`script.json has no run_step response for "${stepText}"`);
      const error = response.error as { code: string } | undefined;
      results.push({
        text: stepText,
        status: String(response.status),
        resolution,
        ...(error ? { errorCode: error.code } : {}),
      });
      continue;
    }
    // ambiguous / unbound: the plugin maps the failure to its framework status.
    const message = String((resolved.resolution as { reason: string }).reason);
    results.push({
      text: stepText,
      status: 'failed',
      resolution,
      errorCode: resolution === 'ambiguous' ? 'STEP_AMBIGUOUS' : message === 'setup-unbound' ? 'SETUP_UNBOUND' : 'UNDEFINED',
    });
  }
  return results;
}

runPluginConformance({ run: async (featurePath) => referencePlugin(featurePath) as never });

describe('plugin conformance kit', () => {
  it('ships 20 features with expectations and a script covering every tool', () => {
    expect(featureFiles().length).toBe(20);
    expect(loadCases().length).toBe(20);
    const script = loadScript();
    for (const tool of ['health', 'open_session', 'register_bindings', 'resolve_step', 'run_step', 'report_binding_result', 'close_session']) {
      expect(script.responses[tool], `script.json is missing ${tool}`).toBeDefined();
    }
  });

  it('script responses validate against the checked-in tool schemas', () => {
    const script = loadScript();
    const runStep = TOOL_DEFINITIONS.find((tool) => tool.short === 'run_step')!;
    for (const response of script.responses.run_step) {
      expect(() => runStep.output.parse(response)).not.toThrow();
    }
    const openSession = TOOL_DEFINITIONS.find((tool) => tool.short === 'open_session')!;
    expect(() => openSession.output.parse(script.responses.open_session[0])).not.toThrow();
    const close = TOOL_DEFINITIONS.find((tool) => tool.short === 'close_session')!;
    expect(() => close.output.parse(script.responses.close_session[0])).not.toThrow();
  });

  it('the scripted resolve queue covers exact, semantic, agent, ambiguous and unbound', () => {
    const types = loadScript().responses.resolve_step.map((entry) => (entry.resolution as { type: string }).type);
    expect(new Set(types)).toEqual(new Set(['exact', 'semantic', 'agent', 'ambiguous', 'unbound']));
  });
});

describe('daemon tool schema validation', () => {
  it('rejects unknown fields on every tool input', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(() => validateToolPayload(tool, { unexpected: true }), tool.name).toThrow();
    }
  });

  it('accepts the documented payloads', () => {
    const openSession = TOOL_DEFINITIONS.find((tool) => tool.short === 'open_session')!;
    expect(() =>
      validateToolPayload(openSession, {
        scenarioId: 'scenario-1',
        scenarioName: 'Member upgrades to Pro',
        tags: ['billing'],
        plugin: { name: '@ai-bdd/cucumber', version: '0.1.0', language: 'typescript' },
      }),
    ).not.toThrow();
  });
});

describe('driver conformance suite', () => {
  it('exposes a suite that can be mounted against any driver factory', () => {
    // The suite is exercised for real by driver-fake and driver-playwright; here we only
    // prove the exported surface is a function with the documented signature.
    expect(typeof runDriverConformance).toBe('function');
  });
});
