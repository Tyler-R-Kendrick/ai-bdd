# Studio release scope and evidence

This record describes the first artifact-centered application added to ai-bdd. It must be read alongside actual command results and CI for the exact commit being reviewed. A feature being present in source does not mean its live provider or production deployment has been validated.

## Implemented scope

| Area | Implementation | Validation boundary |
| --- | --- | --- |
| Project composition | Main design artifact and typed child artifacts; project canvas and navigation | API/browser scenarios cover the supplied workflows; arbitrary project scale is not certified |
| Artifact identity | Artifact-bound main chat, paginated older discussion context, anchored threads, dedicated ADR, revisions, audit trail, streamed complete export | Transaction/isolation/conflict/cursor tests; host administrator can still alter database files |
| Rich documents | TipTap tables, lists, code, links, math, images, inline test/research components | Restricted schema; no arbitrary executable MDX or complete Word/Docs compatibility |
| Collaboration | Yjs document merging, awareness/presence, authenticated WebSockets, durable server state | Concurrent-client/restart/permission tests; one application writer process |
| Agent work | Configured AI Gateway chat, edit proposals, bounded research-note generation, cancellation | Provider calls need real credentials; research is explicit about missing live search |
| Test workflow | Existing ai-bdd compilation, grounded plan review, strict frozen run queue, status and evidence | Operator-trusted config required; no default fabricated passing results |
| Test provenance | Artifact-version association, stale evidence display, hash/path-checked evidence download | Engine and API tests; actual target/model execution requires a configured deployment |
| Code | Source editor and sandboxed HTML/CSS/JS preview with declared boundary fixtures | Browser isolation/preview tests; no arbitrary server execution or universal package bundler |
| Generated UI | Actual JSON-render and OpenUI runtimes with application-owned catalogs | Catalog/source validation tests; a generated UI is not automatically behaviorally correct |
| Images and branding | Editable vector/text layers, properties, ordering, export | Browser-supported formats and fonts; no complete raster editing/font-authoring suite |
| Video | Timeline-based layered composition, playback/seeking, browser-native WebM export | Browser API availability applies; no HyperFrames project interchange or full audio/video production suite |
| 3D/CAD | Parametric primitives, transforms, unit-aware properties, solid operations and export within the supplied editor | Browser/kernel checks; no complete exact BREP CAD feature parity |
| Links | Artifact references and GitHub pull-request state refresh; private credentials restricted to an explicit owner/repo allowlist | Provider availability and deployment repository admission still apply; enterprise-host integration is not certified |
| Identity/access | Password sessions, OIDC implementation, project roles, hashed API tokens, origin checks, account-based API limits, explicit trusted-proxy IP/CIDR handling | Local security/integration tests; real organization OIDC must be tested against its issuer |
| MCP | Stdio tools through the same API/permissions, versioned writes, chat/ADR/test/history operations | Protocol tests; external-client registration and real deployed credentials are separate |
| Deployment | Non-root container, durable SQLite volume, healthcheck, graceful shutdown/recovery, backup procedure | Container startup/restart tests and CI; no multi-instance/HA support |
| Mathematical verification | Exact interval certificate for shell geometry and exhaustive production role predicate | Explicit small proof scope; not a whole-system correctness or security proof |
| General-purpose proof gate | Strict digest-bound external verifier adapter | Fail-closed boundary tests; no bundled Magnetar runtime or generated proof |

## Required release evidence

For an exact release commit, the following gates must pass without weakening the existing engine checks:

1. Existing repository build, typecheck, lint, tests, and structural checks appropriate to the changed files.
2. Studio typecheck and built client/server output.
3. Studio API and authorization tests, persistent collaboration tests, Pact consumer/provider verification, MCP protocol tests, and verifier tamper tests.
4. Real Chromium acceptance tests including save/reload, artifact-context isolation, and preview isolation. Desktop/mobile captures are visual evidence only for their captured states.
5. The exact interval/permission checker, whose JSON report states its proof scope and external-proof status.
6. A real container build and production-mode health/restart/demo-refusal checks.

The workflow in `.github/workflows/studio.yml` runs the application checks and container checks. It does not contain deployment credentials or silently substitute a fake live service. Test fixtures and protocol doubles are testing infrastructure, not application modes or live-provider evidence.

## Observed validation on 2026-10-29

The local implementation checks below passed while assembling the review stack. Skips remain visible; they are not counted as passes. The foundation head `0b85719` passed its hosted API matrix and existing repository CI. The workspace head `94504f6` passed hosted API, UI, and existing repository CI. The release-layer workflow must also pass on its own published head; these earlier results do not certify an uncompleted newer run.

