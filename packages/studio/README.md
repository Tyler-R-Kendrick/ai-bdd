# ai-bdd Studio

Studio is an artifact-centered collaborative workspace built on the ai-bdd engine. Projects compose design documents, code, visual design, video, 3D, and exact CAD artifacts; each artifact keeps its own discussion, ADR, revisions, and linked evidence. The [current scope and readiness matrix](../../docs/studio-readiness.md) records implemented workflows, tested evidence, integration requirements, and the limits of verification.

## Development

Use Node 24 and the repository's pinned pnpm version.

```sh
pnpm install --frozen-lockfile
pnpm --filter @ai-bdd/sdk build
pnpm --filter @ai-bdd/driver-playwright build
pnpm --filter @ai-bdd/models-ai-sdk build
pnpm --filter @ai-bdd/testing build
pnpm --filter @ai-bdd/studio dev
```

In a second terminal:

```sh
pnpm --filter @ai-bdd/studio dev:ui
```

The API listens on `http://127.0.0.1:8787`; the Vite client defaults to `http://localhost:5173`. Set `STUDIO_ORIGIN=http://localhost:5173` on the API when using Vite, because cookie mutations and WebSocket handshakes check the browser's exact origin. Open that same Vite origin in your browser.

An empty development database offers local owner setup with a password of at least 16 characters. `STUDIO_DEMO=1` explicitly enables a local sample account. Production refuses demo access and interactive setup.

For a single built process:

```sh
pnpm --filter @ai-bdd/studio build
pnpm --filter @ai-bdd/studio start
```

## Release checks

```sh
pnpm --filter @ai-bdd/studio typecheck
pnpm --filter @ai-bdd/studio exec playwright install chromium
pnpm --filter @ai-bdd/studio test
pnpm --filter @ai-bdd/studio verify
pnpm --filter @ai-bdd/studio test:e2e
```

The existing repository checks remain required. Studio's workflow adds API/security, collaboration, Pact, MCP, browser, exact layout, and container checks. Passing these is evidence for the tested scope, not a claim that arbitrary generated artifacts are correct.

## Production deployment

The default hosted composition is **Vercel Services + external PostgreSQL (Neon) + private Blob + Queues**, behind replaceable runtime adapters. Follow the [Vercel deployment and recovery runbook](../../docs/studio-vercel-deployment.md) for configuration, identity, large uploads, queue bootstrap, deployment checks, and restore. Runtime staging is disposable; SQL and private object references carry durable state. T3 is the default artifact harness and requires its actual runtime/provider registration. Vercel/fx is an explicitly selected alternative; unavailable T3 does not silently switch providers. Cloud service provisioning and live validation remain separate release evidence.

For the local SQLite/disk adapter, build from the repository root:

```sh
docker build -f Dockerfile.studio -t ai-bdd-studio:local .
```

In a managed build environment using a TLS proxy, supply its public CA through a BuildKit secret rather than copying it into an image:

```sh
docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" -f Dockerfile.studio -t ai-bdd-studio:local .
```

Copy the variable names from `.env.example` into an ignored deployment file `.studio.env` at the repository root. Set a real HTTPS `STUDIO_ORIGIN`, the authorized first-owner `STUDIO_ADMIN_EMAIL`, and the configured GitHub sign-in adapter. The direct GitHub OAuth adapter uses `STUDIO_GITHUB_SIGNIN_CLIENT_ID` and `STUDIO_GITHUB_SIGNIN_CLIENT_SECRET` with callback `/api/auth/github/callback`. Password and generic organization OIDC login are disabled. Model integrations and the acceptance runner are separate capabilities. No populated secret file belongs in a commit or image.

```sh
docker compose -f docker-compose.studio.yml up -d --build
```

The compose service binds only `127.0.0.1:8787`. Put it behind an HTTPS reverse proxy on the configured public origin. The proxy must forward WebSocket upgrades for `/api/collaboration/*` and `/api/projects/*/events`, preserve the public `Origin`, allow up to the upload limit, and use a suitably long upstream timeout for agent and compile requests. The app does not trust arbitrary forwarded identity headers. An illustrative Caddy configuration is:

