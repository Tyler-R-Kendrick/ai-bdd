# Contracts proposals

A swarm that needs a change to `packages/sdk/src/contracts/index.ts` writes `<swarm-id>.md` here and codes against the current contract with a local adapter. Only X-INTEGRATOR applies accepted proposals.

## Resolved

- `S-RECORDING`: `Recorder.toRecording` takes an optional sixth `opts?: { capabilities?: DriverCapabilities }`; the runner passes `session.capabilities`. Applied to the contract and consumers; proposal file removed.
