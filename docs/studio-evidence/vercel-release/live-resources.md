# Live Vercel release resources

This receipt records actual provisioned resources and direct live SDK acceptance observed on 2026-10-30. It does **not** certify a hosted application, queue recovery, or successful model inference. The reviewed application source is `52a6c61`; [live-resources.json](live-resources.json) retains safe resource IDs, timestamps, hashes, probe measurements, and precise readiness states. Credentials, populated environment files, proxy endpoints, and private operator filesystem paths are excluded.

The operator authenticated Vercel CLI **65.8.0** through its official device flow. Actual CLI resource and environment writes succeeded. No ACL or deployment-protection change was used to work around the earlier MCP permission rejection. The approved GitHub repository was observed as public at release time; no visibility change was performed. The approved Vercel project is `prj_zpOn0fQVrwbRp8ZWozPiL2ER4jLa` under team `team_BRBUnG6uGhSsVV3EG5GFV3FM`.

## Resource inventory

| Resource | Observed configuration |
| --- | --- |
| Canonical production origin | `https://ai-bdd-studio.vercel.app`; this is the actual project domain, not proof that production application health passed |
| Neon production | Task project `crimson-frog-10403185`, default branch `br-shiny-fire-b8tn4wiv`, endpoint `ep-royal-glade-b825vgbx`, database `studio`, region `aws-us-east-1` |
| Neon preview | Separate durable `studio-preview` branch `br-little-shape-b8j8ovk8`, endpoint `ep-lingering-dust-b8fs3znp`, parent production branch, database `studio`, bounded to 0.25 CU minimum/maximum |
| Production private Blob | `store_p68eAra1wwS7aMaW`, `ai-bdd-studio-production`, `iad1` |
| Preview private Blob | `store_PlAS4ZL1gsyZfvsg`, `ai-bdd-studio-preview`, `iad1`; separate environment binding |
| Private VCR repository | `studio-media`, `repo_Yb5KxKnznVu0wlJX6V5XPD01b2tu`; `public: false` |
| Registered media image | `image_NsxoL0IdRfnJ1qqNODVMNQhKFfHA`, tag `release-92022bb`, `linux/amd64`, 441,397,085 bytes, registry state **Ready** |
| Immutable media manifest | `sha256:d7d38332686b625e0d8f04b74f16a483d75676023fadac148333d39a9c15c689` |

The runtime image is `studio-media@sha256:d7d38332686b625e0d8f04b74f16a483d75676023fadac148333d39a9c15c689`. This is an actual private registry manifest digest, unlike the local image/config IDs in the earlier OCI-only reports. The two database bindings use pooled hosts and `verify-full` TLS configuration. The application's PostgreSQL adapter also enforces certificate verification. This receipt does not claim a successful native PostgreSQL connection from the deployed application. The Neon provisioning task changed no production data or schema and created no replacement production branch.

## Actual Blob SDK probes

The actual **`@vercel/blob` 2.8.2** adapter passed all five direct-provider checks independently for production and preview:

1. Private immutable put.
2. Adoption of an identical retry.
3. Bounded read with SHA-256 verification.
4. Refusal of a conflicting overwrite.
5. Deletion of the task-owned probe object.

Each probe transferred 40 bytes with SHA-256 `aa462dfad10a3547785f6d11b554a81d14758ffa2bc1b32184f3cd29118e2562`. Preview passed at `2026-10-30T14:23:32.547Z`; production passed at `2026-10-30T14:23:34.211Z`. Both reports confirm probe cleanup. The source at `52a6c61` classifies an unequal-size/type immutable conflict from metadata before attempting a bounded content read; equal metadata still requires an actual SHA match.

These checks exercise the live provider port. They do not establish browser upload admission, artifact authorization, SQL publication, or an end-to-end hosted application flow.

## Actual private Sandbox SDK probe

The actual **`@vercel/sandbox` 3.9.1** media gate passed at `2026-10-30T14:01:07.601Z`, using the registered private digest above, **deny-all workload networking**, and **nonpersistent** sessions. The gate in [media-live.ts](../../../packages/studio/verification/media-live.ts) performed actual runtime verification, synthetic WAV rendering and audio probing, and MP4 rendering:

- WAV: empty-track 0.25-second stereo render, 48,000 Hz, 48,078 encoded bytes; the full probe reported `pcm_s16le`, WAV, and 96,000 decoded bytes. Output SHA-256: `be0eabf151ad7d3d1dba503bbe9981f9958d6dc672fc7e2d035bd87e8bf3da3f`.
- MP4: empty-clip one-second 128×96 render at 24 fps, 2,196 bytes, with its `ftyp` signature asserted. Output SHA-256: `986bfe583b3f9b4393be1423b40289f51bc8ef99bb429e4603d6876c677f3e50`.

The live worker SHA-256 is `d1ab0829474c496e417ef6c95455e1eef50c1a1e28452f21e8e0c5fb1f10977b`. Its worker, FFmpeg, FFprobe, Chromium, and font hashes exactly match the retained [OCI report](../../../packages/studio/verification/evidence/media-container.json), built from `21f1642e7b8445029dea4e429095adfc7277c7ee`. All eleven recorded source-closure files and the lockfile also match source `52a6c61`. The new live report contains Node `v24.22.2`, FFmpeg/FFprobe `5.1.9-0+deb12u1`, and Chromium `156.0.8078.73`.

The earlier OCI report remains the evidence for its broader twelve-check/fifteen-request media suite. The live gate proves only the smaller synthetic operation set above; it does not reclassify every local codec, cancellation, publication, or browser test as a live Sandbox test.

The managed workspace required an **operator-only network proxy preload** for the SDK's outbound calls. No proxy endpoint, local preload path, or credential is recorded here. This workaround changed no application source and did not enable network access inside media workloads. A successful SDK probe from that operator session does not by itself prove networking or identity inside the deployed app.

## Remaining release gates at this observation

At the operator handoff, the preview deployment was `dpl_9FfYqDpLd5YQb3zKb5k3LhEcwEHx`, at `https://ai-bdd-studio-atm76hmlh-tyler-r-kendricks-projects.vercel.app`, with state **BUILDING**. The operator also created production deployment `dpl_Bxr93PMmv37RAVuwgMwJ9UWAjxtj` at approximately `2026-10-30T14:39Z`, using the same source and reviewed bindings, at `https://ai-bdd-studio-jlwl3wsph-tyler-r-kendricks-projects.vercel.app`; it was still **BUILDING** at that handoff. These are build observations, not healthy-application results. Production alias activation and application acceptance have not been verified by this receipt. Hosted login, native database transport/migrations, queue delivery and recovery, maintenance chaining, permissions, browser uploads, and durable media publication still need their own actual deployment receipt.

The configured generative Gateway model is `openai/gpt-5.2`; the explicit fx alternative also offers `openai/gpt-5.4-mini` and `anthropic/claude-sonnet-4.6`. The separate decision picker uses provider `vercel-structured`, model `openai/gpt-5.4-mini`, and allowed models `openai/gpt-5.4-mini` / `openai/gpt-5.2`. An actual Gateway attempt returned **HTTP 402 for credit balance**; no successful inference is claimed. T3 remains the default artifact harness and stays safely offline until an actual trusted runtime or endpoint is registered. There is no implicit fx fallback.

GitHub repository OAuth remains disabled in both environments. Its client ID, client secret, and repository-token encryption key must either all be configured or all be absent. The operator removed the partial encryption-key binding after an actual preview startup refusal; no OAuth login or production repository access acceptance is claimed.
