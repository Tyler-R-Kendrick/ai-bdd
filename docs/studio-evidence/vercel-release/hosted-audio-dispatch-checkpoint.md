# Hosted audio dispatch checkpoint

The official Vercel CLI reported preview `dpl_BiuAyCudYtsvsK9GeEmZoQ2pZ6AD` Ready before this actual attempt. The reviewed source was `ff297243772cb39ad46169b86be4d3289955433c`, at exact origin `https://ai-bdd-studio-6ohooihxc-tyler-r-kendricks-projects.vercel.app`. This attempt created one new synthetic project/audio artifact and submitted one model-free, 0.25-second empty-track WAV export. It did **not** reach execution or publication at this checkpoint.

The [sanitized actual trace and SQL observation](hosted-audio-dispatch-checkpoint.json) records health/readiness/authentication 200, content creation 201, render enqueue 202, and subsequent authenticated polling 200 with status `queued`. The runtime readiness response distinguished a verified database from configured object, media, and job adapters; it did not claim those adapters had completed this export.

| Task-owned record | ID |
| --- | --- |
| Project | `3821d32e-587a-4621-bd9a-75bb62f2be9b` |
| Audio artifact | `16f74f4b-40c1-4707-ab61-d65149cb3301` |
| Original durable job retained for recovery | `3cb03628-bdbb-4c93-81cc-f313255b85b6` |

A targeted actual preview SQL observation at `2026-10-30T15:08:28Z` found the same `audio.render` job queued, **zero worker attempts**, no progress, and a pending dispatch intent with one dispatch attempt and no provider receipt. The generic outbox diagnostic did not establish the upstream provider's root cause. There is no Sandbox execution, output file, or completed-export claim here.

The operator paused the HTTP poller and preserved the application job unchanged for an actual deployment/outbox recovery check. No internal execution endpoint was called, no additional audio job was admitted, and this job was not cancelled. The trace retains the real polling timestamps. A subsequent recovery receipt must identify this original job, its original source/version, the new deployment used for observation, terminal publication, actual file bytes/SHA, fresh-session persistence, and application-level authorization denial.

The [initial source 52 enqueue/cancellation receipt](hosted-audio-initial-queue.md) describes a separate earlier job and the missing-consumer packaging boundary. The present checkpoint does not reuse that earlier explanation as a diagnosis of the current publisher failure.
