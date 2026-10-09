# Gauge format

ai-bdd reads Gauge-format markdown directly with its own runner. It is **Gauge-format
compatible**; it is **not** a Gauge plugin, and `gauge run` cannot host it (Gauge validates
that every step has an implementation before execution, which is incompatible with an AI
fallback — see [FAQ](faq.md#why-not-use-gauges-own-runner)).

Specs are found by the `specs` globs (default `specs/**/*.{spec,spec.md}`); concepts by the
`concepts` globs (default `specs/**/*.cpt`).

## A spec

```markdown
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
```

## Syntax rules

| Construct | Rule |
| --- | --- |
| Spec heading | `# Heading`, or any line followed by an `=` underline. Exactly one per file. |
| Scenario heading | `## Heading`, or a line followed by a `-` underline. Names must be unique in the spec (they form stable ids and cache keys). |
| Step | A line starting with `*` (not `**`). |
| Tags | `Tags:` (case-insensitive, `Tags :` allowed), comma separated. A trailing comma continues onto the next line. |
| Table | A trimmed line starting and ending with `\|`. The first row is the header; a markdown separator row `\|---\|` is allowed. |
| Step table | A table directly after a step is that step's table argument (no blank line required). |
| Spec data table | A table after the spec heading and before the first scenario makes the spec data-driven: every scenario runs once per row. |
| External data table | `table: path.csv` in the same position loads the rows from a CSV file (RFC 4180). |
| Contexts | Steps between the spec heading and the first scenario run before every scenario. |
| Teardown | Steps after a line of three or more `_` characters run after every scenario, even after a failure. |
| Multiline argument | A line containing only `"""` directly after a step opens a block that ends at the next `"""`. |
| Fenced code | ```` ``` ```` and `~~~` blocks are opaque comments: bullets inside them are not steps. |
| Everything else | A comment. |

Line endings `\r\n`, `\n` and `\r` are accepted, a UTF-8 BOM is stripped, and every node
carries a 1-based line/column location on the original text.

## Step parameters

| Form | Meaning |
| --- | --- |
| `"literal"` | Static parameter. `\"` and `\\` are escapes. |
| `<name>` | Dynamic parameter, resolved from the data-table row and then from concept parameters. An unresolved one is the error `GAUGE_UNRESOLVED_PARAM`. |
| `<file:rel/path>` | The file's contents, read relative to the spec and limited to the project root (`POLICY_DENIED` outside it). |
| `<table:rel/path.csv>` | A step table argument loaded from CSV. |
| `<secret:name>` | An ai-bdd extension: the value is filled by the driver (`typeSecret`) and redacted everywhere else. |

## Concepts

A `.cpt` file holds one or more concepts. Each `#` heading is a signature with `<params>`;
the following `*` steps are the body.

```markdown
# Upgrade the workspace to the <plan> plan
* Open billing settings
* Choose the <plan> plan in the upgrade dialog
* Confirm the upgrade
```

When a spec step matches a concept signature exactly, the step expands in place. Every
expanded step records its origin chain (concept id, definition location, call site,
captured arguments), which appears in the report. Concepts may nest; recursion is
`GAUGE_CONCEPT_CYCLE`. Concepts are matched **exactly, never semantically**, because a
concept is a structural macro.

## Diagnostics

The parser never throws. It returns `{document, diagnostics}`; diagnostics carry a code, a
severity, a message and a source location:

- `GAUGE_NO_SPEC_HEADING`, `GAUGE_MULTIPLE_SPEC_HEADINGS`, `GAUGE_DUPLICATE_SCENARIO`,
  `GAUGE_UNRESOLVED_PARAM`, `GAUGE_CONCEPT_CYCLE` (errors)
- `DIRECTIVE_ORPHAN` (warning) and the other `DIRECTIVE_*` codes

See [Errors](errors.md) for the full taxonomy.
