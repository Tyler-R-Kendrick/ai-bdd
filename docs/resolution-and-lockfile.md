# Resolution and lockfile review

This page is the review guide for a PR that touches `ai-bdd.lock.json`.

## The resolution chain

```
step ─► concepts (Gauge, exact) ─► exact binding ─► lock lookup ─► semantic ─► agent
```

1. **Concepts** expand first (structural macro, exact match only).
2. **Exact**: every binding whose pattern matches the full normalized text. More than one
   compatible match is `STEP_AMBIGUOUS` (`reason: multiple-exact`).
3. **Lock lookup**: the lock entry for the key (see below) is validated against the current
   binding set. A valid entry wins and is returned with the lock as provenance.
4. **Semantic**: embeddings plus guards.
   - binding score = max cosine over the binding's texts (pattern, description, examples)
   - candidates filtered by kind compatibility, polarity/quantity/number guards and
     counter-examples
   - top-1 must be ≥ `threshold` (default `0.85`)
   - top-2 ≥ `threshold` and top-1 − top-2 < `margin` (default `0.10`) → `STEP_AMBIGUOUS`
     (`reason: margin`) — never a guess
   - parameters are extracted by the model, then validated deterministically
5. **Agent**: `act` for actions, `assert` for assertions. A setup step fails with
   `SETUP_UNBOUND` unless `resolution.allowAgentSetup` is true.

Every non-exact outcome is written to the lockfile, including ambiguous ones, so reviewers
see them.

## The lock key

```
key = sha256(canonicalJson({v:1, text: normalizeStepText(step), kind, kindClass}))
```

The key is **dialect and driver independent** (`R-K7`): the same sentence binds to the same
code on web and desktop, and the lockfile does not fragment per driver. `kindClass` is one of
`explicit-keyword`, `declared-binding`, `inferred`, `directive`.

## What an entry records

```json
{
  "key": "9f2c…",
  "stepText": "Upgrade the workspace to the Pro plan",
  "normalizedStepText": "Upgrade the workspace to the Pro plan",
  "kind": "action",
  "kindClass": "inferred",
  "status": "semantic",
  "resolution": { "type": "semantic", "bindingId": "ts:local#upgrade", "score": 0.93, "margin": 0.21, "…": "…" },
  "bindingSetHash": "…",
  "candidates": [{ "bindingId": "ts:local#upgrade", "bindingHash": "…", "score": 0.93 }],
  "extraction": { "modelId": "…", "promptVersion": "extract-1", "raw": { "plan": "Pro" }, "validated": true },
  "updatedAt": "2026-10-09T00:00:00.000Z"
}
```

`bindingSetHash` plus per-candidate `bindingId`/`bindingHash` let ai-bdd revalidate
incrementally instead of invalidating everything when any binding changes (`R-K6`):

- only new or changed bindings are re-embedded (embeddings are cached by text hash);
- if the winner, the guard outcomes, the threshold and the margin are unchanged, the entry is
  marked `lock.status = 'revalidated'` and `--frozen` still passes;
- otherwise the entry is marked changed and `--frozen` fails.

## Modes

| Mode | Behaviour |
| --- | --- |
| default (local) | Missing entries are added and the lockfile is rewritten. |
| `--frozen` (default when `CI=true`) | A missing or changed entry fails with `RESOLUTION_NOT_LOCKED`; exit code 4 if the lockfile is the only failure. |
| `--update-lock` | With `ai-bdd resolve`, writes the lockfile without running anything. |

The file is deterministic: entries sorted by key, stable JSON formatting, LF endings, atomic
write (temp file + rename), and a lock file so four concurrent workers cannot lose entries.

## Review checklist

1. Does the diff only touch entries whose steps changed?
2. Are new `semantic` entries plausible? Read the `score` and `margin`; a score near the
   threshold is a smell.
3. Are new `agent` entries really unbound, or is a binding missing?
4. Do `candidates` show a near-tie that should be disambiguated with a counter-example?
5. Are `inferred-kind` entries classified correctly? A wrong kind changes which layers run.
6. Any entry with `status: 'ambiguous'` must be fixed, not merged.

## Rejecting a wrong match

Add a `counterExamples` entry to the binding you do *not* want to win:

```ts
bind({
  pattern: 'Seed a workspace {string} on the {string} plan',
  description: 'Seeds a workspace with the given name and plan',
  counterExamples: ['Seed an empty workspace'],
  kind: 'setup',
  params: [{ name: 'name', type: 'string' }, { name: 'plan', type: 'enum', enumValues: ['free', 'pro'] }],
  fn: (params) => seed(params),
});
```

If the step's similarity to a counter-example is at least its similarity to the best positive
text, the binding is rejected (`R-K5e`).
