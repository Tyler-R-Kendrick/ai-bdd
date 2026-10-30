# Vercel preview build context correction

The exact preview [G61jtxijmkDEjkxsrhjVtuChQbMn](https://vercel.com/tyler-r-kendricks-projects/ai-bdd-studio/G61jtxijmkDEjkxsrhjVtuChQbMn) built Git source `fe21dd4c6f59d6bb66c95e906fdaad07f60789b1` and ended in `ERROR` with code `enoent`.

Read-only Vercel deployment details and build events showed:

```text
buildah ... -f /vercel/path0/packages/studio/Dockerfile /vercel/path0/packages/studio
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
copier: stat: "/pnpm-lock.yaml": no such file or directory
```

The static frontend had built successfully. Backend registry authentication and repository lookup also succeeded before the failing source-copy step. Runtime environment validation had not run; these events do not establish live database, private media image or provider readiness.

The canonical backend Dockerfile now resides at repository-root `Dockerfile.studio`, and `vercel.json` selects that entrypoint. Its directory contains the root lockfile/workspace definition and every package manifest used by `COPY`. Compose, the image CI job and documented local commands select the same file. Standard root `.dockerignore` applies to both Docker and Buildah and excludes dependencies, Git metadata, environment files, Vercel build metadata and worktrees.

Validation used a real lightweight Docker context build containing the canonical Dockerfile's local `COPY` instructions. Exporting its actual filesystem confirmed the root workspace inputs were present and synthetic `.env`, `.vercel` and `work` canaries, `.git`, and `node_modules` were absent. The preflight image/container was removed afterward. No full VFS release build, registry publication, environment write or paid provider execution was performed for this check.

`tests/container-context.test.ts` protects the real Dockerfile-directory context and local/CI configuration agreement. The actual hosted deployment must rebuild the changed source before its build or runtime status can be reported as successful.

A separate media CI issue involved resolving the workspace driver's unbuilt `dist/index.js`. Media preparation now resolves the installed dependency's package metadata instead. Its clean fixture executes the complete preparer while that driver export is absent, packages actual pinned Playwright Core, and keeps the export absent. Before/after preparation under the same build directory produced identical worker bytes; this resolution change does not change the media worker implementation.

## Changed-source remote verification

The subsequent preview built exact source `98ffeb2c70a620c8c7e6febc20913da681b54ea5` and reached platform state **READY**:

- Deployment: `dpl_2cvrMzsWgYbkBWeSvoDBhF1Nc3SX`
- Preview: <https://ai-bdd-studio-hk5aokuy0-tyler-r-kendricks-projects.vercel.app/>
- Dashboard: <https://vercel.com/tyler-r-kendricks-projects/ai-bdd-studio/2cvrMzsWgYbkBWeSvoDBhF1Nc3SX>
- Platform ready timestamp: `2026-10-30T03:02:49.803Z`
- Build events: `Build Completed in /vercel/output [4m]`, followed by `Deployment completed`.
- Actual backend registry reference: `vcr.vercel.com/tyler-r-kendricks-projects/ai-bdd-studio/backend@sha256:caa5bbc57c7b5e944683cd296fe30b087d5eaa4f8e4da0f74ee2f4bd7d39c091`.

Read-only build events confirmed frozen dependency installation completed and the builder passed the previously failing source-copy step, assembled the runtime image and pushed that actual backend manifest. This verifies the monorepo container-context correction against Vercel's own builder. The backend image is distinct from the separately packaged Sandbox media worker and its digest cannot substitute for a media-worker registration.

A deployment-scoped error/fatal log query returned no records in its requested window. That result alone does not verify application health.

Protected account probes were attempted for `/api/health`, `/api/hosting/readiness` and `/`. The connected protected-fetch helper returned tool-level `INVALID_ARGUMENT` with a deployment-not-found-or-access-unavailable classification before supplying any application HTTP status or body. Scoped deployment metadata and build-log reads succeeded for the same deployment. No authenticated local `vercel`/`vc` CLI was available for the alternate existing-authentication path. Access settings were not changed, and no secret share URL or cookie is included in this evidence.

A follow-up access-link request supplied the exact owning team, `team_BRBUnG6uGhSsVV3EG5GFV3FM`. Automatic approval review rejected that operation before a provider call because the tool creates or reuses a public share link allowing anyone access for up to 23 hours. This was an approval-review rejection, not an application or Vercel API 403. No share link was created and no workaround was attempted.

The permitted public read-only probe used no Vercel credentials/cookies, followed no redirects and read at most 2 KiB per response. Actual responses were:

| Path | HTTP status | Redirect target, query removed | Classification |
| --- | --- | --- | --- |
| `/api/health` | 302 | `https://vercel.com/sso-api` | Vercel Authentication |
| `/api/hosting/readiness` | 302 | `https://vercel.com/sso-api` | Vercel Authentication |
| `/` | 302 | `https://vercel.com/sso-api` | Vercel Authentication |

All three responses had `Cache-Control: no-store, max-age=0` and a 263-byte body. Deployment protection remained active; those redirects did not reach application health handlers or verify the root UI. Secret query parameters, cookies and share URLs were not printed or included here.

Consequently, application health, runtime environment bindings, root-page rendering and production readiness remain **unverified** by these protected probes. No application-generated 401/403/500/503 is inferred from the helper failure. Live model/Sandbox execution and private media image registration were not attempted as part of this verification.

## Refreshed PR #24 preview observation

The connected GitHub integration subsequently built source `fd915f387609acb39fd0b00b28764d7391487c98` from `codex/studio-11-chopin-parity`. A fresh exact-team deployment read reported **READY**, platform ready timestamp `2026-10-30T04:45:14.247Z`:

- Deployment: `dpl_CQ3LR6jfZYLCgn2uTgQtHU1BqwxS`
- Preview: <https://ai-bdd-studio-fsz9d8xac-tyler-r-kendricks-projects.vercel.app/>
- Dashboard: <https://vercel.com/tyler-r-kendricks-projects/ai-bdd-studio/CQ3LR6jfZYLCgn2uTgQtHU1BqwxS>

This source includes the later remote write-authority display correction and passage-dialog layout. The read establishes a newer successful preview build; it does not supply a new backend registry digest or certify the application runtime. Fresh ordinary GETs to `/`, `/api/health` and `/api/hosting/readiness` all returned **302 to vercel.com** without following the redirect.

A separate read-only project-environment listing with decryption explicitly disabled returned provider **403**, “You don't have permission to list the project environment variable.” No variable values were requested or printed. This is a fresh account-access observation, in addition to the earlier denied production writes/private Blob creation. No public share link was requested in this refresh, no access settings were changed, and live production acceptance remains unverified.
