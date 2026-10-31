# Production GitHub sign-in diagnosis

Status: the unwanted email-based admission requirement was removed and the automatic GitHub-account implementation was deployed as `869c18bfdce4cb63074deaddafa23e5196f8f870`. A real production GitHub callback/account session is still unobserved. Deployment and controlled-provider checks do not constitute a successful real-login receipt.

The affected release was `f7ce9aea561c4ddc16ac38be0127c3b55214b5c2`, before the email requirement was removed. Its historical production callback logs establish the following sequence without recording credentials or identity values:

| Stage | Observed result |
| --- | --- |
| Browser-bound, one-use challenge | Passed |
| Owned GitHub connector metadata and discovery | Passed |
| OAuth authorization-code exchange with PKCE | HTTP 200; bearer access token returned |
| Connect userinfo | HTTP 200; subject present; email absent; verified-email claim not true |
| Studio identity validation | HTTP 403 |
| Workspace admission and session creation | Not reached |

The immediate failure was the mismatch between Connect's optional profile claims and Studio's then-required verified-email admission. It does not establish that the GitHub account has no verified email.

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
| Incorrect source on that affected release | Deployed source contents were checked against the reviewed release; the callback emitted its new diagnostic stages |
| Stale static frontend | Cannot explain the observed server-side profile rejection; authentication APIs are not cached |
| Workspace owner email configuration or pre-existing identity conflict | Separate preflight found a valid matching owner configuration, one intended owner account, and no direct or managed identity binding for it; actual admission was not reached |
| Final session-cookie or redirect behavior | Not reached in this attempt; requires separate browser verification |
| Protected staging URL rejects a development credential | A separate Vercel deployment-access rule, not this public production callback failure |
| AI model, Gateway credits, or chat-provider configuration | Outside the sign-in execution path |

Anonymous health, status, authorization-start checks, screenshots, and green fixture tests do not establish a working real-account callback.

## Selected remedy: trust the authenticated GitHub identity

GitHub does not require Studio to compare an owner email or pre-create local accounts. Those were application rules, not provider requirements. The user explicitly requested their removal. A successful code/PKCE exchange and authenticated qualified subject now suffice to create a passwordless internal user automatically, with no email claim or invitation prerequisite.

Keep the already-owned Vercel Connect GitHub connector. Use its fixed issuer, canonical connector and opaque subject as the exact identity key. Preserve existing bindings. For an unknown identity, create a fresh internal user and binding atomically; serialize concurrent first sign-ins. The historical email column receives a random internal `identity.invalid` identifier, not an invented verified/contact email. Neither a public email nor a matching private email can claim another existing account.

GitHub owns credentials and authentication. Studio retains the minimal user/project records needed for authorization and artifact ownership. New users can create projects, and existing project owners can add a signed-in teammate by Member ID. Automatic sign-in does not transfer anyone else's projects or grants.

The real provider's missing email is therefore acceptable. No new OAuth app registration, email permission, mapper repair, local signup, or one-time enrollment flow is needed for this policy. The earlier proposed invitation remedy remains unshipped and is not part of this release.

## Other solutions assessed

| Option | What it would solve | Decision |
| --- | --- | --- |
| Add GitHub App account Email addresses read permission and repair Connect's mapper | Could supply verified email if the app required it; permission and mapping are distinct | Unnecessary after removing the application email requirement |
| Register a direct GitHub OAuth app on Vercel | Studio's direct adapter can authenticate a numeric GitHub ID using `/user` | Supported alternative, but requires an owned registered client and deployment bindings; the existing Connect connector already authenticates |
| Replace the protocol adapter with Auth.js or another auth framework | Can simplify framework integration | Does not create OAuth credentials or make optional email claims mandatory; not needed for this failure |
| Migrate to a different managed identity service | Moves identity hosting and introduces migration work | No benefit needed for the selected simple GitHub policy |
| Require an explicit account-specific enrollment invitation | Separates local account authorization from email claims | Rejected as a login prerequisite by the user's clarified policy; not shipped |
| Enable passwords, demo login, or a public first-caller claim on an existing account | Could conceal the GitHub failure or transfer privileges | Not used; GitHub authentication and existing project permissions remain enforced |

The direct OAuth adapter remains available with `STUDIO_GITHUB_SIGNIN_CLIENT_ID` and `STUDIO_GITHUB_SIGNIN_CLIENT_SECRET` and the exact callback `https://ai-bdd-studio.vercel.app/api/auth/github/callback`. A configured `STUDIO_GITHUB_SIGNIN_CONNECTOR` takes precedence. No direct OAuth credentials are needed for the selected managed connector. Login credentials and repository authorization remain separate.

## Acceptance required before closing this issue

Verify authorization, browser-bound challenge, code/PKCE exchange, authenticated subject, first-use provisioning, session creation, same-origin `/api/me`, and workspace access. Verify normal re-login resolves the same user without an email claim. Exercise distinct identities sharing an email, concurrent first logins, existing binding continuity, callback replay, restart and cross-site navigation. Confirm password endpoints remain disabled and a new user cannot access another user's projects.

Update the PR's screenshots and claims to match the exact flow. Controlled providers and public route checks do not establish a successful real GitHub callback. Until that receipt exists, keep real production login marked failing or unverified as appropriate.

## Primary references

- [Vercel Connect with Auth.js](https://vercel.com/docs/connect/frameworks/authjs)
- [Vercel managed GitHub App setup](https://vercel.com/kb/guide/github-agent-vercel-connect)
- [GitHub authenticated email API and permissions](https://docs.github.com/en/rest/users/emails)
- [GitHub OAuth application registration](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)

No provider credential, identity value, deployment identifier, database identifier, or session is included in this document.
