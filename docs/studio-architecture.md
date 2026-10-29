# Studio architecture and decision record

## Product boundary

Studio is a separate application package over ai-bdd's public SDK. It keeps the existing compilation, deterministic replay, judging, source grounding, and evidence verification behavior intact. The new application makes a project a composition of artifacts; each artifact owns its discussion, ADR, revision history, links, and test-run references.

The collaboration reference is [Chopin](https://githubnext.com/projects/chopin/) and its [open-source implementation](https://github.com/githubnext/chopin). The published reference combines rich documents, multiplayer presence, comments, durable decisions, agents, and MCP. Those are the baseline mechanisms, not a license to claim undocumented feature parity. [CucumberStudio](https://smartbear.com/product/cucumberstudio/) informs living specifications; [TesterArmy e2e](https://e2e.tester.army/) informs mixed agentic/deterministic execution and visual evidence. [fx0](https://fx0.vercel.dev/), [Open Design](https://open-design.ai/), [HyperFrames Studio](https://hyperframes.studio/), and [Rikyu](https://rikyu.ai/) inform the media-specific workspace interaction.

## Structure

```text
Browser
  ├─ Project/artifact navigation and typed media editors
  ├─ Rich text ↔ Yjs sync/awareness over authenticated WebSockets
  └─ Chat / ADR / test / history panels ↔ same-origin JSON API
                                     │
Fastify application                  │
  ├─ Session and project-role authorization
  ├─ Typed content validation and version checks
  ├─ SQLite transactions, assets, revision and audit history
  ├─ Provider-bounded AI task orchestration
  ├─ Trusted ai-bdd config → public SDK → driver/model adapters
  └─ Static built client

External agent → stdio MCP adapter → bearer-authenticated JSON API
```

No artifact can select a server module or shell command. The only executable test configuration is an operator-supplied path. Generated code runs inside an opaque-origin iframe with restricted network access, not in the API process.

## ADR: isolate the application from the engine

**Decision.** Add `@ai-bdd/studio` and consume the SDK's public API. Keep existing package boundaries and CLI behavior.

**Reason.** The repository already has a tested engine. UI work should expose its real plans and results instead of inventing a second test protocol or replacing stable behavior.

**Consequence.** Application code and its test/build configuration live in the new package; the existing repository checks still run. The trusted runner config can reuse existing driver/model packages.

## ADR: use durable artifact identity for every context

**Decision.** Use UUID identities for projects, artifacts, discussions, ADRs, runs, and assets. A project has one main design artifact. Artifact creation atomically inserts the artifact, initial revision, dedicated ADR, and main discussion thread.

**Reason.** Renaming an artifact must not detach its conversations or decisions. A shared generic chat would make attribution and test traceability ambiguous.

**Consequence.** Foreign keys enforce the relationships. Endpoints check project membership through the artifact rather than trusting an independently supplied project ID. An artifact's associated threads cannot be reused to post to another artifact. The main design artifact cannot be archived. ADR changes are version checked and the prior record is retained in audit details.

Discussion pages use stable sequence ordering and cursors bound to both artifact and thread. Browser and MCP clients can load older context explicitly; an artifact export streams the complete associated chat history rather than silently truncating it to the interactive bundle's recent-message limit.

## ADR: merge rich documents, version media documents

**Decision.** Rich documents use TipTap/ProseMirror with Yjs CRDT synchronization. Other media use typed JSON content and optimistic version checks.

**Reason.** Real-time prose editing requires merge behavior. Independently edited geometry, source files, or timeline properties should not silently replace remote changes.

**Consequence.** A received document update is tested against a candidate CRDT, converted to the supported editor schema, validated, and persisted before it is broadcast. API document replacements use the same CRDT as connected editors. Presence labels are tied to authenticated user identity. Media saves carry the last-read version; stale saves fail with HTTP 409 and leave the local draft available for recovery. Durable events trigger context refresh, while transient awareness supplies participants and cursors. Offline editing is not an independent trusted authorization mode.

The supported rich-text format is a restricted data schema. It is not arbitrary executable MDX. Inline test and research nodes are data-backed components. Comments use stable block IDs plus a retained quote; deleting a block can make its anchor unavailable while the discussion and quote remain readable.

## ADR: single-process SQLite storage

**Decision.** Use Node's SQLite implementation with WAL, foreign keys, synchronous durability, bounded payloads, and one writer process.

**Reason.** It provides a runnable deployment without an external database account and permits atomic artifact creation and revision storage.

**Consequence.** Horizontal application scaling and overlapping rolling releases are unsupported. A persistent volume is mandatory. Uploaded assets are stored in the database; runner plans, recordings, and evidence use the artifact workspace directory. Restarting marks incomplete jobs interrupted. A future multi-instance design needs a different coordination/storage decision rather than a second process pointed at this volume.

## ADR: authorize browser and agent operations identically

**Decision.** Use HttpOnly SameSite browser session cookies and hashed personal bearer tokens for MCP. Project roles are owner, editor, or viewer. Membership controls access, including WebSocket handshakes and updates.

**Reason.** Agent access must not bypass the authorization boundary used by humans. Linking a repository URL is not proof of access to that repository.

**Consequence.** Owners manage membership, editors change project artifacts, viewers read. Cookie mutations require the configured browser origin; bearer requests are independently authenticated. Login attempts are rate limited. Session/token expiration is checked during authenticated operations and existing connections are periodically rechecked. API tokens carry their owner's identity and project permissions. An external agent is therefore attributable to its token owner; it is not an independently provisioned service identity.

Forwarded client addresses are trusted only for operator-configured `STUDIO_TRUSTED_PROXIES` IP/CIDR hops; the default is false. This keeps a client-supplied forwarding header from choosing its own login limit identity. Authenticated API budgets use the account identity and exclude static assets. Payload and storage bounds include 10 MB per upload, 512 MB of uploaded assets per project, 500 artifacts per project, and 100 projects per account.

Production requires HTTPS configuration, refuses demo mode, and does not expose interactive first-owner setup. OIDC uses PKCE, state, nonce, a verified email, and explicit admission. Real identity-provider behavior remains a deployment validation step. Password/email invitation delivery and identity-provider group synchronization are not implemented.

## ADR: treat evidence as versioned output

**Decision.** A test run stores the artifact version it was started against. Plans and scenario reviews use the existing engine. Evidence downloads must refer to a stored run's declared evidence, stay within its real run directory, and pass their recorded SHA-256 check.

**Reason.** A green result for an old design must not appear to certify a later edit, and a file path from a result must not authorize unrelated filesystem reads.

**Consequence.** Later artifact changes mark earlier evidence stale. Queued jobs, running jobs, failures, cancellation, interruption, and infrastructure errors are distinct from passing tests. Missing model/runner configuration is returned explicitly. No preview fixture, synthetic screenshot, or successful compilation is labeled as a live passing run.

## ADR: keep previews independent of providers

**Decision.** Code previews execute inside a sandboxed opaque-origin frame and use explicit contract fixtures for external HTTP boundaries. JSON-render and OpenUI previews use a bounded catalog of application-owned components.

**Reason.** Unavailable integrations should not prevent interface development, and model-generated UI should not gain arbitrary application capabilities.

**Consequence.** Preview responses are declared mock data. Pact consumer/provider checks verify the covered boundary in CI, separately from live provider health. Generated UI cannot register arbitrary components or execute unrestricted server logic. Full frontend package installation, production deployment of generated applications, and arbitrary server-side code execution are separate product capabilities.

Public GitHub PR state refresh does not need a token. A private API token is restricted to exact `owner/repo` entries in `STUDIO_GITHUB_REPOSITORIES`; it is never sent to an arbitrary pasted host or unlisted repository. The allowlist is a deployment admission choice and must contain only repositories appropriate for the deployment's users. Built fonts/editor assets are local, a third-party license notice is emitted with the client, and executable module assets are not inlined as data URLs.

## ADR: verify small mathematical statements before claiming a larger proof

**Decision.** Share the responsive allocation model with an exact rational interval checker, and exhaustively verify the finite production role predicate. Keep browser tests separate. Accept a future general-purpose execution proof only through a fail-closed external verifier boundary.

**Reason.** [The Calculus of Interfaces](https://calculus-of-interfaces.vercel.app/) and [handwired](https://github.com/chenglou/handwired) show how an explicitly constructed interface can become a mathematical function. They do not establish an automatic proof for this entire React application.

**Consequence.** The shipped proof scope is column geometry for every real width from 320 to 4096 and all nine role/action predicate cases. It excludes font metrics, text wrapping, asynchronous backend state, arbitrary generated artifacts, and external services. The optional Magnetar adapter requires a real cryptographic verifier and binds its verdict to program, input, output, and proof digests. No Magnetar runtime is bundled, and its absence cannot produce a positive proof verdict.

## Operational trust assumptions

The host administrator can read the data volume, run the trusted test config, install verifier adapters, and change deployment secrets. Those are operator privileges, not privileges granted to an artifact author. Studio does not make the SQLite audit log tamper-proof against that host administrator. Protect storage and backups with the deployment's own encryption, access controls, and retention policy.

The AI provider receives the selected artifact, relevant ADRs, and a bounded discussion context when a model action is invoked. Do not infer provider privacy/retention terms from this application. No raw provider credential is intentionally included in artifact or chat content. Generated research without live search is labeled accordingly; source claims require review.
