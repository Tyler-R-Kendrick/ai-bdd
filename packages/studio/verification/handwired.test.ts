import { describe, expect, it } from 'vitest';
import { compileStudioLayout, proveHandwiredLayout } from './handwired.ts';

describe('Actual Handwired compiler and Z3 interface proof', () => {
  it('proves the compiled graph and exhaustively checks its FP32 tensor program', async () => {
    const report = await proveHandwiredLayout();
    expect(report.verdict).toBe('unsat');
    expect(report.compiledOperations).toBeGreaterThan(0);
    expect(report.tensorCases).toBe(483330);
  }, 45000);
  it('rejects a changed compiled output instead of proving only a disconnected model', async () => {
    const compiled = compileStudioLayout();
    compiled.circuit.operations.at(-1)!.leftBias = 1;
    await expect(proveHandwiredLayout(compiled)).rejects.toThrow(
      'counterexample',
    );
  }, 45000);
});
