# S-RECORDING integration notes

## recording (`packages/sdk/src/recording/`)

Public exports (via `recording/index.ts`): `deriveSelector`, `findBySelector`, `computeEffect`, `createRecorder`, `createRecordingStore`, plus helpers `landmarkHash`, `recordingPath`, `ScenarioRecordingSchema`, types `RecorderDeps`, `ToRecordingOptions`, `CapabilityAwareRecorder`.

### Selectors
- `deriveSelector(node, obs)`: `ancestors` are the nearest named ancestors (max 3, nearest first, unnamed skipped); parents are resolved through `parentRef`, falling back to `depth` in document order. `name` is stored `normalizeText`-ed. `of`/`index` are computed with exactly the matching rule of `findBySelector`, so `findBySelector(deriveSelector(n, o), o)` returns `n` for every node, duplicates included (R-CH7, property-tested).
- `findBySelector`: missing / ambiguous (`c !== of`) / found. Ancestors match as an ordered subsequence of the live named-ancestor chain. An out-of-range `index` yields `missing`.

### Effects
- Node key = `{role, normalizeText(name)}`. Unnamed nodes are ignored (no addressable identity).
- `changed` tracks `value` and the states `checked, disabled, expanded, invalid, pressed, selected` only. `focused` and `busy` are deliberately NOT tracked (focus moves on any click; counting it would make a no-op click look effective). Unset states count as `false`, unset values as `''`.
- Exclusions: names/values matching a volatile pattern (local copy in `recording/volatile.ts`, S-ASSERT owns the shared one: keep them in sync) and, when `afterProbe` is given, anything not holding identically in it.
- Output arrays are sorted (role, name, state), so recordings are byte-deterministic.

### Recorder
- `toRecording`: actions with `outcome.ok === false` are not recorded. A fill/select literal equal (after `normalizeText`) to a step param value becomes `{param}` (params checked in sorted key order); `{secret}` stays; others stay `{literal}`.
- Fuzzy reasons: `coordinate-action` (target role or name empty, or target unresolvable), `no-observable-effect` (empty effect and unchanged route), `agent-only-driver` (needs capabilities, see `contracts-proposals/S-RECORDING.md`; never emitted when capabilities are unknown).
- `replay`: settles via the injected `Settler` using `config.settle` (`quietMs/intervalMs/timeoutMs`, defaults 300/100/5000). The first action reuses the `before` observation; each later action uses the observation settled after the previous action. Outcome mapping: start route/landmark mismatch -> `start-mismatch`; `findBySelector` missing/ambiguous -> `target-missing`/`target-ambiguous`; off-policy navigate or denied verb -> `policy-denied` (nothing performed); `!ok` or a thrown driver error -> `action-failed` (`ABORTED` is rethrown); effect check failure -> `effect-unverified`. `completedActions` counts performed actions; `detail` is a human-readable reason.
- Effect verification (R-CH7): every recorded appeared key present, disappeared absent, each changed element unique with its `to` value, `routeAfter` equal, and at least one recorded element newly true (did not hold in `before`; a route change counts as one). An empty recorded effect never verifies.
- A replay does not check `settled`; the runner decides about unsettled screens.

### Store
- Path `${dir}/${driverId}/${scenarioId}.json`; `/` in the scenario id becomes a directory separator. Every segment must match `[a-z0-9._-]+` and not be all dots, otherwise `POLICY_DENIED`.
- `load`: `off` -> `null`; missing -> `null`; invalid JSON/schema, `schemaVersion != 1`, or id/driver mismatching the path -> `RECORDING_CORRUPT`.
- `save`: any mode other than `read-write` (including `off`) throws `RECORDING_READ_ONLY` before touching the filesystem. Serialization is `stableJson` of the zod-parsed value; byte-identical content returns `unchanged` and does not rewrite. Schema-invalid input throws `RECORDING_CORRUPT`.
- `remove` follows the same read-write requirement and prunes now-empty directories. `list` is sorted and returns `[]` in `off` mode.

### Dependencies / VERIFY
- No new dependencies (zod `z.json()` from 4.6.5 is used). No VERIFY items.
