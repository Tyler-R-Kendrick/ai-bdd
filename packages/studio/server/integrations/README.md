# Artifact integrations and connected machines

The hosted agent uses the installed AI SDK with an explicitly selected harness, provider and model; T3 Code is the default, and Vercel/fx is an explicit alternative. It can read bounded file/tree/PR context from the selected GitHub repository, pinned to a captured commit. With per-user identity enabled, repository reads require the selected owner's verified credential. Only legacy workspaces without that identity feature can use an explicitly allowlisted operator credential. Project authorization is checked before and after awaited reads. Stable `#artifact:<uuid>` references resolve only inside the selected project and never change the edit target.

Each artifact has a shared manual/automatic participation policy and pause state. Explicit mentions act immediately; solo conversation has a short debounce and group conversation a longer quiet period. Pausing aborts an active turn. Every started turn has a durable record; interrupted, failed, and cancelled work is never relabeled completed after a restart.

Research sends only the exact submitted brief to its source service. By default it performs live retrieval from Wikipedia's public corpus; this is narrower than general web search. For a broader operator-controlled search service, configure `STUDIO_SEARCH_URL` and optionally `STUDIO_SEARCH_TOKEN`. It receives:

```json
{ "query": "the exact submitted brief", "limit": 8 }
```

It must return at most eight sources shaped as `{title,url,excerpt}`; URLs require HTTPS. Responses, excerpts, model context, and requests are bounded. A completed child research document contains the retrieved source links, timestamps and excerpt SHA-256 hashes. These establish retrieved-text provenance, not the truth of every model-generated assertion. No child is published until source retrieval and generation finish successfully. The parent retains an inline request card and exact job status.

`STUDIO_GATEWAY_BASE_URL` is optional and operator controlled. It uses the installed AI SDK Gateway protocol, not an arbitrary artifact-supplied endpoint. HTTPS is required except for explicit loopback development fixtures. Provider keys remain in the normal environment secret binding, never artifact content.

## Open Design

The integration calls only an independently installed and registered **local** Open Design runtime through MCP stdio. It has no remote Open Design fallback and never downloads an installer or runs a source checkout. Install the official signed application and verify its registration using `codex mcp get open-design --json`. Preserve other MCP registrations.

An operator-owned absolute JSON registration file selects the resolved packaged executable and its actual registration arguments:

```json
{
  "command": "/absolute/path/from-the-verified-registration",
  "args": ["the", "actual", "registered", "arguments"],
  "envNames": []
}
```

Set `STUDIO_OPEN_DESIGN_REGISTRATION` to that file. The path and arguments are trusted operator configuration; a document or browser cannot select an executable. Keep any required credential variable names in `envNames`, with their actual values supplied through deployment secret storage rather than this file.

The adapter preserves the selected Open Design Cloud, Local Codex, or secure BYOK mode for the complete workflow. It sends the fixed first-party plugin attribution once during brief collection, preserves the server-issued workflow identity and brief confirmation, and stores signed machine context only on the server. A start request has one opaque stable identity; a lost response retries identical arguments, while polling only reads that run. Changed prompts need a new confirmed workflow. The selected artifact’s complete bounded source and revision accompany the request as quoted context; private uploaded-file URLs remain references rather than public media downloads. Retries reuse the original snapshot. Cancellation calls only an operation actually advertised by the installed runtime and never claims cancellation until its reported state confirms it. Cloud sign-in is never invoked for Local Codex or secure BYOK. Recharging requires an explicit resume action. Open Design Cloud or the selected BYOK provider owns usage costs.

The installed service must advertise the required operations and attributed workflow support (Open Design 0.17.0 or newer). The bridge reads its advertised brief schema instead of presenting private workflow identities or signed envelopes as user instructions. An unavailable runtime or unsupported response fails visibly. Protocol fixtures test this boundary; they do not certify that an external installation or provider account is present.

## User-controlled machine and ACP worker

