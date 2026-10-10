# S-ASSERT integration notes

## assert

Public API (`packages/sdk/src/assert/index.ts`): `createAsserter`, `evaluatePredicates`, `lintCheckProgram`, `CHECKGEN_PROMPT_VERSION`. Also exported for sibling modules (e.g. recording, which keeps a local copy today): `findVolatile`, `hasVolatile`. Internal: `generate.ts` (`computeVolatileNodes`), `schema.ts`, `prompt.ts`.

### Behavior

- `evaluatePredicates` is deterministic and regex-free. It never throws: a malformed predicate (unknown op/comparator/match mode, missing query, text value with neither `literal` nor `param`) yields `satisfied: 'unknown'`, which counts as failure. Missing params give `satisfied: false` with `actual: {matches: 1, missingParam}`. `text` with n != 1 matches gives `actual: {matches: n}`. `actual` strings are clipped to 300 chars.
- `within` is resolved through `parentRef` (falling back to `depth` ordering when `parentRef` is absent) with a memoized linear pass per distinct `within` key. Cycles terminate.
- `asserter.evaluate`: `passed` requires at least one predicate and every result `true`. An empty program never passes (deliberate: no vacuous truth). Result `actual` values are passed through `redactor.redactJson`.
- Volatile patterns are implemented as a linear tokenizer, not regexes; a property test compares them with the spec regexes on random token soup. Matches of one kind do not overlap (as with a global regex). `just now` accepts any whitespace run between the words.
- Lint: beyond the spec list it also rejects negative or non-integer `count` values and vacuous `contains ''` / empty `prefix`. A volatile literal is accepted when each volatile substring occurs in the step text (`normalizeForQuote` substring) or inside a param value. A query matches a volatile node key when role and name filters (exact/contains) match; a name-less query only counts for `text` predicates (presence checks on a role are stable).
- Volatile node keys are computed from a multiset diff of `(role, name, text, value)` between `after` and `afterProbe` (both sides of a change are reported). Additionally the generator rejects queries whose `testId` belongs to a volatile node.
- Generation: system prompt + one user message; retries append the previous response as an assistant message and the errors as a user message. Output schema is strict (all keys required, absent = `null`; `anyOf` over the five ops). The parser also accepts the natural contract shape (optional keys omitted), so fake-model rule files may emit `{classification, predicates: Predicate[]}` directly.
- Fuzzy reasons on final failure: attempts whose lint findings were all volatility findings, or whose program was true on `after` but false on `afterProbe`, count as volatile; a `change` program true on `before` counts as not discriminative; everything else (schema errors, program false on `after`, model errors) counts as generation failure. Both `volatile-content` and `check-not-discriminative` are returned when both occurred; `check-generation-failed` only when neither did.
- `verified` is `{afterTrue: true, probeTrue: true, beforeFalse: true | null, judgePassed: false}`; `beforeFalse` is `null` for invariants. The runner sets `judgePassed = true`.
- Evidence: one redacted `checkgen` artifact (stable JSON with request, response, outcome, errors) per attempt when `deps.evidence` is given.
- Abort: an aborted `req.signal` makes `generate` throw `ABORTED`.

### Notes for other swarms

- X-CORPUS / P-FAKEMODEL: checkgen rule responses are `respond.object = { classification, predicates }`; see above for accepted shapes. The rule `when` paths available are exactly `criterion`, `attempt`, `scenarioId`, `stepKey`. `criterion` in the context is the redacted criterion text.
- No dependency requests. No contract proposals. No VERIFY items.
