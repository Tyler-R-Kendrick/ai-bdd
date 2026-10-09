# Gherkin dialect

Gherkin is an **opinionated dialect of the same core model**, not a second engine. Both
dialects produce the same `SpecDocument`, the same resolutions and the same lock entries
(`R-K18`).

```gherkin
@billing @smoke
Feature: Workspace billing

  Background:
    Given Seed a workspace "Acme" on the "free" plan

  @upgrade
  Scenario: Member upgrades to Pro
    When Open billing settings
    And Upgrade the workspace to the Pro plan
    Then The plan badge reads "Pro"
    # ai-bdd: mode=judge threshold=0.85
    And No error toast is visible

  Scenario Outline: Plans
    When Seed a workspace <name> on the <plan> plan
    Then The plan badge reads <plan>
    Examples:
      | name   | plan |
      | Acme   | free |
      | Globex | pro  |
```

## Mapping

| Gherkin | ai-bdd |
| --- | --- |
| `Background` | `contexts` with `phase: 'context'` |
| `Given` | kind `setup`, `kindSource: 'keyword'` |
| `When` | kind `action` |
| `Then` | kind `assertion` |
| `And` / `But` | inherit the previous step's kind |
| `*` | keyword-less: the kind is inferred (see [Directives](directives.md)) |
| `Rule` | recorded on the scenario |
| `Scenario Outline` + `Examples` | one scenario instance per row, `dataRow` set |
| `DataTable` | `StepArg{type:'table'}` |
| `DocString` | `StepArg{type:'docString'}` (media type preserved) |
| Tags | without the leading `@` |
| `# language: fr` | the parsed dialect is preserved; steps keep their text |
| Comments | a comment line is a directive when it starts with `# ai-bdd:` |

Parse failures never throw: they become `GHERKIN_PARSE` diagnostics with locations.

## Why Gherkin gets better code generation

Because the kind is explicit, ai-bdd can emit real step definitions:

- `When` steps come from recorded `ActProgram`s (Playwright selectors, parameter slots as
  function arguments).
- `Then` steps come from `CheckProgram`s (`expect(...)` assertions).
- Judge-only assertions keep calling the daemon, because there is no deterministic program
  to emit.

`ai-bdd codegen --framework cucumber-js` writes those files, each carrying a header with the
source cache keys and a "do not edit" notice.

## Cross-dialect identity

`fixtures/specs/cross-dialect.spec.md` and `fixtures/specs/cross-dialect.feature` contain the
same sentences; an integration test asserts that both dialects resolve each sentence to the
same binding with the same parameters, and that they share one lock entry per sentence
(modulo the dialect and location fields).
