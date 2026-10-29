# Pinned Handwired compiler

`numeric-ui-core.ts` is an unmodified copy of Cheng Lou's MIT-licensed Handwired
runtime at commit `257856e3b221140acb4cc4460626b850c0bd4ff1`. The adjacent license
and `upstream.json` record its origin and SHA-256. It has no downloaded build step.

Studio's verification pipeline builds a real circuit with `Circuit` and
`emitCompare`, proves the resulting operation graph with Z3, and runs its sparse
FP32 tensor evaluator on all 483,330 viewport/detail inputs on the declared
1/64-pixel grid. This does not pretend that a sampled screen or a source digest
proves browser rendering or the entire application. The separate rational
interval checker retains its continuous real-width theorem.

Source: https://github.com/chenglou/handwired/blob/257856e3b221140acb4cc4460626b850c0bd4ff1/src/runtime/numeric-ui-core.ts
