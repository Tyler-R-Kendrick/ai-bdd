@billing @smoke
Feature: Workspace billing
  # ai-bdd: driver=web

  Background:
    Given Seed a workspace "Acme" on the "free" plan

  @upgrade
  Scenario: Member upgrades to Pro
    When Open billing settings
    And Upgrade the workspace to the Pro plan
    Then The plan badge reads "Pro"
    And The invoice preview shows a prorated amount
    # ai-bdd: mode=judge threshold=0.85
    And No error toast is visible

  Scenario: Downgrade is blocked with unpaid invoices
    Given Seed 2 unpaid invoices for "Acme"
    When Open billing settings
    And Try to downgrade to the free plan
    Then A message explains that unpaid invoices must be settled first
