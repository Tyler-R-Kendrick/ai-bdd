# Artifact integrations and connected machines

The hosted agent uses the installed AI SDK and the configured AI Gateway model. It can read bounded file/tree/PR context from the selected GitHub repository, pinned to a captured commit. Private repository credentials are used only for the operator's exact repository allowlist. Project authorization is checked before and after awaited reads. Stable `#artifact:<uuid>` references resolve only inside the selected project and never change the edit target.

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

The adapter preserves the selected Open Design Cloud, Local Codex, or secure BYOK mode for the complete workflow. It sends the fixed first-party plugin attribution once during brief collection, preserves the server-issued workflow identity and brief confirmation, and stores signed machine context only on the server. A start request has one opaque stable identity; a lost response retries identical arguments, while polling only reads that run. Changed prompts need a new confirmed workflow. Cloud sign-in is never invoked for Local Codex or secure BYOK. Recharging requires an explicit resume action. Open Design Cloud or the selected BYOK provider owns usage costs.

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
