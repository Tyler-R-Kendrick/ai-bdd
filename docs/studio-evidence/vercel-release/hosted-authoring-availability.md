The approved preview deployment `dpl_o8cEai5irUYhxfMnSFEnw9nrLoPu`, source `a4c7fdd85e36ca366587b2dbbdd8557d255da758`, was observed Ready by the official Vercel CLI at 2026-10-30 16:11:55 UTC. Its exact origin is https://ai-bdd-studio-enjdwsu1u-tyler-r-kendricks-projects.vercel.app.

At 16:12:11 UTC, actual protected-preview requests returned:

| Request | Result |
| --- | --- |
| `GET /api/health` | HTTP 200, `ok: true`, `x-studio-execution-state: degraded` |
| `GET /api/hosting/readiness` | HTTP 200, `ready: true`, database verified, jobs degraded and not verified |

This verifies that the SQL-backed health/readiness endpoints start despite the previously persisted failed queue intents. Cloud startup now reconciles SQL with `startupDispatchLimit: 0` and does not contact the queue publisher. Native bootstrap, provider publication, queue delivery and the retained audio job's output remain separate acceptance gates. This checkpoint contains no hosted login/document-edit, successful job execution, model inference, availability SLO or load-test claim.

The [sanitized receipt](hosted-authoring-availability.json) records two request observations, not a latency distribution. Preview access used the approved identity header only for that exact host, with manual redirects. No credentials, cookies, environment-file contents, resource changes or new job admissions are recorded. The retained synthetic job `3cb03628-bdbb-4c93-81cc-f313255b85b6` was not cancelled or replaced.
