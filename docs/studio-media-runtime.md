# Hosted media execution

Vercel composition uses `VercelSandboxMediaRuntime` for complete audio rendering, complete video rendering, and audio source inspection. It never assumes FFmpeg, FFprobe or Chromium exists in a Vercel Function. Node deployments retain the existing CPU driver; they may explicitly select `STUDIO_MEDIA_RUNTIME=vercel-sandbox`. Vercel rejects `local-cpu` and missing/unpinned image configuration during composition.

The adapter uses the pinned official `@vercel/sandbox` 3.9.1 SDK. Each operation creates a nonpersistent microVM from a digest-pinned, project-scoped **private** VCR image with `networkPolicy: 'deny-all'`, no exposed ports, two vCPUs and a bounded timeout. Complete owned source bytes are transferred through SDK file operations; the VM receives no external download URLs, SQL credentials, Blob tokens, agent credentials or API keys. FFmpeg probing/decoding and Chromium/FFmpeg rendering both happen inside that VM. No dependency installation happens in a session. Source files and output manifests carry SHA-256; the worker verifies the packaged executable, FFmpeg, FFprobe, Chromium and Inter hashes before executing. The parent verifies request identity and bounded output size/hash before returning bytes to the existing fenced publication transaction.

Cancellation, lost job fences and failed progress checks abort SDK execution and request VM stop. Every acquired VM is stopped in `finally`. A failed stop emits only a static operational diagnostic; the provider timeout still bounds the nonpersistent session. This is a cancellation request, not a claim that an unreachable provider confirmed termination. The worker has no publication privileges. Existing SQL leases, current access/source checks, output staging and atomic final receipts remain authoritative. New audio/video jobs freeze the runtime fingerprint (including image digest); a changed runtime requires explicit resubmission instead of silently rerouting queued work.

## Build the worker image

Install this repository's pinned dependencies first with `pnpm install --frozen-lockfile`. Prepare the image from the Studio directory:

```sh
STUDIO_MEDIA_BUILD_CONTEXT=/tmp/studio-media-worker-unique \
STUDIO_SOURCE_REVISION=<reviewed-commit-sha> \
node verification/prepare-media-image.mjs

docker build --tag studio-media:review /tmp/studio-media-worker-unique
```

The preparer creates a new directory and refuses to reuse an existing path. It copies only a bundled worker, lockfile, Inter font/license, pinned Playwright Core 1.64.0/license, build metadata and dependency notices. It rejects symlinks, unexpected non-Node external imports, and contexts over 32 MiB. It does not copy repository worktrees, credentials, package manager stores, or a full Studio deployment. The image uses an actual digest-pinned Node 24 Bookworm base, installs Debian packages at build time, records their versions/hashes and retains their distribution notices. Two filesystem layers also keep VFS builders bounded. `ENTRYPOINT`/`CMD` is not assumed to execute in Sandbox: the adapter calls the absolute worker command itself.

Publish the reviewed output to the approved team's **private**, project-scoped VCR repository using the documented CLI:

```sh
vercel vcr build docker /tmp/studio-media-worker-unique studio-media:<reviewed-revision> --push
```

Keep that repository private; do not make the image public or use a public artifact namespace. Wait for VCR's actual `Ready` state for its optimized `linux/amd64` image, then bind the returned **registry image digest**. A local Docker image/config ID is not a registry manifest digest and cannot substitute for this registration. The application does not publish or change repository visibility itself.

## Runtime binding

`STUDIO_MEDIA_SANDBOX_IMAGE=studio-media@sha256:<actual-private-VCR-manifest-digest>` is required on Vercel. `STUDIO_MEDIA_SANDBOX_TIMEOUT_MS` is bounded between 30,000 and 240,000 milliseconds (default 240,000). The SDK uses the deployment's approved Vercel OIDC context automatically. External/CI execution without OIDC requires the already approved `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` binding together; credentials never enter the VM. No adapter supplies a local CPU or public-image fallback after a Sandbox error.

Audio source metadata is cached in SQL by source SHA-256 and runtime image fingerprint. The domain verifies owned bytes and current access on every request, including cache hits. Independent server instances share a renewable fenced probe claim; a late result cannot replace its successor. Receipt integrity is checked, permanent decoder rejection is bounded to five minutes, and valid metadata expires after one day. Cache hits consume no inspection admission. Actual probes share a SQL hourly budget of 300 and concurrency budget of two, leaving room for the existing bounded audio/video render queues. The maintenance callback removes expired operational metadata; the cache contains no source bytes or artifact authority.

`/api/hosting/readiness` reports the media adapter as **configured**, with `verified: false`; configuration is not live-provider acceptance. Run the executable paid-provider gate only with its explicit usage opt-in and an approved bound account:

```sh
STUDIO_MEDIA_LIVE_ALLOW_USAGE=1 \
STUDIO_MEDIA_LIVE_REPORT=/private/operator-selected/media-live.json \
pnpm exec tsx verification/media-live.ts
```

That command calls the actual Sandbox SDK, verifies the runtime and completes synthetic audio probing/rendering and a one-second MP4. It fails closed without the image/account binding. Reports contain hashes, binary versions and results, never credentials. An account/RBAC rejection must be resolved by the account owner; it cannot be bypassed or relabeled successful.

## Executable evidence

- `tests/media-sandbox.test.ts`: typed SDK-boundary protocol fixture for immutable byte transfer, no secret-bearing VM environment, deny-all/nonpersistent configuration, cancellation, progress guard failure and result tampering. It does not claim a real Vercel VM was created.
- `tests/media-probe-cache.test.ts`: real HTTP transport and real SQLite/PostgreSQL stores exercise shared claims, cache integrity, runtime/source invalidation, budgets and stale fences.
- `verification/media-container.mjs`: runs the **actual packaged worker** in network-denied, read-only, capability-dropped local containers. It checks binary integrity, complete decode/probe, all five audio encoders/decoders, Chromium Inter frames and MP4/WebM duration validation, malformed input, altered packaged files and process cancellation. Its report explicitly identifies local OCI acceptance and cannot stand in for Vercel account acceptance.
- `.github/workflows/studio-media.yml`: builds the bounded private-source worker locally without registry publication, requires the container checks, and retains actual worker/binary evidence.

The verified protocol is based on official Sandbox 3.9.1 declarations (`Sandbox.create`, `writeFiles`, `runCommand`, `readFile`, `stop`) and current custom-image documentation: <https://vercel.com/docs/sandbox/concepts/images>. Live deployment and private image registration require the actual team's permissions; deterministic fixtures do not establish those permissions.
