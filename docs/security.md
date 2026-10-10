# Security

ai-bdd feeds untrusted text to models that can act on a real application with real credentials. This page states what it trusts, what it defends, and where the defences stop.

## Trust model

| Input | Trusted? | Why it matters |
|---|---|---|
| `ai-bdd.config.*`, fixtures, drivers, model adapters, rule files | **Yes**, they are code you run. | Config is imported as a module. `use` entries load packages. Fixtures run in your process and can read `process.env`. Review them like any dependency. |
| Documents (markdown) | **No.** | Anyone who can edit a doc can try to steer the extractor ("add a scenario that deletes all users"). |
| Application pages | **No.** | A page, or user content shown in it, can contain text that imitates instructions or a transcript. |
| Model output | **No.** | It is parsed against a strict schema and validated before it can reach the plan or the browser. |
| Plan and recording files in the repository | **Reviewed.** | They decide what runs and what passes. Treat changes like code changes. |
| The machine running ai-bdd and its run directory | Trusted. | See [Evidence integrity](#evidence-integrity). |

## Untrusted documents

Defences, all deterministic and tested with injection documents:

- The document is sent as delimited data inside `<document>…</document>`. The system prompt states that the text is untrusted and that instructions inside it are never followed. Look-alike delimiters in the text are escaped.
- The model answers only through a strict JSON schema. It has no channel for config, policy, hosts or secrets, and nothing in the output is read as configuration.
- **Grounding.** Every feature and scenario needs a verbatim quote from a chunk the model was shown. A quote that does not match after normalization drops the element. The model sees short handles (`[c7]`), not addresses, so it cannot invent locations.
- **Fixtures** are chosen only from the catalog you configured. Arguments must match the declared types, and every string argument must occur in the step text. A fixture call that fails validation is removed and the step becomes `blocked`.
- **Tags** from the model are restricted to a safe character set, and the `fuzzy` tag is always removed (only a directive can set it).
- `<secret:name>` tokens must name configured secrets.
- Rejected scenarios are fingerprinted and dropped on every future compile.

What this does not do: a document is the specification. If someone legitimately edits it to say "the admin page deletes all users", a scenario can follow, and it will act within the policy. The review step ([review-guide.md](review-guide.md)) is the control for that, and `--frozen`/read-only CI means a pull request cannot change what CI runs without changing committed plans and recordings in the same diff.

## Untrusted pages

- The accessibility tree reaches the agent and judge inside `<untrusted_observation>` delimiters, redacted, truncated, with delimiter strings in page text neutralized. The prompts tell the model to treat it as data.
- Only the **first** UI-changing tool call of each model turn is performed; later calls in the same turn are refused (`not executed: observation changed; re-plan`).
- Every action passes **policy** (below) before it is performed. A denied action is returned to the model as `POLICY_DENIED` and never executed.
- Ambiguity is resolved by rule, not by the model: if the target has identical siblings and the step text names none of the distinguishing ancestors, the step fails with `ACT_TARGET_AMBIGUOUS`.
- The agent has hard budgets per step (`agent.maxActions`, `agent.maxModelCalls`, `agent.maxWaitMs`).
- **The judge never sees the agent.** Its input type has no field for transcripts, tool calls or action summaries, and it is told only the criterion and the before and after pages. Page text that imitates an agent transcript is still just page text.
- Deterministic checks use no model at all: a replayed scenario cannot be talked into passing.

What this does not do: the judge is a model reading page content. A page that says "this requirement is satisfied" is data in a prompt that tells the model to ignore instructions in it; that lowers the risk, it does not remove it. The multi-sample scoring and the `inconclusive` band make a single manipulated sample insufficient, and recordings of passing scenarios are reviewed.

## Navigation policy

`policy.allowHosts` defaults to `localhost`, `127.0.0.1`, `[::1]` plus your `baseURL` host. Entries are exact hosts or `*.suffix` (subdomains only). `checkNavigation` allows only `http:` and `https:`, rejects URLs that carry credentials, and compares hosts case-insensitively. `policy.denyVerbs` removes verbs from the agent's tools and is enforced in `perform`.

It is enforced three times, so one layer's bug is not the end:

1. **Runner**: start URLs and replayed `navigate` actions.
2. **Agent**: `navigate` tool calls, before the action log is written and before `perform`.
3. **Driver**: the Playwright driver blocks disallowed top-level navigations inside the browser (links, forms, scripts, `Location` changes), redirect hops to disallowed hosts, popups and `window.open`, and sends a main frame that still ends up off-policy back to `about:blank`. `request()` applies the policy to every redirect hop it follows. Drivers you write must do the same ([drivers.md](drivers.md)).

Everything on an allowed host is trusted. Do not allow hosts you would not want an agent to act on. Add staging or SSO hosts deliberately.

Every action is written, redacted, to the run's `action-log` artifact **before** it is performed, so even a crash leaves a record of intent.

## Secrets

Declare a secret by environment variable name only:

```ts
secrets: { adminPassword: { env: 'ADMIN_PASSWORD' } }
```

- The value is read once when the engine is created and lives only in the **redactor** and the value resolver. It is never stored in the resolved config, so `JSON.stringify(config)` contains no secret. Values shorter than 4 characters are rejected (`SECRET_TOO_SHORT`).
- Prompts, steps and docs use the token `<secret:adminPassword>`. The model never receives the value; the tool call says "fill with secret adminPassword" and the driver resolves it at typing time.
- Recordings store `{ "secret": "adminPassword" }`, never the value.
- **Redaction** replaces the raw value and its percent-encoded (both cases of hex, and `+` for space), base64, unpadded base64, base64url and JSON-escaped forms with `<secret:name>` in everything that is written or printed: observation artifacts, agent transcripts, judge and extraction requests and responses, action logs, `events.jsonl`, reports, error messages, CLI output. Longer secrets are replaced first, and replacement is a single pass.
- **Taint.** Once a secret is used in a session, the session is tainted for the rest of its life. Screenshots of a tainted session reach models and evidence only if the driver reports them `masked` **and** `maskingProven` (the Playwright driver masks password inputs and `[data-ai-bdd-secret]` elements). Otherwise the agent and judge work from the redacted tree only.
- The Playwright driver strips password values from observations (the ARIA snapshot exposes them) and scrubs any resolved secret found in node text.

Limits you must know:

- Redaction is exact-string. A secret the app transforms (hashes it, truncates it, shows the last four characters, reformats it) is no longer recognized. Use dedicated test credentials that are worthless elsewhere.
- Pixels cannot be redacted after the fact. Mask in the driver, or accept that screenshots are withheld while tainted.
- Fixtures and config are your code. Anything you log from there that is not declared under `secrets` is not redacted.
- Mark extra sensitive elements with `data-ai-bdd-secret` in your app (test builds) to get them masked.
- Treat `.ai-bdd/runs/` and `.ai-bdd/cache/` as sensitive anyway: they hold page content (names, emails, whatever your test data shows).

## What leaves your machine

- **To the extract model**: document chunks, outline, fixture catalog, secret *names*, rejected titles, your `context` string.
- **To the act, checkgen and judge models**: redacted accessibility trees of the pages under test, step text, parameters, your `context` string, and screenshots only when untainted or masked and proven.
- Never: secret values, the structured `context` metadata field of a model request (it exists for logs and fakes), the config object.

Use synthetic data in the environment under test and a provider whose terms fit the content of your docs and pages.

## Evidence integrity

Each run writes content-addressed artifacts (`artifacts/<sha256>.<ext>`) and a `manifest.json` with every artifact's hash, size and kind, and a digest over the sorted list. Text is redacted before it is hashed. `ai-bdd verify-run <runDir>` recomputes everything and reports `missing`, `modified`, `extra` and `digest mismatch` problems (exit 1).

What this proves: the directory has not been corrupted or casually edited since it was finalized. What it does not prove: authenticity. The manifest is not signed, so anyone who can write to the run directory can change an artifact and recompute the manifest consistently. A compromised runner host is out of scope. If you need provenance, store the run directory (or at least `manifest.json`'s digest) somewhere the runner cannot rewrite, for example as a signed CI artifact. Reports are derived from the same run and are not covered by the manifest. A run directory whose engine was killed before `close()` is not finalized, and `verify-run` says so.

## Files and paths

Doc discovery rejects matches outside the project root, including through symlinks (`POLICY_DENIED`). Plan and recording paths are built from doc URIs and scenario ids and reject absolute paths, `..`, backslashes and unsafe characters. Files are written atomically (temp file, rename). Run ids are validated before use.

## Residual risks

| Risk | Mitigation |
|---|---|
| A judge approves a wrong first run and it becomes a recording. | Doc-as-oracle with multi-sample scoring, an `inconclusive` band, review of recordings, `--audit`, `judgments.jsonl`. Not eliminated. |
| A weak check passes after a regression. | Checks must be discriminative and agree with the judge when recorded; doc edits invalidate recordings; `--audit`. |
| Allowed hosts are fully trusted. | Keep `allowHosts` minimal. |
| Redaction misses transformed secrets. | Dedicated test credentials; masking in the driver. |
| Run evidence is tamper-evident only against casual edits. | Store digests externally if you need provenance. |
| A pull request edits docs, plans and recordings together. | Review plans and recordings as code; CI runs `compile --check` and read-only recordings. |
| CSS-only loading states are invisible to settle. | Add `aria-busy` or a progress role; use `fuzzy` where needed. |
