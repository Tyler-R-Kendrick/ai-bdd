# Initial hosted audio export boundary

The model-free export attempt against Ready preview deployment `dpl_9FfYqDpLd5YQb3zKb5k3LhEcwEHx`, source `52a6c61`, did **not** complete. The exact origin was `https://ai-bdd-studio-atm76hmlh-tyler-r-kendricks-projects.vercel.app`. The [sanitized receipt](hosted-audio-initial-queue.json) preserves the actual HTTP timeline and subsequent supported cancellation.

The application returned JSON health/readiness 200, accepted the owner session, and created one uniquely named synthetic project and one empty-track, 0.25-second, 48 kHz audio artifact. The actual render endpoint returned 202 with a durable job ID. Polling continued to return 200 with status `queued`; there were no 5xx responses or followed redirects in this attempt.

| Task-owned resource | ID |
| --- | --- |
| Preview project | `a2c44a16-37e0-4bd1-bf73-ad1f5210612f` |
| Audio artifact | `ecc34ac2-9df8-4192-9356-336cd635c1c3` |
| Durable audio job | `0e537b7e-efc0-4078-9bbb-4d24421b6bab` |

The release operator independently confirmed that this ServicesV2 deployment had no packaged native queue consumer: its Vite service did not package the `api` source files. Acceptance of a queue send or a durable job was therefore insufficient to establish execution. The implementation workflow moved to explicit Node services for jobs, maintenance, and bootstrap. No internal execution endpoint was called manually to bypass that missing deployment component.

At `2026-10-30T14:49:20.977Z`, the supported application cancellation API returned 200 for **only this task-owned job**. A second fresh authenticated session/read observed `cancelled`, with `fileId` and `downloadUrl` both null. The original polling process also observed cancellation and stopped. The synthetic project/artifact remain for review; production data and unrelated tasks were not deleted or modified.

This result establishes hosted health/authentication, synthetic content persistence, durable enqueue acceptance, and persisted cancellation. It does **not** establish a completed app-to-queue-to-Sandbox export, private Blob publication, WAV download/RIFF/SHA integrity, fresh-session completed-output persistence, or output-file access denial. The separate direct live Blob/Sandbox SDK probes remain scoped to [their own receipt](live-resources.md).

The prepared [hosted acceptance script](../../../packages/studio/verification/hosted-audio-live.mjs) uses Node built-ins, explicit usage opt-in, a protected credential-file reference, and a development identity loaded through Node's environment-file mechanism. All authenticated fetches are scoped to the exact reviewed preview origin with manual redirects. It sends no model requests and uses no external media sources. Its success path requires actual terminal completion, the pinned runtime fingerprint, independently parsed WAV samples, a SHA match with persisted file metadata, fresh-session reload/download, and real anonymous application 401 responses. Those success assertions were not reached in this initial attempt and have not been relabeled successful.
