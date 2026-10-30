# Hosted platform acceptance

`packages/studio/verification/vercel-live.ts` checks one explicitly selected Studio deployment over HTTP. It uses no platform management APIs, changes no infrastructure and invokes no model, media renderer or queued job. It never discovers credentials or automatically takes a `VERCEL_*` token; authenticated checks read only an explicitly selected private GitHub browser-session export.

Run the default **read-only** check with an exact HTTPS origin, without a path, trailing slash, query or URL credentials:

```sh
export STUDIO_LIVE_ORIGIN=https://your-selected-deployment.example
pnpm --filter @ai-bdd/studio exec tsx verification/vercel-live.ts
```

The default makes only GET requests. It checks `/` itself for the built Studio SPA and same-origin JavaScript/CSS assets; `/index.html` succeeding does not excuse a failed root route. It verifies asset content types and security headers, `/api/health`, Vercel/PostgreSQL readiness, GitHub-only sign-in with disabled password/setup/demo configuration and a 401 from an unauthenticated project read. It rejects every redirect rather than following it with credentials. Asset and API responses have byte limits and request deadlines; TLS validation uses the normal runtime trust store.

If access requires an explicitly authorized project identity, provide both `STUDIO_LIVE_OIDC_TOKEN` and `STUDIO_LIVE_OIDC_HOST` through the operator process's approved environment binding. The host must exactly equal the origin's host, including a non-default port. The token is sent only as `x-vercel-trusted-oidc-idp-token` to that exact origin. This script implements no deployment-protection bypass, does not refresh the token and does not treat it as a Studio user session.

To test authenticated private persistence, set `STUDIO_LIVE_ALLOW_WRITES=1` and supply the expected `STUDIO_LIVE_EMAIL` plus an absolute `STUDIO_LIVE_GITHUB_SESSIONS_FILE` reference. Obtain two distinct Studio sessions through the configured GitHub sign-in adapter in separate browser contexts. Export only their `studio_session` cookies to a regular, nonsymlink, owner-private file (0600, at most 32 KiB):

```json
{
  "schemaVersion": 1,
  "origin": "https://your-selected-deployment.example",
  "provider": "github",
  "sessions": [
    { "name": "studio_session", "value": "<first-browser-cookie>", "domain": "your-selected-deployment.example", "path": "/", "secure": true, "httpOnly": true, "sameSite": "Strict", "expires": 0 },
    { "name": "studio_session", "value": "<second-browser-cookie>", "domain": "your-selected-deployment.example", "path": "/", "secure": true, "httpOnly": true, "sameSite": "Strict", "expires": 0 }
  ]
}
```

Use each browser's actual future Unix expiry; the illustrative zero values are deliberately rejected. Cookies and file contents never belong in command arguments, reports, commits or comments. `STUDIO_LIVE_PASSWORD` is refused. Public checks must pass before the file is opened or the authenticated workflow starts.

The gated workflow verifies password/setup/demo routes refuse sign-in, validates the two exact-origin cookie exports, and requires `/api/me` to authenticate the selected GitHub account. The application independently rejects browser sessions without GitHub callback provenance. The workflow creates a private synthetic project and regular document, saves canonical content, reads the exact persisted owner membership/document/version through the second distinct session, and checks the dedicated ADR and chat exist. It logs out both supplied sessions and observes their subsequent rejection. Cookie attributes are validated browser-export metadata; this script does not perform the external GitHub OAuth exchange itself. The synthetic project/documents remain for operator review, so their receipt must stay private or be redacted before publication. Repeated write runs consume the ordinary project quota.

The JSON report separates passed, failed and skipped checks and exits nonzero when any check fails. A successful `scope: "public-read-only"` report does **not** claim authenticated persistence. Readiness can report Blob, Queue or media as configured; this script always marks their actual operations/delivery/execution unverified. Existing `verification/media-live.ts` and the separately gated end-to-end media acceptance own those checks. A fresh user session proves persisted SQL reads through the running deployment; this script does not restart it or certify every production behavior.

Optional bounds are `STUDIO_LIVE_TIMEOUT_MS` (100–30,000; default 15,000) and `STUDIO_LIVE_RESPONSE_BYTES` (1 KiB–16 MiB; default 8 MiB). The entire run also has a two-minute request deadline. `STUDIO_LIVE_DEV_LOOPBACK=1` permits HTTP only for `127.0.0.1`, `[::1]` or `localhost`, and is rejected in a production process. Such reports are explicitly labeled `dev-loopback-protocol`.

Local validation is in `tests/vercel-live.test.ts`. Actual HTTP tests cover read-only gating, root404, redirect/foreign-asset rejection with no token forwarding, streamed body and timeout limits, malformed origin/credential bindings, secret-redacted failure reports, and rejection of local SQLite as Vercel readiness. The positive persistence test uses the real application/Auth/SQL/document routes and two sessions issued by a controlled GitHub OAuth provider fixture; platform diagnostics are also a labeled protocol fixture. Tests additionally reject password inputs, foreign/expired/duplicate/unsafe cookie exports, public-readable files and symlinks. These local tests do not claim a live Vercel, paid provider or external service acceptance result.
