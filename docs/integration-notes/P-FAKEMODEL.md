# P-FAKEMODEL

## fake-model (`@ai-bdd/testing`, `packages/testing/src/fake-model/`)

Public API (all exported from `@ai-bdd/testing`):

- `createFakeModels({rules?, rulesDir?, logPath?}) -> ModelSet & {calls: FakeCall[]}`. All four purposes share one rule table and one call log; model ids are `fake:<purpose>`. Rule order: `rules` files (given order), then `rulesDir` `*.json` files in file-name order (plain code-unit sort). First match wins. `rules` accepts typed `FakeRuleFile`s or loosely typed `{rules: JsonObject[]}` (e.g. `JSON.parse` output); everything is validated.
- `loadRuleFiles(dir)`, `validateFakeRuleFile(value, source?)`, `FAKE_RULE_FILE_JSON_SCHEMA`. Invalid files throw `CONFIG_INVALID` listing every problem (`details.problems`); the message names the file.
- Types: `FakeRuleFile`, `FakeRule`, `FakeRespond`, `FakeMatcher`, `FakeScriptStep`, `FakeTarget`, `FakeCall` (`{purpose, request, response, ruleId?}`), `FakeModelOptions`.

Behavior details beyond section 13.3:

- `when` paths resolve against `request.context` with `.`-separated object keys / array indexes. An unresolved path never matches (including for `notContains`). `equals`/`in` compare strings; numbers and booleans compare by their `String()` form. `contains`/`notContains` do substring on strings and whole-element membership on arrays.
- `script`: `script[context.turn]` (turn defaults to 0), past the end `complete_step {status:'done', summary:'Scripted steps complete.'}`. `args.target {role, name?, within?}` resolves to `args.ref`: first node in `context.nodes` with equal role, equal normalized name, and (with `within`) a normalized-equal entry in `nodes[].ancestors`. Zero matches -> `MODEL_NO_RULE` (details also include `rule` and `target`). Tool call ids are `call_<12 hex of sha256(rule, turn, tool, args)>`. Ambiguous targets resolve to the first match on purpose, so the actor's own ambiguity rule (R-AG2) sees the click.
- `samples`: `samples[context.sample % len]` (sample defaults to 0). `byAttempt`: entries are themselves response objects; index `min(max(attempt-1,0), len-1)`, attempt defaults to 1.
- Usage: `inputTokens = ceil(chars/4)` over `system` + text of every message part + `canonicalJson` of assistant `toolCalls` and tool `result`s (images and `context` do not count). `outputTokens = ceil(len(canonicalJson({text?, object?, toolCalls}))/4)`.
- Log: each successful call pushes `{purpose, request: {purpose, system, messages, context}, response, ruleId}` to `calls`; images become `{image: sha256}` (sha from the part, or computed from bytes if empty). When `logPath` (set it through `createFakeModels({ logPath })` or `writeTestConfig({ logPath })`; the former environment variable for this was removed with the fake mode) is set, one `canonicalJson` line per call is appended (parent dirs created). Failed lookups (`MODEL_NO_RULE`) are not logged. R-JU1 canary assertion: `calls.filter(c => c.purpose === 'judge').every(c => !JSON.stringify(c.request).includes('CANARY-7f3a'))`.
- An already-aborted `signal` rejects with `ABORTED`.
- Extra rule keys: `description` (free text) and top-level `$schema` are accepted; any other unknown key is rejected to catch typos.

## Dependency / contract notes

- No contract change needed. The validator is hand-written (the `@ai-bdd/testing` package has no `zod` dependency; none was added). If X-INTEGRATOR prefers zod, replace `schema.ts` only.
- The act module MUST include `ancestors: string[]` per entry of `context.nodes` (section 10.1) and `turn`; the judge `sample`; extract/checkgen `attempt`, as already specified.

## VERIFY outcomes

None for this module.
