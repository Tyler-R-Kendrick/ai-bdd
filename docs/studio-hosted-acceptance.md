# Hosted platform acceptance

`packages/studio/verification/vercel-live.ts` checks one explicitly selected Studio deployment over HTTP. It uses no platform management APIs, changes no infrastructure and invokes no model, media renderer or queued job. It never discovers credentials from files or automatically takes a `VERCEL_*` token.

Run the default **read-only** check with an exact HTTPS origin, without a path, trailing slash, query or URL credentials:

```sh
export STUDIO_LIVE_ORIGIN=https://your-selected-deployment.example
pnpm --filter @ai-bdd/studio exec tsx verification/vercel-live.ts
```

The default makes only GET requests. It checks `/` itself for the built Studio SPA and same-origin JavaScript/CSS assets; `/index.html` succeeding does not excuse a failed root route. It verifies asset content types and security headers, `/api/health`, Vercel/PostgreSQL readiness, disabled setup/demo configuration and a 401 from an unauthenticated project read. It rejects every redirect rather than following it with credentials. Asset and API responses have byte limits and request deadlines; TLS validation uses the normal runtime trust store.

If access requires an explicitly authorized project identity, provide both `STUDIO_LIVE_OIDC_TOKEN` and `STUDIO_LIVE_OIDC_HOST` through the operator process's approved environment binding. The host must exactly equal the origin's host, including a non-default port. The token is sent only as `x-vercel-trusted-oidc-idp-token` to that exact origin. This script implements no deployment-protection bypass, does not refresh the token and does not treat it as a Studio user session.

To test authentication and private persistence, explicitly set `STUDIO_LIVE_ALLOW_WRITES=1` and provide the paired `STUDIO_LIVE_EMAIL` and `STUDIO_LIVE_PASSWORD` through environment bindings. These values are never command arguments or report fields. Login writes session records, so it is included in the write gate. Public checks must pass before any write workflow begins.

The gated workflow verifies the production setup/demo routes refuse writes, authenticates the selected account, validates the secure host-only HttpOnly/SameSite session cookie, and creates a private synthetic project plus regular document. It saves canonical document content, signs in again with a distinct session, reads the persisted owner membership and exact saved document/version, and checks the artifact's ADR and chat exist. It logs out the issued sessions and observes their subsequent rejection. The synthetic project/documents are retained for operator review; their IDs appear in the report, including a partially completed create. Repeated write runs consume the ordinary project quota.

The JSON report separates passed, failed and skipped checks and exits nonzero when any check fails. A successful `scope: "public-read-only"` report does **not** claim authenticated persistence. Readiness can report Blob, Queue or media as configured; this script always marks their actual operations/delivery/execution unverified. Existing `verification/media-live.ts` and the separately gated end-to-end media acceptance own those checks. A fresh user session proves persisted SQL reads through the running deployment; this script does not restart it or certify every production behavior.

Optional bounds are `STUDIO_LIVE_TIMEOUT_MS` (100–30,000; default 15,000) and `STUDIO_LIVE_RESPONSE_BYTES` (1 KiB–16 MiB; default 8 MiB). The entire run also has a two-minute request deadline. `STUDIO_LIVE_DEV_LOOPBACK=1` permits HTTP only for `127.0.0.1`, `[::1]` or `localhost`, and is rejected in a production process. Such reports are explicitly labeled `dev-loopback-protocol`.

Local validation is in `tests/vercel-live.test.ts`. Actual HTTP tests cover read-only gating, root404, redirect/foreign-asset rejection with no token forwarding, streamed body and timeout limits, malformed origin/credential bindings, secret-redacted failure reports, and rejection of local SQLite as Vercel readiness. The positive persistence test uses the real application/Auth/SQL/document routes; only platform diagnostics are a labeled protocol fixture. These local tests do not claim a live Vercel, paid provider or external service acceptance result.
