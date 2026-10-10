# S-RECORDING contract proposal

## `Recorder.toRecording` needs driver capabilities for `agent-only-driver`

SPEC 10.2 says the fuzzy reason `agent-only-driver` applies when "the driver lacks `select` or the needed verbs for replay". `Recorder.toRecording(performed, before, after, afterProbe, step)` and `CreateRecorder`'s deps (`{ settler, config }`) carry no driver capabilities, so the reason cannot be derived from the contract alone.

Local adapter (already implemented, contract-compatible): the recorder accepts the capabilities in two optional ways.

- `createRecorder({ settler, config, capabilities })` (a per-session recorder);
- `recorder.toRecording(performed, before, after, afterProbe, step, { capabilities })` (a sixth, optional argument).

`createRecorder` returns `CapabilityAwareRecorder` (exported from `recording/index.ts`), which extends `Recorder`, so it is assignable to the frozen type.

Proposal: add `opts?: { capabilities?: DriverCapabilities }` as the sixth parameter of `Recorder.toRecording`, and have the runner pass `session.capabilities`. Until then, if the runner does not pass capabilities, `agent-only-driver` is simply never emitted (no false positives).
