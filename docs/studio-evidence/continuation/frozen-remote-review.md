# Frozen remote and document boundary review

Reviewed runtime: `ddee70150b81adb37e344709c026d3c1c9e9646e` (2026-10-30). The review was bounded to remote activity pagination, answer/control authority, account Planner repository normalization, passage placement, recent agent-change anchors and canonical editable endings. It was not a security certification or live provider/deployment acceptance.

## One reproduced finding, fixed

**P2 — Displayed remote action authority omitted repository write entitlement.** At the frozen revision, `remote-activity.ts` lines 1013–1015 derived `canAnswer` from the project membership and `canControl` from turn/project ownership after only a read authorization. A project editor or second project owner with readable history and denied repository push permission received enabled action flags. Actual answer/control POSTs correctly returned 403; there was no unauthorized answer or source publication.

An isolated HTTP/WebSocket regression failed for both editor and second-owner cases before the fix. Its Store authorization port allows reads and selectively denies writes for the second member, matching the same port used by the actual action routes. It is an explicit authority fixture, not a claim of live GitHub access.

Fix: `bc21bd11fbd5882bac4c9bfad4b50a701ac6c211`. Snapshot flags now use current write authorization outside SQL. Explicit capability denial disables actions while preserving GET/history. Unexpected provider errors are propagated. The original turn-owner/project-owner control restriction remains. No React source change was needed.

The regression also checks an ordinary viewer, a permitted writer, denied action POSTs with unchanged question revision, restored answer authority, exact control-owner rules, outside-SQL preflight, the actual POST's inside-SQL fence and an unexpected 503.

## Other inspected boundaries

- Activity pages use validated artifact/thread scope and positive ordinal cursors. UI merges retain IDs/drafts and refresh the affected older record after an action; reads and writes retain separate authorization paths.
- `ddee701` stores the registered checkout's canonical repository and normalizes trailing slashes consistently in reservation/busy checks. Existing same-device work remains excluded by the actual machine claim test.
- Passage insertion checks current artifact version plus the exact selected index/digest under the project source transaction. An unanchored investigation preserves an existing empty canonical tail; explicit placement after the tail remains explicit.
- Recent-change records require the source publication transaction and exact current anchor/digest. Reads renew repository access before SQL. The client checks its exact current node and ignores stale asynchronous digest work; metadata-first ordering is covered by an actual Chromium fixture.
- Canonical ending tests compare durable JSON and Yjs, stable paragraph IDs, idempotent replay and unchanged viewer reads.

No additional defect was reproduced within these inspected boundaries. Existing parity inventory rows retain some older explicitly named receipts; the current remote workflow document records the later three browser cases and five reviewed captures. The receipts explicitly distinguish local protocol fixtures from live runtime/model acceptance.

## Validation

After the fix, **93 tests across 10 files passed**, with actual PostgreSQL enabled alongside SQLite and ephemeral local HTTP/WebSocket/Chromium fixtures:

- `remote-agent-state.test.ts`
- `remote-activity.test.ts`
- `review-remote-authority-flags.test.ts`
- `account-planners.test.ts`
- `account-planner-remote.test.ts`
- `investigations.test.ts`
- `document-agent-changes.test.ts`
- `document-agent-changes-lease.test.ts`
- `document-canonical.test.ts`
- `document-agent-changes-browser.test.ts`

The new two-case regression also passed separately on SQLite and PostgreSQL. Studio typecheck and lint for the changed files passed. The review used ephemeral ports and independent test schemas; it did not use the baseline browser owner's port 8877 or alter PostgreSQL infrastructure.