A project owner issues a one-time pairing code, valid for ten minutes. The local worker exchanges it for a project-scoped credential, saves that credential with mode `0600`, and never prints it. Pairing is single-use. Owner revocation or loss of the sponsoring user's project permission prevents subsequent claims and submissions.

Build `server/machine-worker.ts` alongside the other server entries. Configure the local worker through its own environment:

```sh
STUDIO_API_URL=https://studio.example.com
STUDIO_MACHINE_PAIR_CODE=<one-time-code-from-owner>
STUDIO_MACHINE_CREDENTIALS=/operator-selected/private/machine.json
STUDIO_MACHINE_AGENT_COMMAND=/absolute/path/to/the-installed-acp-agent
STUDIO_MACHINE_AGENT_ARGS='["actual","ACP","arguments"]'
STUDIO_MACHINE_CWD=/operator-selected/checkout
```

Run `node dist/server/machine-worker.js --once` for one approved item, or omit `--once` to remain connected. Later runs use the private saved credential instead of the pairing code. The selected coding agent must already be installed and authenticated; Studio does not install it or copy its provider credentials.

The worker negotiates **ACP protocol version 1**, creates a session at the operator-selected checkout, and accepts bounded text results. It advertises no editor filesystem or terminal capability. Permission requests are denied by default. An operator may explicitly allow particular ACP tool kinds via `STUDIO_MACHINE_ALLOW_PERMISSIONS=read,search,edit`; each granted permission chooses only `allow_once`. The coding-agent process still runs as the local OS user and must be trusted independently. Run it with the operator's chosen OS/container sandbox. The server never executes the agent command, a shell command, or an artifact upload. Studio-specific credentials are removed from the agent child's inherited environment.

Implementation/investigation work is explicitly approved against an artifact revision. The worker checks that a selected GitHub repository matches its configured checkout, maintains a renewable lease, and stops if its lease is cancelled. Expired work is interrupted rather than silently reexecuted. A returned `{summary,content?,pullRequestUrl?}` is held for human review and marked `external-unverified`; it cannot create a passing server test result. Applying proposed content checks the approved version and persists review state in the same transaction as the artifact revision. Source changes remain visible as a stale result, never overwritten silently.

## Executable live-provider gate

`server/integrations/live-check.ts` deliberately fails closed unless a concrete HTTPS deployment, owner API token, dedicated test project and `STUDIO_LIVE_ALLOW_PROVIDER_USAGE=1` are supplied. Optional `STUDIO_LIVE_VERIFY_RESEARCH=1` also exercises its actual source service. The gate creates synthetic temporary artifacts, calls the configured model, verifies persisted responses and source-backed child context, then archives its fixtures. It never treats deterministic transport fixtures as live-provider evidence.

The tests in `integration-agent.test.ts`, `integration-lifecycle.test.ts` and `integration-worker.test.ts` cover real HTTP protocol fixtures, real SDK MCP message exchanges, an actual ACP child process, cancellation, scoped credentials, revision conflicts, and atomic review rollback. These fixtures do not represent real OIDC, AI-provider, or Open Design account acceptance.

## Durable execution and harness selection

`GET` and `PUT /api/artifacts/:id/agent/profile` expose an artifact's separate harness, provider and model choices. T3 Code is the default. An unavailable T3 registration returns a visible capability reason and a 503 when invoked; configuring Vercel AI Gateway never changes that selection implicitly. Writers may explicitly select `vercel-fx`. When enabled, `remote-planner` is a third explicit selection; attaching a remote client cannot override the saved harness.

Register a trusted T3 executable with `STUDIO_T3_COMMAND` and its existing project with `STUDIO_T3_PROJECT`, both absolute paths. `STUDIO_T3_ARGS` is an optional bounded JSON argument array. `STUDIO_T3_PROVIDERS_JSON` contains the actual provider instance IDs and concrete model slugs registered in that T3 environment, shaped as `[{"id":"instance-id","label":"Operator label","models":["model-slug"]}]`. The first concrete registration supplies the default T3 provider and model. A registered runtime without a concrete catalog remains unavailable; durable jobs must not resolve mutable T3 project defaults later. The offline `project-default` entry lets the UI represent an unconfigured default honestly.