```caddyfile
studio.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Set `STUDIO_TRUSTED_PROXIES` to a comma-separated list of the **actual trusted proxy hop IPs/CIDRs** when forwarded client addresses are needed for login rate limits. It defaults to no trust. Use the proxy address seen inside the application network; a host reverse proxy connecting through Docker may appear as a bridge gateway rather than loopback. Do not set a universal Internet CIDR. General authenticated API limits use the account identity, and static assets are excluded from that budget.

For the SQLite adapter, run **one writer process per data directory**. The PostgreSQL/Blob/Queue composition uses database locks, durable receipts, and private workspace snapshots across instances; it does not share a SQLite file. Do not share that directory across replicas or perform overlapping rolling deployments. The image runs as the non-root `node` user. The compose service uses a read-only root filesystem, a temporary `/tmp`, a persistent `/data` volume, dropped capabilities, and a healthcheck. SQLite tables include uploaded asset bytes. Runner plans, recordings, and evidence live below `/data/workspaces`.

Chromium's runtime configuration/cache directories are explicitly set to `/tmp/studio-config` and `/tmp/studio-cache` through the standard XDG variables. This lets crashpad initialize under a read-only root filesystem without changing the user's home or granting additional capabilities. Keep `/tmp` writable when running the packaged acceptance driver; the smoke gate checks these settings and launches the actual browser under the same restrictions.

The operator owns HTTPS, DNS, key storage, disk monitoring, backup retention, and access to the trusted runner's target systems. A new deployment still requires its real credentials and a successful restore rehearsal.

## Accounts and roles

- Owners manage project membership and settings.
- Editors modify artifacts, comments, ADRs, links, and run requests.
- Viewers read the same project context without editing it.

Access is project-scoped. A linked GitHub URL does not grant repository access. Admit collaborators by their verified GitHub email through project membership, then ask them to continue with GitHub. Studio issues no temporary passwords and sends no invitation email. A stable GitHub account identifier binds each admitted identity; a username or pasted repository URL is never authentication. See the [architecture notes](../../docs/studio-architecture.md) for the trust model.

`STUDIO_ADMIN_PASSWORD` does not enable any authentication method. Password setup, login and changes are unavailable; historical password browser sessions are rejected. Treat API tokens as user credentials; they expire after 30 days and can be revoked from Share. Browser sessions expire after seven days.

## Test execution and live preview

Set `STUDIO_RUNNER_CONFIG` to an absolute, read-only, **operator-trusted** ai-bdd config path. The config supplies the model and driver packages, application base URL, secret names, and navigation policy. It is executable server code and must never come from an artifact upload or chat message. Studio exports each document to an isolated artifact workspace, compiles grounded plans, records explicit scenario review, and queues strict frozen runs. The existing engine supplies deterministic replay, first-run AI judging, traceability, and evidence hashing.

In the container, Chromium is installed and `AI_BDD_CHROMIUM_PATH=/usr/bin/chromium`. Mount the trusted config read-only and ensure any custom packages it imports are present. The testing target needs to be reachable under the deployment's network policy. Provider-specific model credentials belong in deployment secret storage.

The code editor's sandboxed preview does not require a live integration. It can replay declared HTTP boundaries from its contract fixture. Those responses are preview data, not proof that a live provider is healthy. Pact checks validate the tested consumer/provider boundary separately. Live runs show the document version they used, so later edits can mark their evidence out of date.

GitHub PR refresh can use the public API without a credential. A configured `STUDIO_GITHUB_TOKEN` is sent only for exact `owner/repo` entries in the comma-separated `STUDIO_GITHUB_REPOSITORIES` allowlist. Keep that token's scopes minimal and admit only repositories the deployment is allowed to expose. Do not infer private repository authorization from a pasted link.

Local multipart uploads are bounded to 10 MB. The managed direct-upload adapter permits audio/video up to 100 MB and other supported media up to 10 MB, with a 512 MB project quota that includes pending reservations. It also limits a project to 500 artifacts and an account to 100 projects. These are safety bounds rather than a capacity or performance guarantee. Generated content remains subject to its typed schema, document nesting, and payload limits.

Built browser assets carry third-party license notices at `/third-party-licenses.md`. Fonts and editor assets are served locally; `assetsInlineLimit:0` keeps module loading compatible with the application's content-security policy rather than depending on executable data URLs.

## MCP adapter

Create a personal API token from Share → Connect an agent, then put its value in your MCP client's secret environment configuration. Build Studio before using the adapter.

```json
{
  "mcpServers": {
    "ai-bdd-studio": {
      "command": "node",
      "args": ["/absolute/path/to/ai-bdd/packages/studio/dist/server/mcp.js"],
      "env": {
        "STUDIO_API_URL": "https://studio.example.com",
        "STUDIO_API_TOKEN": "<personal-api-token-from-secret-storage>"
      }
    }
  }
}
```

The stdio adapter exposes project/artifact reads, typed creation and version-checked updates, comments, paginated discussion history, ADR updates, plan compilation/review, test-run requests, cancellation, and history. `studio_get_messages` retrieves a bounded chronological page from one artifact/thread; pass its `nextCursor` as `before` to retrieve earlier context without mixing discussions. It calls the same authorized API used by the browser; it has no arbitrary shell, checkout, or credential-reading tool. Remote URLs require HTTPS and redirects are refused. Tool output and artifact content are untrusted source material for the calling agent. External-agent actions use the API owner's identity and permissions.

## Verification scope

The layout model is shared with the application shell and follows the step-function construction described by [The Calculus of Interfaces](https://calculus-of-interfaces.vercel.app/) and [handwired](https://github.com/chenglou/handwired). The checker uses exact rational arithmetic to prove non-overlapping column allocation and a minimum canvas width over every real viewport width from 320 through 4096 pixels. It also exhaustively evaluates the actual three-role/three-action permission predicate.

These checks do not prove text wrapping, browser rendering, all application state transitions, external-provider behavior, or the security of arbitrary generated code. Browser and API tests cover separate observations.

The optional Magnetar research pipeline and external proof-verifier boundary are documented in [verification/README.md](verification/README.md). Their specific proof artifacts and admitted assumptions are separate from application and production certification. A manifest digest is never presented as a cryptographic execution proof.

## Backup and restore

The [hosted runbook](../../docs/studio-vercel-deployment.md#backup-restore-rollback-and-replacement) covers PostgreSQL plus private object recovery. The following stopped-volume procedure applies to the SQLite/disk adapter.

Stop incoming work and stop the application before snapshotting the complete data volume, including runner artifacts. The exclusive SQLite writer lock intentionally excludes external online backup access; no in-process online-backup adapter is supplied. Never copy only an actively written SQLite main file while ignoring its WAL.

One stopped-volume backup procedure, using the already-built image's tools, is:

```sh
docker compose -f docker-compose.studio.yml stop studio
docker run --rm --user node --entrypoint sh -v ai-bdd_studio-data:/data:ro -v "$PWD/backups:/backup" ai-bdd-studio:local -c 'tar -C /data -czf /backup/studio-data.tgz .'
docker compose -f docker-compose.studio.yml start studio
```

Compose volume names depend on the compose project name; use `docker compose -f docker-compose.studio.yml config --volumes` and `docker volume ls` to identify the actual volume. Pre-create `backups` with permissions allowing UID 1000 to write. Encrypt backups outside the app and retain them according to the project policy.

Restore into a **new empty** volume with the application stopped, extract the archive as UID 1000, and run `sqlite3 /data/studio.sqlite 'PRAGMA integrity_check;'`. Start a single instance against the restored volume, sign in, inspect representative artifacts/chats/ADRs, and download evidence before replacing the active deployment. Keep the prior volume until that verification is complete. Inspect durable job state and recovery receipts after restarting; a failed or cancelled run is never evidence of success. Local external-agent side effects still require explicit reconciliation rather than automatic replay.
