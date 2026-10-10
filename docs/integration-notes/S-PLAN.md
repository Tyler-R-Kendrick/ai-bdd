# S-PLAN integration notes

## plan (`packages/sdk/src/plan/`)

Public API (re-exported by `plan/index.ts`): `createPlanner`, `createPlanStore`, `loadPlansSync` (contract factories), plus helpers `DocPlanSchema`, `parseDocPlan`, `planPathFor`, `scenarioFingerprint`, `featureFingerprint`, `stepKey`, `FUZZY_TAG`. The baseline facade only re-exports the three contract factories; nothing else needs to be exported.

### Planner behaviour (§8)

- `dirtySections(doc, previous, {full})` returns dirty section ids in document order. Relocation runs first. A section whose hash differs from the plan is still clean when the difference is purely moves: every current chunk of it existed in `previous.chunks` (same id, or same hash elsewhere, counted as a multiset), no previous chunk vanished from it, and every `source` ref resolves (unique-hash relocation). This is what makes "move an unedited paragraph" (M3, also across sections) dirty nothing; a literal reading of "no entry with same section id and hash" would contradict M3. Failed sections (`failed: true` in `plan.sections`) are always dirty.
- `merge` decides per section: result present and not failed -> reconcile; result failed, or absent while the section is dirty -> keep previous features and previous section hash, flag `failed: true` (a brand new failed section gets hash `"0" * 64`); absent and clean -> keep verbatim with relocated refs and the current section hash.
- Pinned features are kept in every section mode, also when their section id vanished (they are re-homed to the section that now holds their first resolvable source). Drafts that reconcile to a pinned feature are discarded.
- Reconcile is global greedy per level: equal fingerprint, then equal normalized title, then token Jaccard >= 0.6 (highest first, ties by previous order). Previous fingerprints are recomputed from content, not trusted from the file.
- Scenarios whose fingerprint is in `rejected` are dropped from drafts (defence in depth next to extractor step 9). A feature whose every proposed scenario was rejected is dropped.
- Drafts citing unknown chunk ids lose those refs; a feature left with no `source` ref is dropped.
- Directives: `@fuzzy` is stored literally as the tag `"@fuzzy"` (including the `@`), exported as `FUZZY_TAG`. Note P-PWTEST maps `'@' + tag`, so it should strip a leading `@` first; the runner should test for `'@fuzzy'`. `driver`/`start` come from the first source ref (scenario refs, then step refs, falling back to the feature refs) that defines them; `tags` are the union (draft tags first).
- `plan.chunks` holds every non-ignored chunk (headings and context chunks included) in document order with an 80-char excerpt. `plan.extractor` is only replaced when at least one section was extracted in this merge (keeps no-op recompiles byte-identical).
- Returned `added` / `updated` / `removed` contain feature ids and scenario ids together (plan order; removed in previous order). `updated` = same id, different fingerprint/title/description/story/tags (scenario: fingerprint/title/tags/driver/startUrl). A pure ref relocation is not an update.
- `diagnostics` contains only planner diagnostics: `PLAN_CONTEXT_CHANGED`, `PLAN_PINNED_STALE`, `EXTRACT_SECTION_FAILED` (one per failed section, warning). The engine should therefore not add its own `EXTRACT_SECTION_FAILED` for the same section, and extractor diagnostics are not repeated here.
- `status`: docs sorted by `docUri`; `new` lists all sections as dirty; `stale` when any dirty section or pinned feature with unresolvable sources. `--frozen` should fail on any state other than `fresh`.
- `review`: pure (returns a clone). `accept` also removes the scenario fingerprints from `rejected`. Scenario-level review recomputes the feature review (all accepted -> accepted, all rejected -> rejected, else unreviewed). `uncovered` is refreshed from the plan alone, so rejecting a scenario uncovers its sources immediately. Unknown id -> `SCENARIO_NOT_FOUND`.

### Store and loader (§8.5)

- Path: `${dir}/${docUri}.plan.json`. `docUri` that is empty, absolute, drive-lettered, contains `..` (substring), a backslash or NUL is `POLICY_DENIED`. Written with `stableJson` + `atomicWriteFile` after zod validation (an invalid plan is never written: `PLAN_CORRUPT`).
- `readOnly: true` makes `save`/`remove` throw `POLICY_DENIED` (no dedicated plan read-only code exists in `ERROR_CODES`).
- Loading: invalid JSON, schema failure (strict: unknown keys rejected) or a `docUri` that does not match the file path -> `PLAN_CORRUPT`; `schemaVersion !== 1` -> `PLAN_SCHEMA_UNSUPPORTED`. A missing plan directory yields `[]`. `loadAllSync` / `loadPlansSync` are recursive and sorted by path.
- Hash fields are validated as non-empty strings (not strict 64-hex) so hand-built fixtures stay loadable.

### Contract proposals / dependencies

None. No new dependencies (zod only).

### VERIFY outcomes

None assigned to S-PLAN.
