Feature: docstring passthrough

  Scenario: docstring-passthrough
    When Seed a workspace from a document
      """
      workspace: Acme
      plan: free
      """
