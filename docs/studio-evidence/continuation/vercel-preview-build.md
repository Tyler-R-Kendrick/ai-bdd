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
