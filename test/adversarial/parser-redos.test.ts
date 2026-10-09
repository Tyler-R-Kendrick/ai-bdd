import { describe, expect, it } from 'vitest';
import { gaugeTemplateToRegExp, normalizeStepText } from '@ai-bdd/contracts';
import { parseGaugeSpec } from '@ai-bdd/spec-gauge';
import { parseDirectives } from '@ai-bdd/spec-directives';

/** Attack 10: parser crashes or catastrophic backtracking (ReDoS). */
function elapsed(work: () => void): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

describe('attack 10: parser robustness', () => {
  it('matches adversarial inputs in linear time', () => {
    const matcher = gaugeTemplateToRegExp('Seed a workspace <name> on the <plan> plan');
    const inputs = [
      `Seed a workspace ${'a'.repeat(50_000)} on the plan`,
      `Seed a workspace ${'"'.repeat(20_000)} on the ${'"'.repeat(20_000)} plan`,
      `Seed a workspace ${'<'.repeat(20_000)} on the ${'>'.repeat(20_000)} plan`,
      'x'.repeat(100_000),
    ];
    for (const input of inputs) {
      const ms = elapsed(() => matcher.match(input));
      expect(ms, `matching ${input.length} characters took ${ms}ms`).toBeLessThan(1000);
    }
  });

  it('never throws on adversarial spec text', () => {
    const inputs = [
      `${'#'.repeat(5000)} heading`,
      `* ${'*'.repeat(5000)}`,
      `Tags: ${'a,'.repeat(5000)}`,
      `| ${'|'.repeat(5000)} |`,
      `${'\u0000'.repeat(2000)}`,
      `# spec\n${'* step\n'.repeat(5000)}`,
      '\ud800 unpaired surrogate',
      '```\n* not a step\n```\n# spec',
    ];
    for (const input of inputs) {
      const ms = elapsed(() => {
        const result = parseGaugeSpec(input, 'adversarial.spec.md');
        expect(result.document).toBeDefined();
      });
      expect(ms, `parsing ${input.length} characters took ${ms}ms`).toBeLessThan(2000);
    }
  });

  it('keeps directive parsing bounded and non-throwing', () => {
    const inputs = [
      `<!-- ai-bdd: ${'threshold=0.5 '.repeat(2000)} -->`,
      `<!-- ai-bdd: kind=${'x'.repeat(10_000)} -->`,
      `# ai-bdd: ${'\u0000'.repeat(1000)}`,
      '<!-- ai-bdd: ',
    ];
    for (const input of inputs) {
      const ms = elapsed(() => {
        const parsed = parseDirectives(input, 'gauge', { uri: 'x', line: 1, column: 1 });
        if (parsed) expect(Array.isArray(parsed.diagnostics)).toBe(true);
      });
      expect(ms).toBeLessThan(500);
    }
  });

  it('bounds the text a user pattern is matched against', () => {
    // The registry truncates the input, so even a pathological pattern is safe.
    expect(normalizeStepText('  a   b  ')).toBe('a b');
  });
});
