import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { init, killThreads } from 'z3-solver';
import { Circuit, emitCompare } from '../vendor/handwired/numeric-ui-core.ts';
import { STUDIO_LAYOUT, studioLayout } from './layout.ts';

/** The real upstream Handwired compiler, pinned and distributed with its MIT notice. */
export function compileStudioLayout() {
  const model = STUDIO_LAYOUT;
  const circuit = new Circuit(2),
    width = circuit.source(0),
    open = circuit.source(1);
  circuit.assumeRange(width, model.minViewport, model.maxViewport);
  circuit.assumeGrid(width, 1 / 64);
  circuit.assumeBit(open);
  circuit.assumeGrid(open, 1);
  const navigation = emitCompare(
    circuit,
    width,
    '>=',
    circuit.constant(model.sidebarBreakpoint),
  );
  const details = emitCompare(
    circuit,
    width,
    '>=',
    circuit.constant(model.detailBreakpoint),
  );
  const sidebar = circuit.affine([[navigation, model.sidebarWidth]]);
  const detail = circuit.affine([
    [circuit.multiply(details, open), model.detailWidth],
  ]);
  const canvas = circuit.affine([
    [width, 1],
    [sidebar, -1],
    [detail, -1],
  ]);
  return { circuit, roots: [sidebar, detail, canvas] };
}

export async function proveHandwiredLayout(compiled = compileStudioLayout()) {
  const { circuit, roots } = compiled;
  const upstream = JSON.parse(
    readFileSync(
      new URL('../vendor/handwired/upstream.json', import.meta.url),
      'utf8',
    ),
  );
  const digest = createHash('sha256')
    .update(
      readFileSync(
        new URL('../vendor/handwired/numeric-ui-core.ts', import.meta.url),
      ),
    )
    .digest('hex');
  assert.equal(
    digest,
    upstream.files['numeric-ui-core.ts'],
    'Vendored compiler does not match its pinned upstream digest',
  );
  const api = await init();
  try {
    const context = new api.Context('studio-layout');
    const { Real, Int, Solver, And, Or, If } = context;
    const width = Real.const('width'),
      open = Real.const('detail_open'),
      ticks = Int.const('width_in_64ths');
    const wires = [width, open];
    const affine = (
      terms: readonly (readonly [number, number])[],
      bias: number,
    ) => {
      let result = Real.val(bias).add(0);
      for (const [wire, coefficient] of terms)
        result = result.add(wires[wire]!.mul(coefficient));
      return result;
    };
    for (const operation of circuit.operations) {
      assert(
        ['affine', 'reglu'].includes(operation.kind),
        'Unexpected compiled atom; no unmodeled operation may pass',
      );
      const left = affine(operation.leftTerms, operation.leftBias);
      const gate = affine(operation.gateTerms, operation.gateBias);
      wires.push(
        operation.kind === 'affine'
          ? left
          : left.mul(If(gate.gt(0), gate, Real.val(0))),
      );
    }
    const solver = new Solver();
    solver.set('timeout', 20000);
    solver.add(
      width.ge(STUDIO_LAYOUT.minViewport),
      width.le(STUDIO_LAYOUT.maxViewport),
    );
    solver.add(width.mul(64).eq(ticks), Or(open.eq(0), open.eq(1)));
    const sidebar = wires[roots[0]!]!,
      detail = wires[roots[1]!]!,
      canvas = wires[roots[2]!]!;
    const expectedSidebar = If(
      width.ge(STUDIO_LAYOUT.sidebarBreakpoint),
      Real.val(STUDIO_LAYOUT.sidebarWidth),
      Real.val(0),
    );
    const expectedDetail = If(
      And(width.ge(STUDIO_LAYOUT.detailBreakpoint), open.eq(1)),
      Real.val(STUDIO_LAYOUT.detailWidth),
      Real.val(0),
    );
    solver.add(
      Or(
        sidebar.neq(expectedSidebar),
        detail.neq(expectedDetail),
        canvas.neq(width.sub(sidebar).sub(detail)),
        canvas.lt(STUDIO_LAYOUT.minCanvasWidth),
      ),
    );
    const smtLib = solver.toString();
    const verdict = await solver.check();
    assert.equal(
      verdict,
      'unsat',
      `Compiled layout has a counterexample or incomplete proof: ${verdict === 'sat' ? solver.model().toString() : verdict}`,
    );

    // Verify the actual compiled sparse tensor evaluator, including FP32 rounding,
    // over the complete declared finite lattice, rather than only device samples.
    const evaluate = circuit.createTensorEvaluator(roots);
    const inputs = new Float32Array(2);
    let tensorCases = 0;
    for (
      let tick = STUDIO_LAYOUT.minViewport * 64;
      tick <= STUDIO_LAYOUT.maxViewport * 64;
      tick++
    ) {
      inputs[0] = tick / 64;
      for (const isOpen of [0, 1]) {
        inputs[1] = isOpen;
        const result = evaluate(inputs),
          expected = studioLayout(inputs[0], isOpen === 1);
        assert.deepEqual(
          Array.from(result),
          [expected.sidebarWidth, expected.detailWidth, expected.canvasWidth],
          `Tensor mismatch at ${inputs[0]}, detail=${isOpen}`,
        );
        tensorCases++;
      }
    }
    return {
      scope:
        'Z3 UNSAT proof of the actual Handwired operation graph on the declared 1/64-pixel lattice, plus exhaustive FP32 tensor equivalence. The independent rational checker covers all real widths. Browser text metrics and whole-application execution are outside these theorems.',
      solver: 'Z3',
      verdict,
      upstream: {
        repository: upstream.repository,
        commit: upstream.commit,
        sha256: digest,
      },
      compiledOperations: circuit.operations.length,
      tensorCases,
      quantum: '1/64 pixel',
      smtLib,
    };
  } finally {
    await killThreads(api.em);
  }
}
