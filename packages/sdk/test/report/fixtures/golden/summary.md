# ai-bdd run summary

- Run: `01900000-0000-7000-8000-000000000001`
- Started: 2026-10-09T10:00:00.000Z
- Finished: 2026-10-09T10:00:42.500Z
- Exit code: 3
- Options: frozen=true, strict=false, audit=false, noAgent=false, updateRecordings=false, recordings=read-only, workers=4

## Totals

| Status | Scenarios |
| --- | --- |
| error | 1 |
| failed | 1 |
| inconclusive | 1 |
| blocked | 1 |
| healed | 1 |
| passed | 2 |
| skipped | 1 |
| total | 8 |

## Failures

### `docs-billing--upgrade-plan/downgrade-needs-invoice` — blocked

- Title: Downgrade with open invoices
- Error: `FIXTURE_REQUIRED` Step needs state the UI cannot create; register a fixture.
- First failing step: #1 `given` a customer with two unpaid invoices — blocked, `FIXTURE_REQUIRED`

Fixture stub:

```ts
import type { FixtureDefinition } from '@ai-bdd/sdk';

export const aCustomerWithTwoUnpaidInvoices: FixtureDefinition = {
  name: 'aCustomerWithTwoUnpaidInvoices',
  description: 'a customer with two unpaid invoices',
  params: {},
  async run() { /* create the state */ },
};
```

### `docs-billing--invoices/list-invoices` — failed

- Title: Invoices are listed
- Error: `CHECK_FAILED` row "INV-1" not found | table has 0 rows
- First failing step: #2 `then` the invoice table lists INV-1 — failed, `CHECK_FAILED`

### `docs-billing--invoices/invoice-looks-good` — inconclusive

- Title: Invoice PDF looks good
- Error: `JUDGE_INCONCLUSIVE` judge score 0.55 is inside the inconclusive band
- First failing step: #2 `then` the invoice looks professional — inconclusive, `JUDGE_INCONCLUSIVE`

### `docs-auth--login/session-expires` — error

- Title: Session expires
- Error: `DRIVER_UNAVAILABLE` browser crashed
- First failing step: #1 `when` the user waits for the session to expire — error, `DRIVER_UNAVAILABLE`

## Healed

These steps passed only after the recorded replay diverged. Review the app or the recording.

- `docs-billing--upgrade-plan/receipt-is-shown` step #1 `when` the user clicks "Upgrade to Pro"

## Fuzzy steps

These steps are not deterministic and keep running through the agent or the judge.

| Scenario | Step | Text | Path | Reasons |
| --- | --- | --- | --- | --- |
| `docs-billing--invoices/list-invoices` | 1 | when the user opens the invoices page | agent | volatile-content |
| `docs-billing--invoices/invoice-looks-good` | 2 | then the invoice looks professional | judge | subjective |
| `docs-auth--login/session-expires` | 1 | when the user waits for the session to expire | agent | unspecified |

## Unreviewed scenarios that ran

These scenarios were extracted by a model and have not been accepted by a reviewer.

- `docs-billing--upgrade-plan/receipt-is-shown` — healed
- `docs-billing--invoices/list-invoices` — failed

## Traceability

### `docs/auth.md`

Coverage: 3 of 4 chunks covered, 0 uncovered, 0 not testable.

| Section | Chunk | Scenarios | Status |
| --- | --- | --- | --- |
| `authentication/login` | Users sign in with their password and land on the dashboard. | `docs-auth--login/login-with-password` | passed |
| `authentication/login` | Sessions expire after 30 minutes of inactivity. | `docs-auth--login/session-expires` | error |
| `authentication/login` | A remember-me checkbox keeps the user signed in. | `docs-auth--login/remember-me` | skipped |

**Uncovered chunks (0)**

None.

**Not testable (0)**

None.

### `docs/billing.md`

Coverage: 8 of 11 chunks covered, 1 uncovered, 1 not testable.

| Section | Chunk | Scenarios | Status |
| --- | --- | --- | --- |
| `billing/upgrades` | Free users can upgrade to the Pro plan from the billing page. | `docs-billing--upgrade-plan/upgrade-to-pro` | passed |
| `billing/upgrades` | Select "Pro" \| "Team" from the plan picker, then confirm the upgrade. | `docs-billing--upgrade-plan/receipt-is-shown` | healed |
| `billing/upgrades` | After upgrading a receipt is shown with the amount charged and the next billing… | `docs-billing--upgrade-plan/receipt-is-shown` | healed |
| `billing/upgrades` | Downgrading is blocked while invoices are unpaid. | `docs-billing--upgrade-plan/downgrade-needs-invoice` | blocked |
| `billing/invoices` | Invoices are rendered as professional-looking PDFs. | `docs-billing--invoices/invoice-looks-good` | inconclusive |
| `billing/invoices` | Invoice: INV-1; Status: paid | `docs-billing--invoices/list-invoices` | failed |
| `billing/invoices` | (chunk not in plan: billing/ghost/p9) | `docs-billing--invoices/invoice-looks-good` | inconclusive |

**Uncovered chunks (1)**

- `billing/upgrades/li4` Annual plans renew automatically.

**Not testable (1)**

- `billing/performance/p1` The invoice list loads in under 200 ms at p95. — latency target is not observable through the UI

### `docs/legacy.md`

Coverage: 0 of 2 chunks covered, 1 uncovered, 0 not testable.

_No plan was supplied for this document, so scenario traceability is unavailable._

**Uncovered chunks (1)**

- `old/p1`

**Not testable (0)**

None.

## Usage

| Purpose | Model calls | Input tokens | Output tokens |
| --- | --- | --- | --- |
| extract | 0 | 0 | 0 |
| act | 7 | 5100 | 400 |
| checkgen | 1 | 1000 | 100 |
| judge | 4 | 3100 | 200 |
| total | 12 | 9200 | 700 |

Estimated cost: $0.4217 USD

## Warnings

- `PLAN_CONTEXT_CHANGED` (warning) `docs/billing.md` context chunk changed in docs/billing.md