T3 executes through a Vercel AI SDK language-model provider. It calls the public `thread list/start/show --json` CLI, passes provider and model independently, sends private prompts through stdin, and uses stable opaque thread titles to recover completed calls. The AI SDK still performs tool dispatch and structured-output validation. T3 cannot call an unadvertised server tool or publish directly. Local T3 permissions and its own workspace belong to that operator-controlled environment; configure its permission policy before registering it. The child receives a small environment allowlist and no Studio credential variables.

The public CLI has no stop command. If `STUDIO_T3_MCP_URL` names the actual approved environment MCP endpoint and `STUDIO_T3_MCP_ACCESS_TOKEN` supplies its approved OAuth bearer, an aborted model call requests the advertised `t3_thread_interrupt` tool through the real MCP SDK. This is an interrupt request, not a claim that an external provider stopped billing. Without that registration Studio still cancels and fences publication, while the T3 run may continue in its own environment. Studio does not invent a T3 endpoint or silently replace unavailable T3 execution with a Gateway call. `STUDIO_FX_MODELS_JSON` optionally extends the explicitly selectable Gateway model catalog.

Every primary turn freezes its harness/provider/model, actor, source revision, bounded artifact/chat/ADR/reference context, and request hash in SQL. Title and implementation-drafting providers accept the same captured profile. Durable leases, monotonically increasing fences, bounded retries, step receipts and final atomic publication survive duplicate queue deliveries and process death. Completed provider calls may repeat if a worker dies before their receipt commits; there is no universal exactly-once model guarantee. A final SQL publication, receipt and completed status commit together. Cancellation, membership revocation, shared pause, source-version checks and implementation locks prevent stale publication. Queue messages carry job IDs only, and a transactional dispatch outbox retains uncertain sends for recovery.

Automatic participation is a durable delayed job rather than a process timer. A newer saved message supersedes queued automatic work; explicit mentions, solo conversations and group discussions use different quiet periods. Planner ownership is shared in SQL, with a bounded grace period and an explicit owner release operation. Human edits remain human-reviewed proposals, and research completion merges its request card into the latest canonical document while preserving concurrent human prose.

With per-user repository identity configured, both local and remote Planner tools require the selected owner's verified repository-read port. They fail closed if it is missing. The operator token cannot replace the user's credential. Only legacy workspaces without that identity feature can use the explicitly allowlisted operator GitHub credential.

## External Planner client

Enable the operator-owned transport with `STUDIO_REMOTE_PLANNER=on`, select `remote-planner` for the artifact, and run the already installed, authenticated ACP agent from its approved checkout:

```sh
# Keep the API credential in the environment or deployment secret storage.
node dist/server/planner-worker.js <artifact-uuid> \
  --checkout /absolute/approved-checkout -- /absolute/acp-agent <actual-args>
```

The client reads `STUDIO_API_URL` and `STUDIO_API_TOKEN`, negotiates `studio.planner.v1` at `/api/planner/connect`, and reconnects after ordinary transport loss. It never installs an agent. Credential, ownership and protocol rejection require resolving the reported condition. The server queues bounded incoming frames before asynchronous authentication and rechecks current authentication, project access, shared pause, implementation locks and connection epoch before outgoing data. Replacing a same-account socket fences the old attachment. A reconnect can receive the same outstanding request from another server instance; the durable job fence guards its result.

