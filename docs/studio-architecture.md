# Studio architecture and decisions

Studio is an application over ai-bdd's public acceptance SDK. A project is a
composition of durable artifacts, led by a design document. Each artifact owns
its source, canvas, conversations, ADRs, revisions, evidence and activity.
The [release record](studio-readiness.md) distinguishes implementation evidence
from acceptance against a particular deployment.

## Product references

[Chopin](https://githubnext.com/projects/chopin/) informs multiplayer planning,
attributed decisions, agent participation, research children and implementation
handoff. Its public README and linked workflows were inspected on 2026-10-29/30.
[fx0](https://fx0.vercel.dev/) informs artifact chat and code iteration.
[CucumberStudio](https://smartbear.com/product/cucumberstudio/) informs living
specifications and inline tests. [TesterArmy](https://e2e.tester.army/) informs
grounded execution, confirmation, replay and visual evidence.

[Open Design](https://open-design.ai/),
[HyperFrames](https://hyperframes.studio/) and [Rikyū](https://rikyu.ai/) inform
media-specific editors. These are independently implemented workflows.
The Open Design adapter calls an independently installed signed local runtime.

## Runtime composition

The browser's editors, authenticated WebSockets, external MCP clients and
user-controlled ACP connectors share the authorized Fastify API. Canonical
relational state uses a SQL adapter. Assets and workspaces use a private object
adapter. A transactional outbox dispatches immutable job identities to a
replaceable queue; fenced workers call configured providers and the existing
acceptance SDK.

The selected cloud composition uses Vercel behind adapters: PostgreSQL stores
relational state and coordination, private Blob stores immutable objects,
Queues deliver job identities, and a container service contains Chromium and
FFmpeg. Static client delivery and queue ingress are separate from the API
container. Local mode retains explicit SQLite/disk adapters. The deployment
runbook records exact bindings and platform availability.

## ADR: preserve the engine

Studio consumes public SDK operations rather than replacing compilation, source
grounding, deterministic replay, confirmation or evidence integrity. Only an
operator-selected runner configuration supplies executable adapters. Artifact
content cannot choose a server module or shell command. Generated frontend code
runs in an opaque-origin sandbox.

## ADR: durable artifact identity owns context

Creation atomically inserts the initial revision, dedicated ADR and main
discussion. References use stable IDs. Thread cursors bind artifact and thread;
typed asset references bind project ownership. Renaming cannot move a
conversation. Append-only history uses bounded cursor pages, independently of
the interactive recent-message window.

## ADR: merge prose and version media

Prose uses TipTap/ProseMirror and Yjs. Stable block IDs are canonicalized in both
JSON and actual CRDT state before persistence, including imports and agent
writes. A candidate update is validated and committed before publication.
Viewers never rewrite source simply by reading. Project locks serialize
canonical updates; separate API instances converge through durable state.

Other media use typed source and optimistic versions. Stale saves return 409 and
retain the local draft. Presence has authenticated identities and bounded
leases. Periodic access checks remove revoked passive peers.

## ADR: durable fenced jobs replace process-local execution

Admission stores principal, source version, immutable hashed input, idempotency
key and dispatch intent. Workers claim renewable leases with increasing fences.
Completed named external steps retain durable receipts. Final SQL publication,
its receipt and terminal job result commit atomically through the same Store.

An external call can repeat if its worker dies before recording the receipt.
Exactly-once provider execution is not promised. Fence-specific immutable
staging prevents old attempts from replacing new outputs. Cancellation, rights,
source revisions and deadlines are rechecked before publication. Durable cleanup
intents reconcile staged objects. Starting another API process does not globally
interrupt active work.

The transactional dispatch outbox and fenced maintenance generation survive
process loss. Queue payloads contain identities, not private source snapshots.
Internal calls require bounded signed path/body/expiry authentication. A daily
Cron bootstrap and persisted delayed tick chain recover work without multiplying
schedules across deployment generations.

## ADR: browsers and agents share authorization

Owners administer, editors author and viewers inspect. Cookies are HttpOnly and
SameSite; mutations check canonical origin. Hashed personal MCP tokens inherit
current owner permissions. Source transactions recheck rights under the project
lock after awaited work. Trusted proxy CIDRs are explicit.

Browser sign-in uses GitHub with durable one-use state, browser-bound PKCE
and a stable qualified identity. A valid GitHub identity automatically receives
a passwordless internal user record; no local signup, invitation, owner-email
setting or email claim is required. The preferred Vercel Connect adapter uses
the official OAuth/PKCE contract through a fresh server-side identity scope.
Its fixed authenticated userinfo endpoint supplies an opaque subject qualified
by issuer and canonical connector. Any returned ID token still receives issuer,
audience, timestamp and signature validation and must match userinfo. Direct
GitHub OAuth retains numeric GitHub IDs in a separate binding. Concurrent first
sign-ins serialize identity lookup, user creation and binding; existing bindings
retain their user IDs. Email never links or transfers an account. The historical
email column uses a random internal identifier for newly provisioned users.
Project membership still controls access to existing projects, and owners can
add a signed-in teammate by Member ID. Password/setup/demo and generic
organization OIDC sign-in are disabled; provider failure leaves a visible retry
state. Historical browser sessions without GitHub provenance are rejected,
while API bearer credentials retain their separate policy.

Repository authorization is separate from sign-in. Per-user GitHub credentials
use a stable-key encrypted vault. Refresh and permission leases
coordinate across instances; signed webhooks fence stale grants. An operator
token cannot grant repository access to a participant. Account linking remains
reachable before project admission succeeds.

## ADR: local defaults and explicit free-only model alternatives

Genuine managed T3/OpenCode with pinned downloaded Qwen weights is the default
authoring harness. Explicit Local CPU and Vercel/fx selections remain separate.
Finite decisions have an independent persisted provider/model/threshold and
default to native local conditional label likelihoods, with explicit abstention
and uncalibrated provenance. Neither picker changes the other.

Optional Gateway authoring, structured generation and native evaluation must
pass the [free-only model policy](studio-free-models.md) on every attempt.
Fresh catalog and endpoint metadata must show exact zero fees; unknown or paid
routes, unverified transports and fallback routing fail before inference.
Provider unavailability never changes the selected harness or grants authority.

## ADR: retain decisions separately from prose

Questionnaire answers and accepted suggestions retain author, source anchor/hash,
rationale and accepted ADR identity. Acceptance atomically changes source and
decision state. Rewriting prose cannot rewrite an accepted decision. Restricted
MDX is data rather than executable JSX. Bounded Markdown/DOCX/HTML/PDF interchange
uses authenticated media; XML cannot resolve external entities.

Human titles are protected by default. Explicit automatic-title policy or actual
generated creation permits bounded model-backed maintenance. Beginning a human
rename claims the title before drafting, invalidating in-flight model work.
Shared pause, ownership and implementation locks apply to background actions.

## ADR: previews work across unavailable integration boundaries

esbuild bundles bounded project files and installed browser packages. Actual
Tailwind compilation supports static utilities and local themes, refusing
JavaScript plugins, package installation, filesystem scans and external style
imports. Requests replay declared Pact interactions; unmatched requests fail.
Pact consumer/provider verification runs separately in CI.

JSON-render and OpenUI use their actual installed runtimes with application-owned
catalogs. They cannot register arbitrary server capabilities. Preview fixtures
and successful compilation never imply a live passing acceptance test.

## ADR: preserve editable media and real export paths

Images and branding retain vector paths, raster masks/crops/adjustments and font
contours/metrics. Portable packages embed bytes and rebind ownership on import.
SVG, PNG and installable TrueType output have independent validation.
See [visual authoring](studio-visual-authoring.md).

Video retains layers, timing, keyframes, captions, source media and audio.
Rendering uses actual Chromium/FFmpeg behind a replaceable port. HyperFrames
HTML interchange has explicit compatibility boundaries.

Scenes retain mesh/material/light source and self-contained GLB/STL imports.
CAD retains dimensioned sketches, ordered features and exact Open CASCADE B-reps
with STEP interchange. Only the trusted compiled kernel worker permits required
dynamic binding invokers; the application retains its stricter script policy.
Full LGPL, exception and replaceable-source notices ship with the kernel.
See [3D and CAD](studio-cad.md).

## ADR: prove explicit interface statements

The [Calculus of Interfaces](https://calculus-of-interfaces.vercel.app/) informs
the shared allocation model. Studio vendors the pinned MIT Handwired numeric
runtime, evaluates its actual compiled circuit over 483,330 FP32 tensor cases,
and uses Z3 to prove equivalence on the supported 1/64-pixel grid. An exact
rational checker separately proves shell allocation for all real widths
320–4096. The production role predicate is exhaustively checked. These claims
exclude text measurement and asynchronous whole-system behavior.

An optional research pipeline builds a checksum-pinned independent Magnetar
implementation, compiles the layout guest to RV64I, and generates/verifies real
cryptographic execution proofs. Tampered proofs and public input/output must
fail. The adapter recomputes the verifying key from the program and binds
explicit input/output and digests to the release gate. This implementation is
unaudited, is not Microsoft's code and is not a production security
certification. Only public synthetic inputs enter the research path.

## Operational trust

Operators control executable configurations, SQL access, secrets, providers and
local agents. SQL audit is not tamper-proof against its administrator. Secrets
belong in platform bindings; the chosen backup service requires encryption and
an actual restore rehearsal. Enabled model actions send bounded artifact and
discussion context to the selected provider. Research sends the exact submitted
brief to its source service. Provider retention and billing depend on the
selected account and contract, not local tests.
