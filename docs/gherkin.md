# Gherkin PDDs

`@ai-bdd/gherkin` makes `.feature` files first-class PDD inputs. It uses the official **Cucumber Gherkin parser**, AST builder, message types and Pickle compiler (`@cucumber/gherkin`, `@cucumber/messages`). It does not use a bespoke parser and does not call an extraction model.

```sh
pnpm add -D @ai-bdd/gherkin
```

```js
// ai-bdd.config.mjs
import { defineConfig } from '@ai-bdd/sdk';
import { gherkin } from '@ai-bdd/gherkin';
import { playwright } from '@ai-bdd/driver-playwright';

export default defineConfig({
  docs: ['docs/**/*.feature'],
  extensions: [gherkin({ defaultDialect: 'en' })],
  drivers: { web: playwright() },
  defaultDriver: 'web',
});
```

A JSON config can load the package without importing code:

```json
{
  "docs": ["docs/**/*.feature"],
  "extensions": [{ "use": "@ai-bdd/gherkin", "options": { "defaultDialect": "en" } }]
}
```

The package must export `createDocumentExtension(options)`, which it does. Suffix collisions between extensions are rejected as `CONFIG_INVALID`.

## What compiles

The extension converts one formal Feature into one deterministic plan section:

- Feature, Rule and scenario descriptions retain their source locations.
- Background steps are copied into every resulting scenario, in order.
- Tags on the Feature, Scenario or Examples row become plan tags.
- `Scenario Outline` / `Examples` rows are expanded into individual scenarios with substituted step text.
- Given/When/Then/And/But map to `given`/`when`/`then` using Cucumber's `StepKeywordType`; conjunctions inherit the previous kind.
- Every step and scenario points to its source AST chunk with a quote. Expanded values are executable text, while the quote remains the original template text, so grounding still survives a recompile.
- Syntax errors are `DOC_READ_FAILED` diagnostics. They fail compile; no model is called.

Rules, localized keywords (`# language: fr`, or `defaultDialect`), doc strings and data tables are accepted by the official parser. Step arguments do not need separate glue code: ai-bdd executes the natural-language step through its agent/recording pipeline. If the step needs structured setup, use the existing fixture syntax or a driver fixture rather than duplicating glue.

## Tags and verification policy

Gherkin tags feed both ordinary ai-bdd selection and the feature verification policy:

```gherkin
@web @risk:high @formal @billing
Feature: Upgrade to Pro
  Background:
    Given a registered customer on the Free plan

  @smoke
  Scenario: A customer upgrades
    When the customer clicks the upgrade button
    Then the confirmation dialog shows the prorated charge

  @outline
  Scenario Outline: A customer upgrades to <plan>
    When the customer chooses <plan>
    Then the plan is <plan>

    Examples:
      | plan |
      | Pro  |
      | Team |
```

Policies are resolved from **Feature tags**. Scenario tags remain available for selection and review. See [Verification](verification.md#choosing-a-policy) for the full list and supplemental proof manifest.

Run it through the normal commands:

```sh
ai-bdd compile
ai-bdd show
ai-bdd review accept <feature-id>
ai-bdd run
ai-bdd verify-run .ai-bdd/runs/<run-id>
```

Compiling an unchanged feature makes zero calls and writes identical bytes. `.feature` plans live under `.ai-bdd/plans/docs/…feature.plan.json` alongside Markdown plans.

## Existing Gherkin tooling

For tools that want Cucumber data directly:

```ts
import { parseGherkin } from '@ai-bdd/gherkin';

const { ast, pickles } = parseGherkin(featureText, 'docs/upgrade.feature');
// ast: GherkinDocument; pickles: readonly Pickle[]
```

`parseGherkin` returns the official AST and compiled Pickles, including Background and Examples expansion. The `@ai-bdd/gherkin` package re-exports the `GherkinDocument` and `Pickle` types, so formatters, linters and custom evidence collectors can consume the parse without depending on ai-bdd's plan shape.

Useful boundaries:

- Gherkin linters and editor syntax support can validate the same file before ai-bdd compiles it.
- ai-bdd's JUnit reporter can be consumed by Cucumber-compatible CI dashboards.
- ai-bdd does not run Cucumber step definitions or Cucumber's runtime. If a repository also has a Cucumber suite, both suites run separately against the same application; they do not silently share recordings.
- Cucumber's own attachments and formatters are not executed. Supplemental proof/log artifacts belong in `.ai-bdd/evidence/<feature-id>/`.

## Writing the core extension

A document extension is a small seam in `@ai-bdd/sdk/contracts`:

```ts
export interface DocumentExtension {
  readonly id: string;
  readonly suffixes: readonly string[];
  readonly chunker: Chunker;
  readonly extractor: Extractor;
}
```

The chunker returns the normal `ChunkedDoc` (sources, sections, hashes and diagnostics). The extractor returns normal `ExtractionResult` drafts. From there, planning, review, recordings, runner, reporting and evidence are unchanged. This is why a Gherkin scenario runs through exactly the same e2e path as a prose-derived scenario.

Register extensions in `extensions`. A suffix can have only one owner. Selection is by case-insensitive URI suffix. A Markdown `.md` document uses the built-in chunker/extractor; no extension is required.
