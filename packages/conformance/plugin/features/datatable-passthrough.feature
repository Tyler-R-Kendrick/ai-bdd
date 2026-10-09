Feature: datatable passthrough

  Scenario: datatable-passthrough
    When Seed invoices from the table
      | amount | due        |
      | 10     | 2026-01-01 |
      | 20     | 2026-02-01 |