A custom client sends `{type:"attach",version:1,artifactId}` and receives `attached`, followed by `turn` messages containing `requestId` and frozen input. It replies with `{type:"result",requestId,output:{text,content:null}}`, or a complete proposed content object for an edit. `{type:"failed",requestId}` reports failure without exposing provider errors. Read-only repository RPC uses `{type:"tool",requestId,callId,name,input}` with the advertised tree/file/PR names and receives `tool-result`. Each turn has a bounded tool budget and its pinned repository revision. Cancellation or an expired/superseded execution lease rejects late results. This is Studio's versioned protocol, not a claim of Chopin wire compatibility.

## Paragraph visuals and verification scope

`PLANNER_VISUALS=on` (or `STUDIO_PLANNER_VISUALS=on`) enables routing for one anchored explanatory paragraph at a time, only for explicit member requests of at most 1,000 characters and bounded complete document source. `#block:<id>` selects a paragraph explicitly; otherwise the first eligible explanatory paragraph is considered. Possibility, comprehension and type decisions precede authoring a validated chart, diagram or tabbed comparison. The result is a source-version and block-digest-bound proposal for human review. No numeric evidence or passing test is synthesized as an execution result.

The executable source/test map is:

| Boundary | Source | Acceptance evidence |
| --- | --- | --- |
| Fenced jobs, recovery, final publication | `runtime/jobs.ts`, `runtime/contracts.ts` | `durable-jobs.test.ts`, `durable-jobs-postgres.test.ts` (actual SIGKILL, redelivery, multi-instance race, revocation) |
| Artifact agent, exact research, shared ownership, title/graph providers | `agent.ts`, `runtime/document-write.ts` | `agent-durable.test.ts` (actual SDK HTTP model/source/tool exchanges, reviewed proposals, pause, locks, idempotence, concurrent human prose) |
| T3 defaults and explicit alternatives | `agent-profiles.ts`, `t3-model.ts`, `shared/agent-profile.ts` | `t3-harness.test.ts` (actual child CLI protocol, real AI SDK tools and Output.object, profile persistence/freeze, MCP interrupt transport) |
| Cross-instance documents and authenticated fanout | `collaboration.ts`, `realtime/transport.ts` | `collaboration-distributed.test.ts` (real PostgreSQL and WebSockets, canonical seed/restart, incoming handshake queue, honest large presence, passive revocation, rollback) |
| External Planner and user-scoped repository tools | `remote-planner.ts`, `planner-worker.ts`, `repository.ts` | `remote-planner.test.ts`, `remote-planner-postgres.test.ts` (actual WebSockets and ACP child; independent server replacement preserves one publication), `agent-durable.test.ts` (user token distinct from operator token) |
| Signed local Open Design workflow | `open-design.ts` | `integration-lifecycle.test.ts` (actual MCP protocol fixture, immutable source, mode/start identity/poll/cancel, atomic review); requires the real installed signed runtime for live acceptance |

The public T3 0.1.5 npm archive was checked against its published SHA-512, and its Linux x64 release against SHA-256 `21d50dcc9c634221b11b58d6a94350d2c6ee36905737b054b11fa4eba295a98b`. The actual executable returned `t3 v0.1.5`; its `thread start --help` confirmed stdin `-`, separate `--provider`/`--model`, `--title`, and `--json`. This verifies the executable/CLI contract, not a provider login or a completed live T3 model call. No real T3 provider account or signed Open Design runtime is bound to the managed test environment.

The live gate now waits for the exact returned durable job ID. `STUDIO_LIVE_HARNESS=vercel-fx`, with optional `STUDIO_LIVE_PROVIDER` and `STUDIO_LIVE_MODEL`, explicitly selects the user-authorized alternative for that synthetic acceptance artifact. Omitting it retains the default T3 choice. The existing owner credential, dedicated project and explicit provider-usage gate remain required. Deterministic protocol fixtures cannot satisfy live-provider certification.


## Independent decision models

`GET` and `PUT /api/artifacts/:id/decision/profile` select a decision provider/model independently of the primary chat harness. Native `openai-decisions` calls the documented `/v1/decisions` predicate/choice/score API; native `jev` calls TypeSafe's `/v1/systemone` question-record API. Explicit `vercel-structured` uses the installed AI SDK and a registered structured model. There is no automatic fallback between providers or to the chat model. Offline native catalogs remain visible; unconfigured invocation fails visibly.

