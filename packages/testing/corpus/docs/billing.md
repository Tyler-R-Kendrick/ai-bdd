# Billing

<!-- ai-bdd: start=/settings/billing -->

Acme Billing lets account owners manage their subscription plan and review upcoming invoices from the billing page.

<!-- ai-bdd: context -->
## Overview

<!-- ai-bdd: context -->
Acme offers two plans. The Free plan costs nothing and the Pro plan is billed monthly. A plan change takes effect immediately, and the charge for the rest of the billing period is prorated.

<!-- ai-bdd: context -->
## Glossary

<!-- ai-bdd: context -->
Plan: the subscription level of an account, either Free or Pro. Prorated: a charge reduced to cover only the days left in the current billing period. Unpaid invoice: an invoice that has been issued but not yet settled.

## Upgrading to Pro

Customers on the Free plan can upgrade from the billing page. The upgrade button is visible while the account is on the Free plan.

Clicking the upgrade button opens a confirmation dialog. The confirmation dialog shows the prorated charge before anything is billed.

After the customer confirms, the plan changes to Pro and the invoice preview shows the prorated amount. A confirmation message appears once the upgrade is complete.

## Downgrading

Customers on the Pro plan can downgrade from the billing page. A downgrade is blocked while the account has unpaid invoices.

Given a customer with two unpaid invoices, attempting to downgrade shows an alert that says how many invoices are unpaid and asks the customer to settle them first.

When the account has no unpaid invoices, the downgrade goes through: the plan changes to Free and a confirmation message appears.

Refunds and invoice disputes are handled by the support team and are not part of the billing page.

## Tone

Confirmation messages should feel friendly and reassuring rather than technical.

## Performance

The billing endpoints must respond quickly: p95 latency under 200 ms for the plan and invoice requests.
