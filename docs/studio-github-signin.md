# GitHub sign-in

Studio accepts GitHub browser sign-in. Email/password setup, login, demo login and password changes return HTTP 403 even when a valid historical password exists. Organization OIDC login routes are unavailable. An unconfigured GitHub provider fails closed; it does not reveal a fallback form.

Bind `STUDIO_GITHUB_SIGNIN_CLIENT_ID` and `STUDIO_GITHUB_SIGNIN_CLIENT_SECRET` on the server. Register the exact callback `${STUDIO_ORIGIN}/api/auth/github/callback` with the owned GitHub application for each environment. `STUDIO_ORIGIN` must be the canonical HTTPS origin in production. Keep client secrets in the deployment's secret bindings. A different deployment origin requires a registered callback; it must not be accepted through a wildcard or caller-supplied return URL.

`GET /api/auth/github` starts the authorization code flow. Studio requests only `user:email`, uses S256 PKCE and stores a five-minute, one-use SQL challenge bound to a separate HttpOnly browser cookie. The callback checks the challenge before exchanging a code. GitHub access tokens are used only for the fixed profile and verified-email API requests; sign-in does not persist them. Transport follows no redirects, applies time and response-size bounds, and returns no provider messages or credential data. Failed callbacks return to the fixed `/?signin=failed` page.

Set `STUDIO_ADMIN_EMAIL` to the first owner's verified GitHub email before starting a new workspace. The first successful GitHub sign-in can create that owner only while no users exist. Other people must already have an invited workspace account with a matching verified GitHub email. A matching email may be non-primary or private on GitHub. Public signup and ambiguous matches to multiple workspace accounts are refused.

The first admitted sign-in binds GitHub's stable numeric account ID to the existing Studio user ID. Project roles, artifacts and native checkpoint ownership stay attached to that Studio ID. Later GitHub email changes do not move the account, and another GitHub ID cannot claim an already-bound account through a matching email.

New browser sessions receive durable GitHub provenance. Historical password-created browser cookies remain unauthorized after the cutover, including pending repository-connection callbacks. Session tokens are stored as hashes, and logout/revocation removes their provenance through the session foreign key. Existing explicitly scoped API bearer credentials retain their separate `kind='api'` authorization policy; they cannot be presented as browser cookies.

Repository authorization remains a separate consent and permission boundary. GitHub sign-in neither grants repository access nor supplies an operator token to repository tools. `STUDIO_GITHUB_CLIENT_ID`, `STUDIO_GITHUB_CLIENT_SECRET` and the repository credential vault configure that separate adapter.

The focused tests use an owned injected provider or loopback HTTP issuer to exercise real SQL challenges, PKCE, callback admission and session publication. The PostgreSQL cases exercise competing owner bindings and callback replay across application instances. These checks do not establish a live GitHub application's callback configuration or replace deployment acceptance with that application.
