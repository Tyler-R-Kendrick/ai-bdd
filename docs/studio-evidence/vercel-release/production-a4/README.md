# Production platform and maintenance acceptance at a4c7fdd

On 2026-10-30, the canonical production origin `https://ai-bdd-studio.vercel.app` passed **10 platform checks, zero failures and zero skips** using the existing [runVercelLive runner](../../../../packages/studio/verification/vercel-live.ts). The official Vercel deployment API independently bound the production alias and Ready deployment `dpl_7BqK9hwArJV6cdu2pKK3KAQggM6U` to Git source `a4c7fdd85e36ca366587b2dbbdd8557d255da758`. This is provider deployment metadata, rather than application runtime attestation.

The [receipt](receipt.json) records actual public health and SQL readiness, root SPA/assets/security headers, setup/demo denial, anonymous API rejection, secure owner login, canonical document persistence read from a distinct fresh session, and logout/session revocation. The synthetic project `f4693306-329c-41f9-8162-f007f970ea7a` and document `b5360085-4881-480f-897b-312f2f12e2d9` remain for review. Both runner-created sessions were logged out.

Exactly **one** authenticated `GET /api/studio-maintenance-bootstrap` returned HTTP 200 with `accepted:true`, at `16:56:07.454Z`. Production Neon was empty of schedule state before this call. Subsequent [SELECT-only observations](maintenance.json) showed the same production deployment and generation `93369b0f-0208-489a-8796-3dddeeff4381`: tick `29889656` completed, its scheduled successor `29889657` also completed without another bootstrap, and successor `29889658` was dispatched. This proves two unique completed production maintenance ticks with a continuing native Queue chain; it does not establish exactly-once transport delivery or indefinite availability.

The production Neon target was project `crimson-frog-10403185`, branch `br-shiny-fire-b8tn4wiv`, database `studio`. Database inspection used the connected Neon tool with this explicit target and only the bounded query below:

```sql
SELECT clock_timestamp()::text AS observed_at,
       s.deployment_id, s.generation,
       t.id AS tick_id, t.bucket, t.status, t.dispatched, t.lease_until
FROM studio_schedule s
LEFT JOIN studio_schedule_ticks t ON t.generation=s.generation
WHERE s.id='maintenance'
ORDER BY t.bucket DESC
LIMIT 6;
```

Operator commands used official Vercel CLI 65.8.0 `inspect` and read-only `/v13/deployments/:id`, followed by the source-pinned `runVercelLive({origin,allowWrites:true,...})`. The runner read only the explicit production admin-email/password file references into memory. Bootstrap used the explicit production `CRON_SECRET` file reference in an exact-origin Authorization header. No credentials, cookies, identity tokens or environment values are retained here. Node 24 requests used the workspace's supported HTTP proxy with `NODE_USE_ENV_PROXY=1`; redirects were disabled. An initial direct Node connection failed locally before the supported proxy path was selected, and an initial tsx eval failed before executing the runner; neither was counted as an application gate or successful production request.

This workflow made no deployment or environment changes and invoked no model, Gateway or media job. Configured Blob/identity/media readiness is retained as configured, without inferring operations from configuration. Separate actual media acceptance, local CPU model inference, restoration, capacity and availability targets require their own receipts. These checks exercised persistence through the running deployment without restarting it.

A separate [short availability sample](availability-sample.json) made 48 anonymous HTTPS requests with concurrency four: 12 homepage reads and36 health reads. All returned200; observed p50 was687ms and p95 was1,050ms through the managed network proxy. This eight-second sample uses no credentials or models and establishes neither a sustained throughput ceiling nor an SLO, HA, authenticated editing or inference capacity.
