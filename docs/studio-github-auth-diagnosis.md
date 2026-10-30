# Production GitHub sign-in diagnosis

Status: unresolved provider identity contract. This is a diagnosis and proposed connection plan, not a successful-login receipt.

The deployed implementation is `f7ce9aea561c4ddc16ac38be0127c3b55214b5c2`. Its production callback logs establish the following sequence without recording credentials or identity values:

| Stage | Observed result |
| --- | --- |
| Browser-bound, one-use challenge | Passed |
| Owned GitHub connector metadata and discovery | Passed |
| OAuth authorization-code exchange with PKCE | HTTP 200; bearer access token returned |
| Connect userinfo | HTTP 200; subject present; email absent; verified-email claim not true |
| Studio identity validation | HTTP 403 |
| Workspace admission and session creation | Not reached |

The immediate failure is the mismatch between Connect's optional profile claims and Studio's required verified-email admission. It does not establish that the GitHub account has no verified email.

## Explanations assessed

| Explanation | Assessment |
| --- | --- |
| Missing email or verification claims in the managed identity profile | Confirmed immediate cause |
| Private GitHub profile email without a `/user/emails` fallback | Plausible upstream cause; not yet distinguished from permission or mapper limitations |
| Managed GitHub App lacks account Email addresses read permission | Plausible; not established by anonymous app visibility or scope strings |
| Existing GitHub authorization predates a permission change | Plausible if the permission was changed; no such change is assumed |
| Connect's GitHub mapper does not emit verified-email claims | Plausible; its public profile contract makes both email fields optional |
| Missing callback cookie, expired state, replay, or broken PKCE | Inconsistent with this attempt's successful challenge and code exchange |
| Wrong callback URL, rejected client authentication, or failed token transport | Inconsistent with this attempt's successful code exchange and userinfo request |
| Incorrect current production source | Deployed source contents were checked against the reviewed release; the callback emitted its new diagnostic stages |
| Stale static frontend | Cannot explain the observed server-side profile rejection; authentication APIs are not cached |
| Workspace owner email configuration or pre-existing identity conflict | Separate preflight found a valid matching owner configuration, one intended owner account, and no direct or managed identity binding for it; actual admission was not reached |
| Final session-cookie or redirect behavior | Not reached in this attempt; requires separate browser verification |
| Protected staging URL rejects a development credential | A separate Vercel deployment-access rule, not this public production callback failure |
| AI model, Gateway credits, or chat-provider configuration | Outside the sign-in execution path |

Anonymous health, status, authorization-start checks, screenshots, and green fixture tests do not establish a working real-account callback.

## Supported remedies

### Repair the existing managed connector

Vercel Connect manages a GitHub App. Inspect the actual App's account-level **Email addresses: Read-only** permission, independently of repository permissions. If a permission changes, GitHub may require renewed authorization. Confirm that Connect then fetches an authenticated verified email and emits both a usable `email` and `email_verified: true` from userinfo.

Permission and mapping are separate requirements. An `openid email user:email` scope string does not grant GitHub App account permissions. A permission toggle is not a verified fix if the mapper still omits the claims. The public connector update tool does not expose a supported profile-mapping field; do not invent one.

### Use standard GitHub OAuth hosted on Vercel

This is the most direct fallback if the managed profile cannot meet the identity contract. Studio already has a direct GitHub OAuth adapter that exchanges the authorization code, calls authenticated `/user` and `/user/emails`, and admits only verified GitHub emails. It supports private and non-primary verified aliases without relying on a public profile email.

Register an owned GitHub OAuth application with:

- Homepage: `https://ai-bdd-studio.vercel.app`
- Callback: `https://ai-bdd-studio.vercel.app/api/auth/github/callback`
- Sign-in access: the verified-email access used by the adapter; no repository permission is needed for login.

Bind its credentials in Vercel production as `STUDIO_GITHUB_SIGNIN_CLIENT_ID` and `STUDIO_GITHUB_SIGNIN_CLIENT_SECRET`. Those bindings are currently absent. Keep values out of source, PRs, and chat.

Switch the production provider deliberately: the current `STUDIO_GITHUB_SIGNIN_CONNECTOR` selector takes precedence over direct credentials. Binding credentials alone will not switch providers. Remove that production selector, or introduce an explicit provider mode with unambiguous validation, only when the replacement credentials are present. Redeploy after changing bindings.

Use separate registered clients or a deliberately designed, authenticated redirect proxy for distinct preview callback hosts. Do not assume a production OAuth client accepts arbitrary generated preview domains.

Replacing the implementation with Auth.js can reduce custom protocol code, but does not create a GitHub OAuth client or supply missing GitHub App permissions. The existing direct adapter already performs the essential verified-email lookup.

### Other managed authentication services

A separate managed identity service is possible, but adds another service and migration. Checked production GitHub configurations require an owned client or appropriate account permissions; development shared keys are not a production remedy. No migration is justified merely to move the same missing-credential requirement elsewhere.

### Explicit invitation enrollment with the existing connector

An authenticated stable issuer/connector/subject can also identify a GitHub account without an email claim. Workspace authorization must then be established separately: an existing owner or deployment operator can issue a short-lived, account-specific enrollment invitation. The invitation must be bound to the browser's OAuth challenge and redeemed atomically only after a successful GitHub authorization-code flow and valid userinfo subject. It cannot authenticate someone by itself.

This would preserve the existing managed connector and avoid depending on optional email claims. Future logins resolve the stored qualified principal. An unbound principal without either verified-email admission or an explicit valid invitation remains unauthorized; no first-caller ownership or public signup is introduced. Cross-provider and cross-principal account conflicts must still be refused.

This is a proposed alternative requiring security review, implementation, replay/race tests, and a real enrollment check. It is not currently deployed or claimed to work. It must never be described as proof that Connect supplied a verified email.

## Approaches excluded

- Do not admit an unbound principal without verified-email matching or explicit owner-authorized enrollment, claim an opaque Connect subject is a numeric GitHub ID, or automatically grant ownership to the first subject.
- Do not treat a Connect login bearer as a provider API token or a Passport subject-token credential. The earlier unsupported exchange failed before userinfo-based login was implemented.
- Do not replace authorization-code proof with polling an anonymous integration grant; cross-browser consent can then be misattributed.
- Do not ask someone to publish their private GitHub email as a workaround.
- Do not enable password, setup, or demo login, or broaden Vercel deployment protection to conceal the application failure.

## Acceptance required before closing this issue

Verify the selected provider's complete flow: authorization, callback challenge, code exchange, authenticated verified-email lookup, intended account admission, session creation, same-origin `/api/me`, and workspace access. Exercise private email, non-primary verified aliases where supported, rejected unverified identity, invitation failure, callback replay, restart, and genuinely cross-site browser navigation. Confirm password endpoints remain disabled.

Update the PR's screenshots and claims to match the exact successful flow. Until that receipt exists, keep real production login marked failing or unverified as appropriate.

## Primary references

- [Vercel Connect with Auth.js](https://vercel.com/docs/connect/frameworks/authjs)
- [Vercel managed GitHub App setup](https://vercel.com/kb/guide/github-agent-vercel-connect)
- [GitHub authenticated email API and permissions](https://docs.github.com/en/rest/users/emails)
- [GitHub OAuth application registration](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)

No provider credential, identity value, deployment identifier, database identifier, or session is included in this document.
