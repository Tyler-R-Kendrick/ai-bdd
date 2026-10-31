# Interface and optional execution-proof gates

`check.ts` verifies a narrow set of mathematical statements about code used by Studio. It is intentionally separate from UI screenshots and ordinary tests.

## Exact layout theorem

Let `w` be any real viewport width in `[320,4096]`. The runtime model is:

```text
S(w) = 232 · step(w − 900)
D(w,o) = 340 · step(w − 1280) · o
C(w,o) = w − S(w) − D(w,o)
```

Here `o` is either zero or one, and `step(x)` is one exactly when `x ≥ 0`. The sidebar occupies `[0,S]`, the canvas `[S,w−D]`, and the details panel `[w−D,w]`. Below their allocation breakpoints, navigation/details use overlays and therefore allocate zero column width.

The checker partitions the real domain at both discontinuities and evaluates affine bounds with normalized BigInt rationals. On each region it proves `C ≥ 320`, nonnegative panel widths, adjacent non-overlapping intervals, and complete domain coverage without overlap. Six certificates cover both detail-open values. This is an exact interval proof for the hand-authored model, not a sample of common device widths. No source-to-math compiler is claimed. Runtime rendering must continue to consume the same constants/model; browser tests verify the CSS connection.

The model follows [The Calculus of Interfaces](https://calculus-of-interfaces.vercel.app/) and [handwired](https://github.com/chenglou/handwired): eliminate layout choices into step terms, then reason over the resulting piecewise function. It does not implement differentiable neural-net execution or general JavaScript compilation.

## Finite permission theorem

The checker calls the production `capability` predicate for all nine combinations of the roles `{owner,editor,viewer}` and actions `{read,write,admin}`. It proves that the complete finite domain matches the declared policy. HTTP session validity, membership lookup, database transactions, and WebSocket enforcement are separate implementation concerns covered by integration tests; the permission truth table alone does not prove them.

## Optional Magnetar verifier boundary

The official [Magnetar publication page](https://www.microsoft.com/en-us/research/publication/magnetar-high-speed-post-quantumrv64-zkvm-from-standard-hashes/) and [research article](https://www.microsoft.com/en-us/research/blog/proof-based-general-purpose-computing-with-magnetar/) describe a general-purpose RV64 zero-knowledge virtual machine. The publication page inspected on 2026-10-29 supplied a paper and article, without an operational verifier API adopted by this implementation. Studio ships **no Microsoft Magnetar implementation or production verification guarantee**.

The separate [Magnetar research workflow](../../../.github/workflows/studio-magnetar.yml) builds the pinned independent `open-magnetar` prover/verifier, proves and verifies eight public layout guest executions, and rejects modified proofs and public inputs/outputs. Its [research adapter and limitations](magnetar/README.md) are explicit: this is an unaudited independent implementation, its execution witnesses are not zero knowledge, and its finite guest executions do not prove the whole application.

An operator can supply a verifier adapter through `STUDIO_PROOF_VERIFIER`, an absolute executable path. It must perform real cryptographic verification. Studio invokes it without a shell:

```text
/absolute/verifier-adapter verify --program PROGRAM --input INPUT --output OUTPUT --proof PROOF
```

The adapter must exit successfully and emit exactly this JSON shape, with the digests of the program, public input, output, and proof it actually verified:

```json
{
  "verified": true,
  "system": "magnetar",
  "programSha256": "<64 lowercase hexadecimal characters>",
  "inputSha256": "<64 lowercase hexadecimal characters>",
  "outputSha256": "<64 lowercase hexadecimal characters>",
  "proofSha256": "<64 lowercase hexadecimal characters>"
}
```

`STUDIO_PROOF_RECEIPT` points to a JSON manifest containing `schemaVersion:1`, `system:"magnetar"`, those same digests, and a `proofFile` path relative to the manifest. The path may not leave that directory. `STUDIO_PROOF_PROGRAM`, `STUDIO_PROOF_INPUT`, and `STUDIO_PROOF_OUTPUT` point to the corresponding files. The gate independently hashes every file before calling the verifier, validates its verdict schema, and compares all four digests. Missing inputs, tampering, failure exit codes, malformed output, false verdicts, and mismatched verdict digests fail the gate. The verifier itself is an operator trust anchor; an adapter that merely echoes the manifest is not a verifier.

```sh
STUDIO_REQUIRE_PROOF=1 pnpm --filter @ai-bdd/studio verify
```

When the flag is off, reports explicitly say the external proof was not requested and `verified:false`. Successful hashes or exact layout checks never change that value to true. The protocol tests use an explicitly labeled verifier test double to test process/digest handling; they do not generate a Magnetar proof.
