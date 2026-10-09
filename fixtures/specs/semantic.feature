@semantic
Feature: Semantic resolution

  Scenario: A free-tier workspace is seeded through a synonym
    Given there's a free-tier workspace called Acme
    When Open billing settings
    Then The plan badge reads "free"

  Scenario: The negation trap must not bind
    Given Seed an empty workspace
    When Open billing settings
    Then The plan badge reads "free"
