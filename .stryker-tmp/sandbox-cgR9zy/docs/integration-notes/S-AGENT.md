# S-AGENT integration notes

## agent

`createActor({ model, redactor, settler, config, evidence? })` returns an `Actor` (SPEC 10.1, `ACT_PROMPT_VERSION = 'act-v1'`).

Behavior:

- Each turn: `settler.settle(session, {quietMs, intervalMs, timeoutMs}, {pixels: caps.pixels, signal})`, then one `model.generate` call (`purpose: 'act'`, `toolChoice: 'required'`, `temperature: 0`).
- `ModelRequest.context` is `{ scenarioId, stepKey, stepText, turn, route, nodes: [{ref, role, name, ancestors: string[]}] }`. `ancestors` are the names of named ancestors (via `parentRef`), nearest first. All values are redacted.
- Messages: header (scenario, step, app context, prior steps text+status, params, secret NAMES, hints as `previously: ...` lines), then prior assistant/tool turns, then the latest observation inside `<untrusted_observation>...</untrusted_observation>` (redacted, truncated to 20000 chars, delimiter strings in page text are neutralized). Only the latest observation is sent.
- Screenshot is attached only when present and (`!obs.tainted` or `screenshot.masked && caps.maskingProven`).
- Tools: `caps.verbs` minus `policy.denyVerbs`, plus `complete_step`. A call to a denied verb returns a `POLICY_DENIED` tool result; a verb the driver lacks returns `VERB_UNSUPPORTED`; an unknown or stale ref returns `STALE_REF`; invalid arguments return `MODEL_OUTPUT_INVALID`. None of these are performed or counted as actions (they do consume a model call).
- Only the first executable (UI-changing) tool call per turn is performed; later calls get the tool result `not executed: observation changed; re-plan`.
- `navigate` is checked with `checkNavigation(url, config.baseURL, config.policy)`; the checked absolute URL is the one performed.
- Ambiguity (R-AG2) fails the step immediately with `ACT_TARGET_AMBIGUOUS`; `error.details = {verb, target, candidates: [{role, name, ancestors: string[]}]}`.
- Write-ahead log: before `session.perform`, `evidence.putArtifact('action-log', ...)` receives `{phase: 'intent', scenarioId, stepKey, turn, seq, toolCallId, action, target?}`; afterwards one `{phase: 'outcome', ...}` entry. Both redacted. If the evidence write throws, the action is not performed.
- Budgets: a model-call budget miss and an action beyond `agent.maxActions` both give `failed` / `ACT_BUDGET_EXHAUSTED`. The model may still call `complete_step` after the last allowed action. Two consecutive turns without a tool call give `failed` / `MODEL_OUTPUT_INVALID`.
- The redacted transcript is stored as `act-transcript` (also when the model throws); `ActResult.transcript` is its ref.
- Model or driver exceptions (`MODEL_UNAVAILABLE`, `MODEL_NO_RULE`, `ABORTED`, ...) propagate; the runner should map them to step `error`.

Notes for the runner and recording owners:

- `ActResult.actions` includes actions whose `outcome.ok === false` (the driver refused them). The recorder SHOULD skip those when building an `ActProgram`, and the runner may treat a trailing failed outcome with a `done` status as suspicious.
- `PerformedAction.chosenFrom` and `.target` are the raw (unredacted) settled observation and node, because selectors must match exactly.
- `finalObservation` is the last settled observation; if the last turn performed an action (budget ended the loop), the actor settles once more so it is current.
- `--no-agent` is handled by the runner, not by the actor.

No contract changes are proposed. No VERIFY items touched.