| Check | Observed result | Scope |
| --- | --- | --- |
| Studio Vitest | 85 passed in 17 files | API/access/storage, authorization revocation across awaited work, OAuth request-log redaction, collaboration, real Chromium runner fixture, Pact, media helpers, MCP, and verifier boundaries |
| Combined Studio browser cases | 16 passed | Implemented editor and artifact workflows in real Chromium |
| Curated capture rerun | 1 passed | Screenshot evidence refresh with no application-source change |
| Visual review | SHIP for 14 captured PNG states, with recorded limits | The captured desktop/mobile/editor states, not live integrations or all application executions |
| Exact interface checker | Six rational interval certificates and all nine role/action predicate cases passed | Real viewport widths 320–4096; general-purpose execution proof explicitly remains unverified |
| Production container | Clean image build and all seven smoke checks passed | Non-root/read-only startup, demo refusal, secure login cookies, durable artifact/chat/ADR context, stale-write rejection, real restart, and packaged Chromium |
| Existing root unit suite | 4,868 passed; 163 skipped | Local baseline environment |
| Existing acceptance suite | 102 passed; 16 skipped | Local baseline environment |
| Existing adversarial suite | 289 passed; 24 skipped | Local baseline environment |
| Existing fuzz suite | 178 passed | Local baseline environment |
| Existing chaos suite | 176 passed; six skipped | Local baseline environment |
| Repository script suite | 117 passed | Repository checks and tooling behavior |

The final tested container image is `sha256:3b410b07899c039fd360cb1848086474299b2b4542b08e823de8a81dba13a1dc`. It includes the authorization-revocation guard changes published as `6efb78c`, request-log redaction, and the writable Chromium XDG paths added in `03dc822`. The smoke report records that immutable ID rather than relying only on a mutable tag. Test accounts and artifact contents were synthetic fixtures and were removed with their temporary container/volume. The exact-check report, container report, build log, and a scoped verification screenshot accompany the review evidence.

The first hosted image run at `9dadf4c` built successfully but exposed Chromium crashpad initialization against a read-only home directory. The fix sets `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` beneath writable `/tmp`; the smoke also asserts those values before launching the actual packaged browser. The corrected full local image passed all seven smoke checks without relaxing the non-root user, read-only filesystem, or dropped capabilities. Hosted results for subsequent heads belong to their own CI runs.

The container smoke specifically verified that a login session, saved code artifact, artifact-bound chat, and accepted ADR survive a real process restart; it also launched the image's own Chromium under the read-only filesystem and dropped-capability restrictions. The clean-image build caught and fixed a build-order requirement for the development-only `@ai-bdd/testing` type fixture. CI installs Chromium before the Vitest stage because the runner tests use a real browser. The deterministic runner fixture explicitly enables its temporary writable recording store; production CI recording defaults remain read-only. All 85 Studio checks also passed locally with `CI=1` after this fixture correction.

## Live capabilities requiring deployment validation

| Capability | Why it cannot be inferred from local checks | Required evidence |
| --- | --- | --- |
| Organization OIDC | A concrete issuer/client registration and admission policy are external | Successful allowed-user login, rejected unadmitted user, issuer/token errors, and session expiry against that issuer |
| AI chat/edit/research | No provider key or model entitlement is assumed | Successful bounded call, cancellation, provider failure, proposal review, and privacy/retention review for the selected provider |
| Real target testing | Local runner tests use a real browser with deterministic model fixtures; production runner config still selects a real target, model, driver, secrets, and navigation policy | Reviewed grounded plan, first model-backed characterization, independent confirmation, deterministic replay, failing run, and downloaded evidence integrity against that deployment |
| Open Design integration | The independently installed local Open Design service is not available by default in a server deployment | A real installed/authenticated service and its documented workflow; Studio reports the capability unavailable until integrated |
| Magnetar | A paper and digest manifest are not an installed prover/verifier | Real cryptographic proof generation and verification bound to the program/input/output; the gate must stay unverified until then |
| Public production operation | DNS, TLS, backups, monitoring, and real user traffic belong to a concrete deployment | HTTPS access, restore rehearsal, monitoring/alert checks, capacity/load testing, and operator sign-off for that environment |

## Deliberate limits

Complete feature parity with the five referenced products is **not established** by this implementation. Those products include evolving or proprietary workflows well beyond the implemented surface: rich MDX component catalogs and repository identity rules, Google Docs import/export and review machinery, advanced image editing, full video pipelines, exact CAD modeling, font generation, and broad external-provider integrations.

SQLite is a single-writer deployment choice. There is no multi-region replication, zero-downtime overlapping rollout, or guarantee of high availability. Long-running jobs are cancelled on graceful shutdown and marked interrupted after a restart; they are not silently resumed as successful.

The exact layout proof excludes text measurement, browser floating-point rendering, WebGL, and asynchronous application behavior. API/browser tests add evidence for specified examples, not a proof of all possible executions. The optional external verifier is trusted operator code and must actually verify a cryptographic proof.

These boundaries should remain visible in release descriptions. A green local suite supports the tested implementation; it does not justify the statement “all requested parity and live integrations are production verified with no remaining issues.”