OpenAI uses `STUDIO_OPENAI_DECISIONS_KEY` or `OPENAI_API_KEY`; Jev uses `JEV_API_KEY` or `TYPESAFE_API_KEY`. Optional trusted operator endpoints are `STUDIO_OPENAI_DECISIONS_BASE_URL` and `STUDIO_JEV_BASE_URL`; production requires HTTPS. `STUDIO_JEV_MODELS_JSON` lists actual native models. Explicit structured models require `STUDIO_DECISION_SDK_MODELS_JSON` and the normal Gateway credential, optionally `STUDIO_DECISION_SDK_BASE_URL`. Workspace defaults use `STUDIO_DECISION_PROVIDER`, `STUDIO_DECISION_MODEL`, and `STUDIO_DECISION_MIN_CONFIDENCE`. Change `STUDIO_DECISION_CONFIG_REVISION` when credential principal or provider policy changes. Secrets never enter artifact profiles or provenance.

Queued consumers freeze both independent profiles. Decision receipts retain source/request hashes, typed questions/rubric, requested and provider-reported model, adapter and policy versions, native probabilities separately from reported confidence, nullable usage, latency, cache provenance and SHA-256. Provider-reported aliases remain explicitly unresolved; they do not identify immutable model weights. Idempotent/cache reads recheck authorization and receipt integrity. Same-scope cache lifetime is 30 minutes. Cached usage remains unknown rather than charging usage twice; changed provider registration rejects queued execution instead of rerouting it.

Native refusal and low certainty remain explicit. Jev malformed/null answers are errors, not fabricated refusals. Structured-generation candidates have no native certainty, so they abstain and remain reviewable. They cannot trigger automatic work. Authorization, ownership, pause, consent, approval, graph validation, test execution and formal proof remain deterministic.

UTF-8 source-plus-question envelopes are bounded at 32,000 bytes for Jev and 120,000 for other adapters, with 64 questions maximum. Catalogs expose those limits; oversized input fails without hidden truncation. The participation adviser labels its trailing selection and records original digest/byte counts. SQL budgets cover every actual attempt including retries: default principal/project limits are 120/600 per hour and 4/8 concurrent. Bounded overrides use `STUDIO_DECISION_PRINCIPAL_HOURLY`, `STUDIO_DECISION_PROJECT_HOURLY`, `STUDIO_DECISION_PRINCIPAL_CONCURRENT`, and `STUDIO_DECISION_PROJECT_CONCURRENT`. Cached/idempotent reads are free. Exhaustion remains observable `budget-exhausted`, never false eligibility.

Paragraph visual possibility/comprehension/type classifiers use central decision receipts; visual authoring uses the frozen primary harness. Eligible unaddressed automatic turns receive finite respond/wait/stay_silent advice after deterministic checks. Explicit mentions/manual requests bypass semantic suppression. Fresh pause/ownership/implementation-lock/source/latest-message checks still guard consequences. Abstention/refusal/error cannot create a reply. Generative questions, briefs, titles and graphs remain primary authoring.

`decision-models.test.ts` covers actual native HTTP/AI SDK transports with SQLite, distributions/refusals, unscored abstention, quotas, revocation and tampered receipts. `decision-models-postgres.test.ts` covers two actual PostgreSQL instances, duplicate delivery, budget races, stale fences, actual worker SIGKILL and graceful replacement. Set `STUDIO_TEST_POSTGRES_URL` for those cases. `agent-durable.test.ts` covers frozen visual/participation profiles and explicit bypass/late guards; `participation-adviser.test.ts` covers native HTTP with SQLite and optional PostgreSQL. These fixtures certify protocol and recovery behavior, not paid-provider account access or model accuracy.
