# Vercel CLI source-input verification

Verified on 2026-10-30 with the installed Vercel CLI **65.8.0**, from release
source `ebd62f37f235b5c00d6008052843c77c7c5385f8` plus the root
[.vercelignore](../../../.vercelignore). This receipt records source selection,
not a deployment or an upload.

The read-only `project inspect --non-interactive` command resolved the existing
`tyler-r-kendricks-projects/ai-bdd-studio` project, repository root `.`, and Node.js
24.x. The existing private CLI configuration was supplied through
`--global-config`; its credentials and local environment-file values were not
read or copied into this receipt.

## Actual CLI results

| Check | Observed result |
| --- | --- |
| Initial source selection without `.vercelignore` | 85,313 files; 2,001,150,159 bytes. Of these, 83,145 files were under `work/`. This was a dry-run manifest, not uploaded data. |
| Clean source selection with `.vercelignore` and this receipt | 1,504 files; approximately 22.9 MB. No canary files remain. |
| Explicit exclusion canaries | All 35 absent from the actual CLI manifest, including root and nested environment files, Vercel/Git metadata, worktree files, nested dependencies/build output, caches, reports, logs, local state, keys and databases. |
| Positive controls | Both a source-file control and a WASM-extension control remained in the canary manifest. Controls were removed before the clean verification. |
| Tracked code and configuration | All 1,162 tracked TypeScript, JavaScript, JSON, YAML, CSS and HTML files remained selected. |
| Workspace build inputs | All nine workspace `package.json` files, root `package.json`, `pnpm-workspace.yaml`, pinned `pnpm-lock.yaml`, `vercel.json` and build scripts remained selected. |
| Container context | Actual manifest includes `Dockerfile.studio`, `.dockerignore`, `packages/studio/.dockerignore`, `packages/studio/media.Dockerfile` and `packages/studio/media.Dockerfile.dockerignore`. Narrow negations retain Docker ignore policies otherwise omitted by CLI defaults. |
| CAD/WASM build inputs | The actual CAD kernel worker/import source, public redistribution notices and pinned OpenCascade dependency remain. Cached `dist` WASM is excluded; the remote frozen-lockfile install and Vite build recreate it. No blanket WASM exclusion is used. |

The checked `.vercelignore` SHA-256 is
`e32256afe0d58098a6d91684833cf05e90463367ae31d247298bbae0119b2484`.
The only tracked files omitted by the final selection are two CLI-default
`.gitignore` files, the excluded `.env.example`, and four generated browser
evidence `.log` files. Application, SDK, test and workspace build source remain.

The verification used the real CLI file walker, with temporary non-secret files
created at the listed categories and independent positive controls. It did not
substitute a test implementation of the ignore matcher. The command was:

```sh
vercel --global-config <private-config-directory> deploy --dry --json --non-interactive
```

Full dry-run JSON and stderr were redirected to private local files outside the
repository. Only path/count/size/hash metadata was inspected. All 37 temporary
canaries were removed. The CLI and its dependencies were not added to the
repository. No deployment, resource creation, environment mutation or source
upload was performed by this verification; runtime, build and deployment
acceptance are separate checks.
