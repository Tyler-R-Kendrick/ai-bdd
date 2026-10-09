Feature: Cross dialect

  Scenario: Shared sentences
    Given Seed a workspace "Acme" on the "free" plan
    When Open billing settings
    And Upgrade the workspace to the Pro plan
    Then The plan badge reads "Pro"
