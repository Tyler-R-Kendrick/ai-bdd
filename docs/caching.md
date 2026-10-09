# Caching and invalidation

Caches live under `.ai-bdd/cache/`:

```
.ai-bdd/cache/act/<key>.json          committed by default
.ai-bdd/cache/check/<key>.json        committed by default
.ai-bdd/cache/judge/<key>.json        gitignored (evidence-like)
.ai-bdd/cache/embeddings/<hash>.f32   gitignored
```

## Keys

```
actKey   = H({v:1, kind:'act',   text: normalizeStepText(step with params as <name>),
              params: sortedNames, driver, driverMajor, target, context: H(config.context)})
checkKey = H({v:1, kind:'check', text: …, driver, driverMajor, target})
```

`H` is sha256 over RFC 8785 canonical JSON. Caches are keyed by driver because the same
sentence produces different actions on web and desktop; **resolutions are not** (see
[Resolution and lockfile review](resolution-and-lockfile.md)).

## Modes

| Mode | When | Behaviour |
| --- | --- | --- |
| `read-write` | local default | new recordings are written |
| `read-only` | default when `CI=true` | replays and checks are used, nothing is written |
| `off` | `--no-cache` | always recompute |

`--strict-cache` (on by default in `--frozen` CI) turns a healed replay into the failure
`CACHE_REPLAY_DIVERGED`.

## Invalidation strategies

A strategy has a `fingerprint(ctx)` recorded at write time and a
`validate(entry, ctx) → 'valid' | 'invalid' | 'unknown'` at read time. An entry is used only
if no strategy returns `invalid`; `unknown` counts as valid **only** for `effect-verify`.

| Name | Fingerprint | Notes |
| --- | --- | --- |
| `effect-verify` (default) | none | Always valid. Correctness comes from replaying and verifying the effect, and from re-evaluating checks. |
| `route-fingerprint` | sha256 of the route + sorted `(role, name)` of landmark/heading nodes on the start screen | Cheap screen-change detector. |
| `build-checksum` | a user-supplied env var or file contents | Explicitly over-invalidates. Documented as such. |
| `files-hash` | sha256 over the files matching configured globs | Use a per-route mapping: `{ "/settings/billing": ["src/billing/**"] }`. |
| `manual` | a user-set string in config | Bump it to invalidate everything. |
| `custom` | a user module exporting an `InvalidationStrategy` | Loaded from config. |

A whole-build checksum invalidates every commit; a route hash under-invalidates (same route,
changed component). That is why `effect-verify` is the default: replay the recording, verify
that the recorded effect actually happened, and hand back to the agent when it did not.

## Act replay

On a cache hit the runtime:

1. checks the start fingerprint (route plus a structural hash of top-level landmarks);
2. re-finds each target by selector (role, name, testId, text, ancestors, index). A missing or
   ambiguous selector stops replay;
3. performs the actions;
4. verifies the `EffectSignature`: at least one effect element must be **newly true during the
   replay**, otherwise the replay is `missed` — an effect that was already true before the
   replay does not count.

| Outcome | Meaning | Report |
| --- | --- | --- |
| `replayed` | full replay, effect verified | `passed`, `cache.mode = 'replayed'` |
| `healed` | replay stopped partway; the agent finished it | status `healed`, `cache.mode = 'healed'`; a failure under `--strict-cache` |
| `missed` | start fingerprint or effect did not match | agent runs from scratch |
| `recorded` | the agent recorded a new program | committed only after a later assertion passes |

**Commit rule.** A new or healed `ActProgram` (and a generated `CheckProgram`) is written only
if a later assertion in the same scenario passes. Until then it is pending, and it is discarded
if the scenario fails. It is never written in `read-only` mode.

## Settle detection

`settle({quietMs: 300, intervalMs: 100, timeoutMs: 5000, pixelTolerance: 0.001})` polls the
session:

- the screen is settled when the tree hash is unchanged and the screenshot pixel-diff ratio
  (pixelmatch, threshold 0.1) is ≤ `pixelTolerance` across a window of at least `quietMs`;
- if the driver has no pixels, the tree hash alone decides;
- Playwright additionally waits for `document.readyState === 'complete'` and for no in-flight
  requests (a counter over `page.on('request' | 'requestfinished' | 'requestfailed')`, ignoring
  websockets and `EventSource`);
- on timeout it returns `{settled: false}` with the last observation, and the step fails with
  `SCREEN_NOT_SETTLED` when `evidence.requireSettled` is true.

## Flake detection

`ai-bdd run --repeat-each N` runs every scenario N times. Clock freezing and data seeding are
the user's job through setup bindings; the fixture corpus shows the pattern
(`fixtures/bindings/billing.ts` calls the app's `POST /__test/reset` in teardown).
