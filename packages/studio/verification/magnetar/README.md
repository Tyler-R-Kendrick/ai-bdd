# Magnetar research pipeline

The pinned **independent** `Lulzx/open-magnetar` implementation recreates the
Microsoft research paper's hash-based RV64I execution-proof construction. It is
not Microsoft's code, has not been independently audited, and is not shipped as
a production trust guarantee. Its execution witnesses are not zero knowledge.
Only public synthetic inputs may enter this experiment.

Upstream offers MIT or Apache-2.0. The public evidence guest contains its small
guest runtime under the [retained MIT notice](UPSTREAM-LICENSE-MIT.txt).

The workflow verifies the public source archive checksum, builds the real Rust
prover/verifier, generates a C guest from Studio's shared layout constants,
compiles it to RV64I, and proves/verifies eight public boundary executions with
the real `ligerito`, `provable-120`, SHA-384 profile. It independently parses the
public instance and compares its exact input/output to the native layout
function. Modified proofs and modified public inputs/outputs must fail the
cryptographic verifier. It never uses
the project's mock/test PCS profile.

The report includes the source commit, binary/program/model digests, execution
cycles, proof sizes, and rejection results. This is evidence about these guest
executions, not a universal proof of the JavaScript application or browser.
The ordinary release gate separately proves continuous shell allocation with
exact rationals and the actual Handwired graph with Z3.

The executable `adapter.mjs` implements Studio's external-verifier protocol.
Set `STUDIO_OPEN_MAGNETAR_CLI` and `STUDIO_OPEN_MAGNETAR_BINARY_SHA256` to an
operator-reviewed build. The adapter refuses a different profile/commit, checks
the explicit public input/output, recomputes the verifying key from the supplied
program, and calls the actual cryptographic verifier. Its success is never
inferred from digests. Missing or failed verification keeps the gate closed.

The `execution-proof.json`, `execution.output`, selected `.input`, `receipt.json`
and guest ELF produced by the experiment can be passed to the existing
`STUDIO_REQUIRE_PROOF=1` gate with this adapter. Enabling that optional research
path is an operator decision; it does not turn an unaudited implementation into
a production security certification.

Sources: [paper](https://eprint.iacr.org/2026/2423),
[Microsoft article](https://www.microsoft.com/en-us/research/blog/proof-based-general-purpose-computing-with-magnetar/),
[independent source](https://github.com/Lulzx/open-magnetar/tree/febfc0e66f5809e034dd1afac78202bd4882de27).
