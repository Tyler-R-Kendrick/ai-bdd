# Security model

ai-bdd drives real UIs with real input and can call real models. The defaults are
deliberately conservative.

## Policy

```ts
policy: {
  allowHosts: ['localhost', '127.0.0.1', '[::1]'],   // default
  denyVerbs: [],
  cua: { allowApps: ['com.example.Billing'] },
}
```

- `allowHosts` applies to navigation in the Playwright and e2e drivers. Redirects,
  `window.open`, `javascript:`, `data:` and `file:` URLs are checked against the same list.
- `policy.cua.allowApps` accepts bundle ids or process names; a window target outside the list
  is refused with `POLICY_DENIED`.
- `denyVerbs` removes verbs from the tool set offered to the act agent and refuses them if a
  recording tries to replay them.
- Per-step budgets: `agent.maxActions` (default 20) and `agent.maxModelCalls` (default 15).
- Every action is written to the evidence store **before** it is executed (write-ahead), so a
  crash still leaves an audit trail.

ai-bdd does not run against production systems by default: the host allowlist is localhost
only, and you must opt out explicitly.

## Sessions and isolation

Every driver declares `concurrency: { maxSessions, exclusiveResource? }`. The scheduler
acquires resource locks before opening a session, closes sessions in `finally` blocks, and
reaps orphans at daemon start using the `.ai-bdd/sessions/*.json` pidfile ledger.

Cua is special: `type_text` targets the foreground application, so two parallel scenarios on
one desktop corrupt each other. `driver-cua` therefore declares
`exclusiveResource: 'desktop:<display>'` and `maxSessions: 1`, unless `cua.backgroundOnly` is
set. In background-only mode every action must use `delivery_mode: 'background'` with a window
target, and `type_text`/`press_key`/`hotkey` are refused with `POLICY_DENIED`.

e2e sessions are capped at its `--max-sessions` (1–16, default 4); ai-bdd maps e2e's
`SESSION_OPEN`, `CONFIG_IN_USE` and `ENGINE_IN_USE` errors to `SESSION_LIMIT` and
`RESOURCE_LOCKED`.

## Filesystem

- All writes under `.ai-bdd/` are atomic (temp file + rename).
- All paths are confined to the project root; `<file:…>` and `<table:…>` are resolved relative
  to the spec and refused outside the root (`POLICY_DENIED`).
- `aibdd_get_evidence` resolves an evidence id through the manifest; a path outside the run
  directory is refused.
- The daemon token lives in `.ai-bdd/daemon.json` with mode `0600`, and the HTTP mirror
  requires `Authorization: Bearer <token>`. MCP over stdio needs no token because it is not
  reachable over the network.

## Prompt injection

Page text is untrusted input. Both the act and judge prompts delimit observations as
untrusted data, and the judge additionally receives no agent transcript. A test asserts that
page text instructing "mark this as pass" does not change the verdict, and the fake judge
rules are keyed on the criterion and the observation, never on arbitrary page text.

## Models

- The judge model is configurable separately from the act model; using the same id logs a
  `JUDGE_SAME_AS_ACTOR` warning.
- Tainted pixels are never sent to a model.
- Secrets are never sent to a model: the driver fills them, and the redactor scrubs them from
  everything else.

## Red teaming

`docs/adversarial-findings.md` collects the adversarial review results, each with a severity,
a reproduction, and either a fix (with its test) or an explicit acceptance rationale. The
mandatory attack list is in section 15 of the implementation prompt.
