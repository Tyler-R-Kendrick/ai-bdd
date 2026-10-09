# Workspace billing

A workspace owner manages their subscription from the billing settings page. Plans are
shown as tiers, and an upgrade is confirmed in a dialog before the invoice preview changes.

- [ ] Seed a workspace "Acme" on the "free" plan

## Member upgrades to Pro

The upgrade path is the primary flow: pick the plan, confirm it, and the badge and the
prorated invoice preview follow.

- [ ] Open billing settings
- [ ] Upgrade the workspace to the Pro plan
- [ ] The plan badge reads "Pro"
- [ ] The invoice preview shows a prorated amount

<!-- ai-bdd: mode=judge threshold=0.85 -->
- [ ] No error toast is visible

## Downgrade is blocked with unpaid invoices

A workspace with outstanding invoices cannot move to a cheaper plan.

- [ ] Seed 2 unpaid invoices for "Acme"
- [ ] Open billing settings
- [ ] Try to downgrade to the free plan
- [ ] A message explains that unpaid invoices must be settled first

## Plans by row

| name | plan |
| Acme | free |
| Globex | pro |
| Initech | free |

- [ ] Seed a workspace <name> on the <plan> plan
- [ ] The plan badge reads <plan>
