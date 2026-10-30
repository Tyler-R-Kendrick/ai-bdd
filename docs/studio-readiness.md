# Studio release scope and evidence

Studio now includes shared artifact documents, dedicated media editors, exact-solid CAD, reviewed implementation graphs, connected machines, and durable PostgreSQL/object-storage/job adapters. **Full requested parity and live production readiness have not yet been established.** The [requested-scope matrix](studio-scope-matrix.md) maps requirements to implementation, evidence and remaining work. See also the [architecture](studio-architecture.md) and [deployment runbook](studio-vercel-deployment.md).

A component test, a screenshot, a provisioned database and a deployed production workflow establish different facts. Later source changes need checks on their own release commit.

## Current evidence

Published commit `5220dfe144f5d844d57abaf9fbc9967267047495` passed hosted `ci`, `studio-api`, `studio-ui` and `studio` workflows. Its Studio job recorded **127 unit tests in 26 files and 16 real Chromium browser cases**. Its image job exercised production startup, durable artifact context, browser availability and demo refusal. These receipts predate subsequent cloud, lifecycle, decision-model, device and audio/MIDI additions; they do not certify those additions.

Subsequent component suites exercise actual SQLite and PostgreSQL 17 transactions, two-instance permission races, process-death recovery, source/version fences, immutable object snapshots, real Chromium testing and media rendering, and native provider HTTP protocols. The matrix names those checks instead of adding overlapping counts into a final total. The assembled release needs fresh complete CI and reviewed captures on its exact published head.

Screenshots establish only their captured state. Saved/reloaded artifacts, unsaved font drafts, isolated harnesses and application test targets must be labelled accordingly. The runner's Acme billing capture is a **test target**, not Studio UI. Older reports and captures under `docs/studio-evidence` remain historical receipts; their former counts and limits are not current final-head evidence.

## Deployment state

The replaceable production composition uses PostgreSQL for canonical state and fences, private object storage for assets/evidence/workspaces, and durable job/outbox/queue/scheduler ports. SQLite and disk remain documented local single-writer adapters. PostgreSQL multi-instance tests do not establish production capacity, high availability, multi-region operation or a restore rehearsal.

The Vercel project `ai-bdd-studio` is linked to `Tyler-R-Kendrick/ai-bdd` and configured for Node 24. An isolated Neon production database has been created and queried on PostgreSQL 17.11. At this update, Vercel authorization for private Blob creation and production environment bindings is pending actual user consent. **No production Studio deployment, bound Blob store, deployed queue execution or live model turn has been verified.** Credentials are not recorded here.

The hosted composition is a stateless container with external durable state. Trusted deployment metadata supplies preview origins; production requires an exact canonical origin. Queue/cron bridges authenticate internal requests; SQL intents preserve recovery across process loss. A dispatch acknowledgement is not completion, and external provider/coding effects are not claimed to execute exactly once.

T3 is the default generative harness. Without an operator-registered trusted binary, project and authenticated provider, it reports unavailable. Vercel/fx requires explicit selection and configuration. Decision models have a separate profile and provider boundary. Local HTTP fixtures and actual T3 version/help checks do not establish successful paid-provider inference.

## Mathematical and execution-proof scope

The release gate includes six exact rational certificates for shell allocation over every real width from 320 to 4096 pixels and nine production role/action cases. An actual Handwired operation graph is checked with Z3 on a 1/64-pixel lattice and 483,330 exhaustive FP32 tensor-equivalence cases. These small properties exclude text measurement, asynchronous behavior, WebGL and general application correctness.

The optional Magnetar experiment now generates real proofs using independent `Lulzx/open-magnetar` commit `febfc0e66f5809e034dd1afac78202bd4882de27`. The [report](studio-evidence/continuation/magnetar/report.json) records eight public layout-guest executions, digest bindings and tampered proof/input/output rejection. This is a non-audited independent implementation, not Microsoft's official implementation or a production certification. It proves those executions; the all-real-width result comes from the separate rational checker. Confidential witnesses and whole-application proofs are not established.

## Required release gates

1. Run the repository checks and complete assembled Studio typecheck, build, lint, API, SQLite, **mandatory actual PostgreSQL**, native protocol and browser suites on the release commit. Skipped PostgreSQL checks are not passing PostgreSQL checks.
2. Complete the new audio/MIDI editors with save/reload, permissions, bounded decoding, render/export and actual browser evidence. Boundary guards alone are not complete editors.
3. Complete the living-document delivered-baseline and existing-PR rebuild workflow. Drafting a new graph is not rebuilding an existing PR. Automatic mode needs explicit machine/repository consent, source settle handling, fresh permissions, scoped reports and safe retries. Completeness advice cannot veto Build.
4. Finish independent decision-profile consumer wiring and its provenance, refusal/abstention, snapshot and PostgreSQL recovery acceptance. Evaluate classifier accuracy separately from transport correctness. Models must not authorize access, approve builds, accept ADRs or claim formal verification.
5. Refresh assembled desktop/mobile captures, self-review every PR against its claims and retain exact commit/command/capture provenance. Close an explicit Chopin reference inventory before claiming complete parity.
6. Complete authorized platform bindings and deploy the reviewed source. Verify HTTPS, sessions, live identity/provider behavior, object/evidence integrity, actual queue recovery, cancellation and drain/restart in that environment.
7. Rehearse database/object restoration and verify monitoring, alert delivery, limits, load/capacity, retention and operator recovery. A clean image or provisioned database does not complete these gates.

Open gates are remaining requested work, not approved exclusions. The evidence supports specific documented workflows, not a claim of complete reference parity and issue-free production operation.
