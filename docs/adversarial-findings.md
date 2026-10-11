# Adversarial findings (X-REDTEAM)

Suite: `tests/adversarial/**` (run with `pnpm exec vitest run --project adversarial`). 16 mandatory attacks, 313 tests, all offline
(scripted models, fake driver, stub sessions; real Chromium against a local hostile site for A9, A10, A14).
A passing test means the defence holds. A failing test is a real defect with the id below. No test was weakened or skipped.

State: 313 of 313 pass. Every finding below (F-01 .. F-18) was reproduced, fixed in source and verified by its named test; none was closed by weakening a test.
Two tests were adjusted for the intended behaviour: the `.ai-bdd/runs` symlink test (a11) accepts the fail-closed `POLICY_DENIED` rejection, and the plan-store property test now allows `..` inside a name while still rejecting dot-only path segments.
F-03 (missing secret turned into a passed step) was fixed during the run.

## Findings (all fixed)

| id | attack | severity | requirement | summary |
|---|---|---|---|---|
| F-04 | 6 | medium | R-AS1 | `invariant` checks after an action are accepted with no discrimination: a vacuous check silently passes a regressed feature |
| F-05 | 7 | medium | R-SE1 | a secret reflected in a plain field / node name is persisted in plaintext in the committed recording (`effect.changed[].to`) |
| F-06 | 7 | medium | R-SE1 | a literal `fill` equal to a secret value is recorded verbatim |
| F-12 | 13 | medium | R-EX1 | hostile markdown is a CPU bomb (micromark inline delimiters, indented nesting): 100 KB of `[` takes 24 s, no size or time limit |
| F-01 | 1 | medium | R-EX3, R-FX1 | non-derived number / boolean fixture arguments are not tied to the step text |
| F-09 | 11 | low-medium | R-PL4 | a symlink committed at `.ai-bdd/plans/<dir>` or `.ai-bdd/runs` redirects writes outside the project |
| F-13 | 13 | low-medium | R-EX1 | `\s*```$` fence stripping on model text is quadratic (60k whitespace chars = 4 to 6 s per parse) |
| F-14 | 15 | low-medium | R-RN1, R-AS1 | an unsettled `before` observation is used silently and can make a non-discriminative check look discriminative |
| F-07 | 7 | low | R-SE1 | a secret value written in a document is sent to the extraction model and stored in the plan excerpts |
| F-08 | 8 | low | R-AG4 | whitespace-padded forgeries of `</untrusted_observation>` are not neutralized (judge, actor, checkgen) |
| F-10 | 11 | low | R-PL4 | a document file name containing `..` (`release..notes.md`) aborts the whole compile with POLICY_DENIED |
| F-11 | 13 | low | R-EX1 | frontmatter `ai-bdd.tags` list is O(n^2) (`includes` per tag) |
| F-02 | 2 | low | R-EX2 | a quote that only matches the entity-escaped rendering (`&lt; / document >`) is accepted as verbatim |
| F-15 | 9 | low | R-AG3 | a `target=_blank` link to a disallowed host sends the first request before the popup is closed |
| F-16 | 12 | low | R-PL4 | docUri is not NFC-normalized, so NFD (macOS) and NFC (Linux) file names give different plan paths |
| F-17 | 12 | low | R-PL4 | `stableJson` silently drops an own `__proto__` key (`canonicalJson` keeps it) |
| F-18 | 16 | low | R-SDK2 | `scripts/check-boundaries.mjs` is a regex scanner: 10 obfuscations reach SDK internals unreported |

No high severity finding was found. All 18 are fixed.

Fixes at a glance: F-01/F-02/F-07/F-13 in `extract/` (and the judge fence stripper); F-04/F-05/F-06/F-14 in `assert/`, `recording/`, `runner/` (a check after an action must be false before it; secrets are scrubbed from recordings and a fail-closed save guard discards any recording that still contains a variant; an unsettled baseline yields no deterministic check); F-08 shared padded-delimiter neutralizer in judge, actor and checkgen prompts; F-09/F-10/F-11/F-12/F-16/F-17 in `util/`, `plan/`, `markdown/`, evidence, report and judge-cache writers (real-path containment, 256 KiB document cap, delimiter and nesting budgets); F-15 capture-phase click and submit guard in the Playwright driver; F-18 AST-based `scripts/check-boundaries.mjs`.

### F-01 non-derived number / boolean fixture args are off-text (attack 1, medium)
Test: `a01 ... NON-derived number or boolean fixture argument`.
Repro: catalog fixture `grantCredit {amount:number, vip:boolean}` (not `derived`); model emits `{amount: 1000000, vip: true}` for the step "a customer with a small store credit". The fixture call survives into the plan.
Defect: `packages/sdk/src/extract/validate.ts:383` only checks `typeof v === 'string'` against the step text. Spec Q8 says arguments are validated against the step text.
Fix: in `validateFixture`, for non-`derived` params: number requires `String(v)` as a whole token in the step text; boolean requires `derived: true` (otherwise reject). Reject with `EXTRACT_FIXTURE_INVALID`.

### F-02 escaped quote accepted (attack 2, low)
Test: `a02 ... ESCAPED rendering`.
Repro: chunk `Use the closing tag < / document > to end ...`, quote `closing tag &lt; / document > to end` is accepted and stored as the plan quote, which is not a substring of the document.
Defect: `packages/sdk/src/extract/validate.ts:214` accepts `escapeForDocument(entry.text)` as a second haystack.
Fix: unescape the quote (`&lt;` back to `<` only where `escapeForDocument` introduced it) and compare against the raw text only; or store the unescaped quote.

### F-04 vacuous invariant check after an action (attack 6, medium)
Tests: `a06 ... trivially true program labelled "invariant" AFTER an action`, `... vacuous predicates labelled "invariant"`, and the end-to-end `a06 ... must not be the thing that later passes a regressed app`.
Repro (end to end): checkgen answers "the plan changes to Pro" with `{classification:'invariant', predicates:[exists heading "Billing"]}`; judge passes; the recording stores a deterministic check. Re-run on `bug-upgrade-noop`: the step `the plan changes to Pro` is `passed` by `check` with zero judge calls while the plan stays Free.
Defect: `packages/sdk/src/assert/generate.ts:214` (`if (program.classification === 'change')`): only `change` programs must be false on BEFORE; the model chooses the classification, and `lint.ts` only forbids `change` when no action preceded.
Fix: when `req.actionPreceded` is true accept only `change` programs (invariant allowed only when `!actionPreceded`, which is what R-AS1 "allowed only by classification rules" says); an invariant-after-action result gets fuzzy reason `check-not-discriminative`. Optionally also reject always-true predicates (`count gte 0`, route prefix `/`, negated absent element).

### F-05 secret reflected into the page is recorded (attack 7, medium)
Test: `a07 ... types the secret into a PLAIN field`.
Repro: act turn fills the visible `Email` textbox with `{secret:'adminPassword'}`. The recording file contains `"to": "<secret value>"` (`effect.changed`). The Playwright driver masks exact matches (`session.ts` `scrub`), the fake driver and any other driver do not, and the recorder never redacts.
Defect: `packages/sdk/src/recording/recorder.ts` (`toRecording`/`computeEffect`) and `packages/sdk/src/runner/scenario.ts:267` save raw observation-derived strings.
Fix: give the recorder the redactor (or filter in the runner before `recordings.save`): drop any effect entry, selector name or check literal that contains a secret variant (treat like volatile content), and assert `JSON.stringify(pending)` contains no redactor variant before saving.

### F-06 literal secret recorded (attack 7, medium)
Test: `a07 ... types it as a literal`.
Repro: the model learned the value (document) and calls `fill {text: <secret>}`; the recording holds `{"literal":"<secret>"}`.
Defect: `packages/sdk/src/recording/recorder.ts:56` `slotValue` only maps literals equal to params.
Fix: in `slotValue` (or in the actor before performing) map a literal equal to any secret value to `{secret: name}`; and apply the F-05 save-time guard.

### F-07 secret in a document goes to the model and the plan (attack 7, low)
Test: `a07 ... document that contains the secret value`.
Defect: `packages/sdk/src/extract/prompt.ts:59` `renderChunk` and the planner chunk `excerpt` use raw chunk text; the redactor is only used for evidence.
Fix: pass chunk text through `redactor.redact` before building the prompt and the excerpt (the handles and hashes stay on the raw text), or warn with `SECRET_IN_DOC`.

### F-08 padded delimiter forgeries (attack 8, low)
Tests: `a08 ... whitespace-padded / re-cased forgeries`, `... actor and check-generation prompts neutralize padded delimiter forgeries`.
Repro: page text `< /untrusted_observation >` or `</ untrusted_observation>` survives into the prompt (exact `</untrusted_observation>` is neutralized). The extraction prompt already handles whitespace.
Defect: `packages/sdk/src/judge/index.ts:102`, `packages/sdk/src/agent/prompt.ts:102`, `packages/sdk/src/assert/prompt.ts:45`.
Fix: share one neutralizer using `/<(?=\s*\/?\s*untrusted_observation\b)/gi` (as `escapeForDocument` does).

### F-09 symlink redirects writes (attack 11, low-medium)
Tests: `a11 ... .ai-bdd/plans/docs is a symlink`, `... .ai-bdd/runs is a symlink`.
Repro: commit `.ai-bdd/plans/docs -> /somewhere`; `compile` writes the plan there. Same for `.ai-bdd/runs`. (Doc discovery already does a realpath check; outputs do not.)
Defect: `packages/sdk/src/util/index.ts:125` (`atomicWriteFile` mkdir + write), `packages/sdk/src/plan/store.ts` `planPathFor` and the recording/evidence stores check paths lexically.
Fix: before writing, `realpath` the deepest existing ancestor and require it to stay inside `realpath(root)`; refuse symlinked directories below the plan / recordings / runs roots (POLICY_DENIED).

### F-10 `..` inside a file name (attack 11, low)
Test: `a11 ... a document called a..b.md`.
Defect: `packages/sdk/src/plan/store.ts:27` `docUri.includes('..')` (substring). A legitimate `release..notes.md` throws from `compile` instead of producing a diagnostic.
Fix: reject path segments equal to `..` (`docUri.split('/').includes('..')`), keep the backslash / absolute / NUL checks.

### F-11 quadratic tags (attack 13, low)
Test: `a13 ... ai-bdd.tags list is processed in linear time` (4x tags cost 21x).
Defect: `packages/sdk/src/markdown/directives.ts:176` `set.tags.includes(tag)`. Fix: keep a `Set` next to the array.

### F-12 markdown CPU bomb (attack 13, medium)
Tests: `a13 ... unclosed brackets | emphasis delimiters | link openers | image openers | 400 levels of indented list nesting`.
Repro: `'['.repeat(50000)` (100 KB) takes 24 s in `createChunker().chunk`; `*a`x20000 6 s; 800 indented list levels (650 KB) 16 s. Quadratic in micromark; `limitNesting` only covers same-line containers. A hostile PR document stalls CI.
Defect: `packages/sdk/src/markdown/normalize.ts` / chunker have no input budget.
Fix: (a) reject documents above a size cap (for example 512 KiB, `DOC_READ_FAILED`), (b) cap per-line inline delimiter runs (escape or blank lines with more than N unmatched `[`, `*`, `_`, `![`), (c) cap indentation depth, (d) optionally parse in a worker thread with a timeout.

### F-13 fence-stripping regexes (attack 13, low-medium)
Tests: `a13 ... 60k characters of whitespace inside its JSON`, `... judge sample`.
Defect: `packages/sdk/src/extract/index.ts:38` and `packages/sdk/src/judge/index.ts:153`, `.replace(/\s*```$/, '')`. Quadratic on a whitespace run (a runaway model output blocks the event loop).
Fix: only strip when `text.endsWith('```')` using `trimEnd()` and `slice`, no regex.

### F-14 unsettled `before` (attack 15, low-medium)
Test: `a15 ... UNSETTLED "before" observation`.
Repro: page loads by itself (busy for 25 polls); the action is irrelevant; BEFORE is captured mid-load; the generated `change` check "status Data loaded exists" is false on BEFORE, so it is recorded as deterministic `check+judge`.
Defect: `packages/sdk/src/runner/session.ts:32-36` `settledObservation` and `prepareSession` return an unsettled observation without a flag; `steps.ts` `characterizeBranch` uses it as `before`.
Fix: have `settledObservation` return `{observation, settled}`; in characterize, when `before` is unsettled mark the step fuzzy (`check-not-discriminative`) or fail with `SCREEN_NOT_SETTLED`.

### F-15 target=_blank first request (attack 9, low)
Test: `a09 ... a target=_blank link to the foreign origin`.
Repro: clicking `<a target=_blank href=http://evil...>` sends `GET /steal` to the foreign host before the popup is closed (code comment in `guard.ts` acknowledges the limitation for popups).
Defect: `packages/driver-playwright/src/guard.ts` only guards `window.open`.
Fix: extend the init script with capture-phase `click`/`auxclick`/`submit` listeners that `preventDefault` anchor / form navigations whose resolved URL is disallowed (including `target` other than `_self`), or use CDP `Target.setAutoAttach` with `waitForDebuggerOnStart` so `Fetch.enable` is in place before the popup's first request.

### F-16 docUri normalization (attack 12, low)
Test: `a12 ... NFC and an NFD file name`.
Defect: `packages/sdk/src/markdown/discover.ts:46` `uri: toPosix(rel)`. Fix: `toPosix(rel).normalize('NFC')` (keep `absolutePath` raw).

### F-17 `stableJson` and `__proto__` (attack 12, low)
Test: `a12 ... own __proto__ key`.
Defect: `packages/sdk/src/util/index.ts:30` `out[k] = ...` on a plain object swallows the key. Fix: build with `Object.fromEntries(sortedEntries)` or `Object.create(null)` + `defineProperty`. No reachable source of such a key was found (low).

### F-18 boundary script evasions (attack 16, low)
Test: `a16 ... obfuscated ways to reach an SDK internal`.
Missed by `scripts/check-boundaries.mjs`: string concatenation, variable specifier, `createRequire(...)(..)`, `import.meta.resolve` + import, `/` and `\x40` escapes in the specifier, a backtick in a regex literal hiding following imports, import inside a template `${}`, a `//` sequence in a regex literal, `file:` URLs. The script also reads string literals in test files (a fixture string containing an import tripped it). The runtime export map does block deep specifiers (held), so exploitation needs a relative path.
Fix: replace the regex scanner by a TypeScript-AST walk (the audit in `a16` is a working sketch): decode literals, flag non-literal specifiers unless a vetted `const`, flag `createRequire` and `import.meta.resolve`.

## Fixed during the run

* F-03 (attack 4, medium): with a missing secret env the actor rejected `fill {secret}` as "unknown secret" (names came from the redactor), the typing step ended `passed` having typed nothing and the run exited 1 instead of 3. Fixed: `runner/steps.ts:230` now offers `Object.keys(config.secrets)` so the driver raises SECRET_MISSING. Tests `a04 ... missing secret` are green.

## Observations (no failing test)

* O-1 (info): policy covers top-level navigations and popups only. A foreign-origin `<iframe>` is fetched and its content appears in observations (`a09 ... documented scope` pins this). Consider documenting in `docs/security.md`.
* O-2 (info): the scenario fingerprint (spec 8.2) covers title and step text only, so changes to fixture args, `nature`, `startUrl`, `driver`, `params` keep the accepted review state (`a03 ... documented limitation`).
* O-3 (info): a steered model can ground a "delete all users" scenario on the injected sentence itself because the sentence is a verbatim quote; it stays `unreviewed` (`a01 ... injected sentence is itself a verbatim quote`). Grounding cannot separate instruction text from requirement text; rely on review.
* O-4 (low): a failing checkgen model (including MODEL_UNAVAILABLE) is persisted as permanent `check-generation-failed` fuzziness in the recording (`a04 ... keeps failing`). Consider treating MODEL_UNAVAILABLE as an infrastructure error instead.
* O-5 (info): `volatile` patterns use ASCII digits only (as the spec regexes do); fullwidth / Arabic-Indic digits are not flagged. The probe comparison still catches nodes that change within the probe window.
* O-6 (info): `characterize.confirmRuns: 0` is accepted by the config schema (spec says positive integers).
* O-7 (info): host policy ignores ports; any port on an allowed host is allowed.

## Held (defence verified by tests)

* A1: delimiter forgeries (entities, spaced tags, code, table cells, block quotes) cannot close `<document>`; schema is strict so `config` / `policy` / `fixtures` keys fail with exactly one repair retry and nothing reaches plan or config; off-catalog, off-text string, non-enum, wrong-type, extra / proto / duplicate / missing args and fixtures on `when` steps are removed; `fuzzy` tag spellings stripped; directive `start=` with foreign, `file:`, `javascript:`, `data:`, credentials, protocol-relative and upper-case hosts ends in POLICY_DENIED before any navigation or model call.
* A2: 36 near-verbatim variants behave exactly per `normalizeForQuote`: NFD, smart quotes, dashes, ellipsis, NBSP, case accepted; Cyrillic / Greek / fullwidth confusables, ZWSP / ZWJ / soft hyphen, RTL override, combining marks, ligatures, one-letter changes, dropped / extra words, markdown markers, cross-chunk spans, wrong chunk, <12 chars, empty rejected; unknown / context / malformed / zero-padded / raw-id / fullwidth-digit handles never ground a feature.
* A3: section reorder = zero model calls, identical ids / reviews / pins / rejected memory; feature rename keeps ids and scenario reviews, resets the feature review; pinned feature never overwritten or twinned; no accepted state ever attaches to content with another fingerprint across 11 mutation kinds; slug collisions never steal ids; rejected scenarios re-proposed with case / spacing changes stay dropped; recompiles are byte-identical.
* A4: failing judge, band, cannot_tell, self-contradicting judge, blocked / budget-exhausted agent, thrown judge / checkgen errors, confirm-run instability (CHARACTERIZATION_UNSTABLE), failed `-u`, abort, read-only and off modes never create or touch a recording file (also no temp files).
* A5: ten replay attacks (already-present appeared / disappeared / changed / route effects, trimmed effects, volatile-only effects, probe-unstable effects) never verify; one newly true element is enough, as specified.
* A6 (except F-04): all twelve volatile literal families rejected in text / name / within / route / testId; probe-changing nodes cannot be queried; non-discriminative `change` programs rejected; regex metacharacters are literal; evaluation is linear; unknown ops never pass.
* A7 (except F-05..F-07): normal login leaks nothing in files, results, events, fake log, config, engine inspect; driver / fixture style errors quoting the secret are redacted; redactor covers raw, URL (both hex cases, `+`), base64, unpadded, base64url and JSON-escaped forms, longest first, regex metacharacters; SECRET_TOO_SHORT never echoes the value; CLI output clean; no screenshot to the judge after a secret fill without proven masking.
* A8 (except F-08): judge request carries only the documented keys (compile-time key-set assertion), canary in actor args / ids / text / summary never reaches judge, checkgen, plan, recording or cache; transcript-like page text and exact closing tags stay inside the untrusted block; JUDGE_SAME_AS_ACTOR reported.
* A9 (except F-15): 40 denied and 10 allowed URL forms in `checkNavigation`; fake driver denies all of them and the app-level open redirect at every hop; Playwright: 302/301-chain/307 redirects, meta refresh, timer navigation, `window.open` (also named window), `javascript:` / `data:` / `file:` links, credential, trailing-dot, homoglyph and upper-case host links, cross-origin form POST and `request()` never reach the foreign origin.
* A10: 16 scenarios on 8 workers never see each other's data, results keep plan order, `maxSessions` and shared `exclusiveResource` across drivers are hard caps, taint is per session; Chromium contexts isolate cookies / localStorage / sessionStorage and server state across 8 concurrent sessions.
* A11 (except F-09, F-10): traversal docUris, scenario ids, driver ids, symlinked plan listings, mismatching plan / recording identities, forged manifests (traversal, absolute, backslash, symlinked artifacts, extras, flipped bytes, deletions) all fail closed; documents symlinked outside the project are refused.
* A12 (except F-16, F-17): plan bytes identical across TZ / locale (incl. Turkish), LF / CRLF / CR / BOM, model key order, extraction concurrency; recordings identical across fresh projects and worker counts; no absolute path, timestamp or uuid in plans or recordings; `unchanged` on identical re-save; 400 property runs for `stableJson`.
* A13 (except F-11..F-13): all 14 volatile-pattern families and the directive tokenizer scale linearly and finish in milliseconds; same-line container nesting is neutralized.
* A14: stale, future, cross-session and 21 malformed refs rejected by both drivers (including after a navigation that reordered the page); the actor executes only the first action per turn, rejects reused / hallucinated refs, and replay always uses a ref from the observation made just before the action.
* A15 (except F-14): busy, ticking, flapping screens never reach judge, checkgen, deterministic check or `--audit`; `requireSettled:false` is the only opt-out.
* A16 (except F-18): AST audit of every source file finds no deep import, dist import, undeclared workspace dependency or static CLI import of optional packages; node refuses deep SDK specifiers (`ERR_PACKAGE_PATH_NOT_EXPORTED`).

## Sign-off

Signed off by X-INTEGRATOR: zero open findings, 313 of 313 adversarial tests green. Residual risks are the observations above (O-1 foreign iframes are fetched and visible; O-3 an injected sentence can ground a scenario but stays `unreviewed`), the 256 KiB document cap (hostile 240 KB markdown parses in about 2 s), and the borrowed-page (`sessionFromPage`) popup limitation documented in `packages/driver-playwright/README.md`.
