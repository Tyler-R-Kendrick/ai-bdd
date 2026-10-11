# S-EXTRACT integration notes

## extract

Public API (from `packages/sdk/src/extract/index.ts`, re-exported by the SDK facade as before):

- `createExtractor({ model, redactor, config, evidence? }) -> Extractor` (contract `CreateExtractor`).
- `EXTRACT_PROMPT_VERSION = 'extract-v1'`, `EXTRACT_SYSTEM_PROMPT`, `ExtractionSchema` (zod, strict), `EXTRACTION_JSON_SCHEMA` (`z.toJSONSchema(ExtractionSchema)`), `scenarioFingerprint(title, steps)` (SPEC 8.2 formula; the planner remains the source of the stored fingerprint).

`extractSection(input)` behavior:

1. Builds one `user` message wrapped in `<document>...</document>`. Handles `c1..cN` are per request, context chunks first (context text truncated to 4000 chars total), then the section chunks in `section.chunkIds` order. Delimiter look-alikes (`<document>`, `</document>`) inside any doc-derived text are escaped to `&lt;...`; quote validation accepts either the raw or the escaped chunk text. Continuation lines of multi-line chunks are indented so they cannot forge a `[cN]` line.
2. Calls the model with `purpose: 'extract'`, `temperature: 0`, `output: { name: 'extraction', schema }` and `context` of exactly `{ docUri, sectionId, sectionAnchor, attempt }`.
3. Schema failure (or a thrown `MODEL_OUTPUT_INVALID`) -> one repair attempt (`attempt: 2`; the previous output is echoed as an assistant message and the validation error appended as a user message). A second failure returns `failed: true` with `EXTRACT_MODEL_OUTPUT_INVALID` (error). Any other thrown error (including `MODEL_UNAVAILABLE`, abort) returns `failed: true` with `EXTRACT_SECTION_FAILED` (error), no retry. Failed results carry `drafts: []`, so the planner keeps the previous features.
4. Deterministic validators run in the SPEC 7.3 order (handles, quotes, grounding/inheritance, step sanity, params, fixtures, secrets, rejected). See the table in `packages/sdk/test/extract/validators.test.ts`.
5. `usage` sums the responses of all attempts, `modelId` is the last response's `modelId` (or `model.id` when no response arrived), `notTestable` handles are mapped to chunk ids (unknown handles and context chunks are ignored).
6. With `deps.evidence`, each attempt stores `extract-request` and `extract-response` artifacts as stable JSON, passed through `redactor.redactJson` first. An evidence write failure is a warning diagnostic (`INTERNAL`) and never fails the section.

### Decisions where the spec was silent (please fold into docs / confirm)

- A source ref pointing at a context chunk is downgraded to `context` silently (no diagnostic). A `context` ref keeps its quote only when that quote is verbatim; otherwise the ref is kept without a quote. `context` refs never ground a feature or scenario.
- Dropped params get an info `EXTRACT_QUOTE_NOT_FOUND`; dropped/empty-text steps and scenarios without any when/then use `EXTRACT_UNGROUNDED` (no dedicated codes exist). A "downgraded to inferred" step is an info `EXTRACT_UNGROUNDED`. A rejected-fingerprint drop is an info `EXTRACT_UNGROUNDED` with `details.fingerprint`.
- After secret-step dropping the scenario is re-checked for at least one `when`/`then` step and dropped (`EXTRACT_UNGROUNDED`) otherwise.
- A feature left with zero scenarios (all dropped or rejected) is dropped (info `EXTRACT_UNGROUNDED`).
- Number and boolean fixture args are type-checked but not required to occur in the step text (spec: only string args; "two unpaid invoices" -> `unpaid: 2`). Enum string args must additionally be in the enum.
- Hardening for R-EX3 beyond the spec: model-supplied tags are restricted to `[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}`, a leading `@` is stripped, and the `fuzzy` tag is always removed (the planner adds `@fuzzy` from directives; model output must not reach the runner's directive tag). Param names must match `[A-Za-z][A-Za-z0-9_-]{0,63}`; fixture arg names must be own keys of the descriptor.
- Stored quotes are `normalizeText(quote)` of the model quote (whitespace collapsed, case kept); param values are the matching substring of the step text (text casing).
- Draft optional fields are omitted (never `undefined`/`null`); `requiresState` is only emitted as `true`; `nature` only on `then`.

### Engine wiring notes (X-INTEGRATOR / S-FACADE)

- `deps.config.extract.minQuoteChars` is read per call. `input.fixtures` is the catalog, `input.secretNames` the names of configured secrets, `input.rejected` the plan's rejected list.
- The engine's usage-counting decorator wraps the `ChatModel`; the extractor's own `usage` is the per-section sum and should not be added again if the decorator is used for report totals.
- Concurrency (`extract.concurrency`) is the engine's job; `extractSection` is re-entrant and holds no shared state.

### VERIFY outcomes

None required by this module.

### Contract proposals

None. (Observation only: `Diagnostic` codes have no dedicated entries for "param dropped" or "step dropped"; mapped as above.)
