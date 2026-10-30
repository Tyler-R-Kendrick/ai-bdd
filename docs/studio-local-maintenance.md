# Long-lived Node maintenance

The standalone `server/main.ts` starts one local maintenance loop after HTTP startup. It runs immediately and then every 15 seconds. A slow cycle is never overlapped: it finishes before another cycle starts. Domain maintenance discovers completed findings, reconciles own-device Planner leases and handles bounded cleanup; durable recovery/outbox delivery then resumes queued work and expired worker leases.

Healthy running leases are preserved. A process restart that occurs before an old worker lease expires does not interrupt that worker or mark its work globally failed. The later local cycle observes actual expiry and the durable coordinator performs its normal fenced claim and named-receipt replay. Authorization, current source, ownership and provider capability checks remain in the domain/coordinator adapters.

A cleanup error is logged without request/provider secrets, and does not prevent durable recovery in the same cycle. SIGINT/SIGTERM stops new cycles, awaits an in-flight cycle, then drains the application/runtime and closes its Store. The local timer is unreferenced so it cannot independently keep an otherwise closed server alive. Vercel functions continue to use the authenticated platform scheduler; no process timer is added to serverless handlers.

`tests/local-maintenance.test.ts` verifies overlap/close/error behavior, an actual killed/replacement Node process with a SQLite job whose lease is still live at replacement startup, exactly one external-step receipt after recovery, actual SIGTERM drain, and startup/shutdown of the real standalone HTTP entrypoint. The process fixture uses an injected 25 ms interval to test the same scheduler without waiting for production intervals.
