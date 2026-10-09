# Workspace billing
Tags: billing, smoke
<!-- ai-bdd: driver=web -->
* Seed a workspace "Acme" on the "free" plan
## Member upgrades to Pro
Tags: upgrade
* Open billing settings
* Upgrade the workspace to the Pro plan
* The plan badge reads "Pro"
* The invoice preview shows a prorated amount
<!-- ai-bdd: mode=judge threshold=0.85 -->
* No error toast is visible
## Downgrade is blocked with unpaid invoices
* Seed 2 unpaid invoices for "Acme"
* Open billing settings
* Try to downgrade to the free plan
* A message explains that unpaid invoices must be settled first
___
* Reset test data
