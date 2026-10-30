# Independent runtime and rebuild review

The review began at immutable root revision `d53057e` and finished against the five scoped source files exactly as present in `4acb736`. It covered `server/runtime/jobs.ts`, `server/decisions/models.ts`, `server/integrations/rebuild-machines.ts`, `server/machine/rebuild-bridge.ts` and `server/machine/rebuild-worker.ts`, following their Store authorization, repository identity and Git/ACP launch contracts where needed. Audio implementation was outside this review.

Every finding below was first reproduced with a failing executable test, then sent to its source owner. The reviewer added tests and this report; the owning workflows implemented the product fixes.

| Reproduced issue | Source location in reviewed final revision | Evidence and resolution |
| --- | --- | --- |
| A handler ignoring a delivery abort could publish its return value. An abort during an awaited final SQL callback could also leave that callback's writes committed. Explicit durable `cancel()` was already fenced; this finding concerns delivery abort/deadline/shutdown signals. | `packages/studio/server/runtime/jobs.ts:508`, `packages/studio/server/runtime/jobs.ts:664` | Tests `97bad18` failed both cases on the baseline; the control preserving an output committed before later cleanup abort passed. Owner fix `a73d407` adds abort checks around final publication. All six SQLite/PostgreSQL variants independently pass. |
| An authorized native decision could be classified as access-revoked when its repository permission lease expired while the provider was working. | `packages/studio/server/decisions/models.ts:668`, `packages/studio/server/decisions/models.ts:721`, `packages/studio/server/decisions/models.ts:791` | Test `9121a4d` uses actual local GitHub OAuth/repository HTTP and a native decision HTTP response after 5.5 seconds, with the supported five-second repository lease and ten-second model timeout. The baseline returned 403 although immediate same-user GitHub renewal succeeded. Owner fix `2271044` renews outside SQL and retains the locked ACL/fence check. The original reproduction independently passes. |
| A relative ACP script argument was hashed in the operator checkout but executed from the sealed PR worktree. The runtime receipt could therefore identify different bytes from both actual ACP processes. | `packages/studio/server/machine/rebuild-worker.ts:207`, `packages/studio/server/machine/rebuild-worker.ts:253` | Test `48adb8e` creates two real Git revisions with different `agent.mjs` files and runs real Node ACP processes over an actual HTTP protocol fixture. The baseline's reported script digest differed from both executed scripts. Owner fix `83e4302` pins the selected script to its absolute real path and hashes the actual launch arguments. The original reproduction independently passes. This fixture isolates launch provenance and does not stand in for server-side build verification. |
| Browser rebuild consent checked write entitlement only inside its SQL transaction. An expired grant produced a false denial while the same user still had GitHub push access. | `packages/studio/server/integrations/rebuild-machines.ts:232` | Test `d1c2b81` uses the real machine, checkout, graph and rebuild services with actual OAuth/repository HTTP. Expiring the durable grant made consent fail; immediate provider renewal succeeded. Owner fix `83e4302` adds the outside-SQL renewal and preserves the locked recheck. The original reproduction independently passes. |

Final verification on the frozen source: **58/58 checks passed across ten files in 21.35 seconds**, with `STUDIO_TEST_POSTGRES_URL` pointed at the actual local PostgreSQL 17 instance. This includes the new reproductions plus existing durable job, crash recovery, decision lease/budget/receipt, repository lease, and rebuild lifecycle suites. Studio TypeScript and lint of the four added review test files also pass.

```sh
pnpm --dir packages/studio test \
  tests/runtime-abort-review.test.ts \
  tests/decision-lease-review.test.ts \
  tests/rebuild-provenance-review.test.ts \
  tests/rebuild-consent-lease-review.test.ts \
  tests/durable-jobs.test.ts \
  tests/durable-jobs-postgres.test.ts \
  tests/decision-models.test.ts \
  tests/decision-models-postgres.test.ts \
  tests/rebuild-machines.test.ts \
  tests/runtime-repository-leases.test.ts
```

No unresolved reproduced defect remains in these scoped checks. The review verifies SQL publication fences, current authorization, declared provenance, scoped PR reporting and the exercised protocol contracts. External provider side effects accepted before cancellation cannot be rolled back by these SQL fences, and connector evidence remains attributed to the operator-selected executable rather than a security attestation of arbitrary ACP program behavior. Local HTTP fixtures do not establish live external-tenant or deployed-hosting success. This bounded review is not a repository-wide security certification.
