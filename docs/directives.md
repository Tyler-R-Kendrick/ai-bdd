# Directives

Directives carry rubric and option settings without polluting the step text. They use one
grammar in both dialects:

```markdown
<!-- ai-bdd: mode=judge threshold=0.85 -->
```

```gherkin
# ai-bdd: mode=judge threshold=0.85
```

## Scope

| Placement | Applies to |
| --- | --- |
| Directly after a step (or after that step's table/docstring) | that step |
| Directly after a spec heading or `Feature:` line | the spec |
| Directly after a scenario heading or `Scenario:` line (or after its `Tags:` line) | the scenario |
| Anywhere else | `DIRECTIVE_ORPHAN` (warning), ignored |

Precedence is **step > scenario > spec > config**.

## Keys

| Key | Values | Meaning |
| --- | --- | --- |
| `kind` | `setup` / `action` / `assertion` | Override the inferred kind (`kindSource: 'directive'`). |
| `mode` | `auto` / `check` / `judge` / `both` | Which assertion layers run. |
| `threshold` | `0..1` | Judge pass threshold. |
| `failThreshold` | `0..1`, below `threshold` | Judge fail threshold. |
| `samples` | `1..9` | Judge samples. |
| `vision` | `on` / `off` | Whether the judge receives pixels. |
| `driver` | a configured driver name | Driver for this scope. |
| `resolve` | `auto` / `exact` / `semantic` / `agent` | Restrict the resolution chain. |
| `timeout` | milliseconds | Step deadline. |
| `invariant` | `true` / `false` | Mark an assertion as a non-change check. |

An unknown key is `DIRECTIVE_UNKNOWN_KEY` (error); a bad value is
`DIRECTIVE_INVALID_VALUE` (error).

## Rubric tables

A step table whose header is exactly `| ai-bdd | value |` is consumed as directives and
removed from the step's arguments, in both dialects:

```gherkin
When Upgrade the workspace to the Pro plan
  | ai-bdd | value |
  | mode   | both  |
  | threshold | 0.9 |
```

## Kind inference for keyword-less steps

`*` steps (Gauge and Gherkin) are classified in this order, recording `kindSource`:

1. A `kind=` directive → `directive`.
2. The kind of the binding the step resolves to, when the binding is not `any` → `binding`.
3. A prefix match on the normalized lowercased text: an assertion prefix
   (default `["the ", "a message ", "no ", "verify ", "check ", "expect ", "assert ", "should ", "then "]`)
   **and** an assertion verb
   (default `[" reads ", " shows ", " is visible", " is displayed", " appears", " contains ", " equals ", " is shown", " should ", " explains ", " is not ", " are "]`)
   → `prefix`. Both a prefix and a verb are required.
4. Otherwise `action` → `default`.

Steps with `kindSource: 'default'` or `'prefix'` are recorded in the lockfile so a human can
confirm the classification, and `ai-bdd lint` prints the inferred kinds.

Both lists are configurable through `kinds.assertionPrefixes` and `kinds.assertionVerbs`.

## Vague steps

`ai-bdd lint` warns about demonstratives without qualifiers ("the form", "the button", "it",
"that"), because they are the main cause of `ACT_TARGET_AMBIGUOUS` at runtime. Qualify them
("the billing form") or bind them explicitly.
