# FIX-C integration notes

1. `packages/sdk/src/engine/core.ts` (not owned by fix-agent C): `createRecorder({ settler, config })` could also pass
   `redactor: this.redactor()` and `secretValue`. `RecorderDeps` now accepts both optionally and scrubs secrets at record
   time (literal equal to a secret becomes `{secret: name}`; effect entries / selector names holding a secret variant are
   dropped or redacted). The runner scrubs again with `deps.redactor` and `deps.secretValue`, so correctness does not depend
   on this wiring; it is defense in depth only.
2. `runner/secrets.ts` is a deliberate copy of `recording/secrets.ts` (modules may not import siblings). If a shared home
   is wanted, move it to `util` (owned by fix-agent B) and delete both copies.
3. `Recorder.replay` now returns an extra `beforeSettled: boolean` (structurally an extension of `ReplayResult`); the runner
   reads it when present. Adding `beforeSettled?: boolean` to the `ReplayResult` contract would make this official.
