# Authoring docs

ai-bdd reads the documents you already write. You do not need Gherkin, but how you write changes how much of it becomes a deterministic test. This page covers writing testable prose and the directives that steer extraction.

## Writing testable prose

The extractor keeps only behaviour that is **observable through the application UI**. Write for that.

| Do | Why |
|---|---|
| State outcomes as visible facts: "the plan changes to Pro", "an alert says how many invoices are unpaid". | These become `then` steps whose checks are made of roles, names and text. |
| Use the words the UI uses: the button's label, the dialog's title, the heading. | The agent and the check generator match accessible names. |
| Say what the user does and in what order: "Clicking the upgrade button opens a confirmation dialog." | Actions become `when` steps; the sentence supplies the quote. |
| Put values in the sentence: "adds a todo titled Buy milk". | Values become step parameters (`title="Buy milk"`) and are slotted into recordings. |
| Name the region when controls repeat: "submits the **Shipping** section". | Two identical buttons without a distinguishing ancestor in the step text fail with `ACT_TARGET_AMBIGUOUS`, on purpose. |
| Keep one behaviour per sentence. | Smaller steps replay and fail more precisely. |
| Say what is *not* testable plainly ("p95 latency under 200 ms"). | It lands in `notTestable` with a reason instead of producing a fake test. |

Avoid:

- **Subjective criteria** ("should feel friendly"). They become `subjective` steps: the judge runs on every run and costs model calls. Keep them if you want them, but know the price.
- **Volatile assertions** ("shows the time it was added"). Checks cannot pin changing text, so these become `fuzzy` (`volatile-content`). Assert the stable part ("the new todo appears in the list").
- **Data you cannot create in the UI** ("a customer with two unpaid invoices"). Provide a [fixture](#fixtures) or the scenario is `blocked`.
- **Secrets in prose.** Write `<secret:adminPassword>` and declare the secret in config. The value is never written in the doc ([security.md](security.md)).

Before and after:

```markdown
<!-- weak -->
Billing should work well and the upgrade flow should be smooth.

<!-- testable -->
Customers on the Free plan can upgrade from the billing page. Clicking the
upgrade button opens a confirmation dialog that shows the prorated charge.
After the customer confirms, the plan changes to Pro and a confirmation
message appears.
```

## Directives

A directive is an HTML comment, so documents stay valid markdown everywhere else:

```markdown
<!-- ai-bdd: key=value key2="value with spaces" flag -->
```

| Key | Value | Effect |
|---|---|---|
| `ignore` | flag | Chunks are excluded from extraction and coverage. |
| `context` | flag | Chunks are offered to every section's extraction as supporting context. They are never sources and are excluded from coverage. Total context is capped at 4000 characters, in document order. |
| `fuzzy` | flag | Every step sourced from these chunks is `fuzzy` with reason `directive`: the agent and judge run every time. |
| `driver` | name | Driver for scenarios sourced here (`[A-Za-z0-9][A-Za-z0-9._-]*`). |
| `start` | path or URL | Where scenarios sourced here begin, resolved against `baseURL`. |
| `tags` | `"a,b"` | Added to features and scenarios sourced here. A leading `@` is stripped. |

Flags accept `true` or `false`; `ignore=false` re-enables a region inside an ignored one.

### Scope

- A directive **immediately after a heading** (only blank lines or plain HTML between) applies to that heading and its **whole subtree**, up to the next heading of the same or higher level.
- Anywhere else it applies to the **next block** only: a paragraph, blockquote or code block; a whole list; a whole table.
- Inside a list item, a directive before the item's own text applies to that item.
- Nested scopes override outer ones key by key. `tags` merge.
- In YAML frontmatter, the `ai-bdd:` key holds a mapping with the same keys and applies to the whole document.

```markdown
---
title: Billing
ai-bdd:
  tags: billing
---

# Billing

<!-- ai-bdd: start=/settings/billing -->

Account owners manage their subscription on the billing page.

## Glossary
<!-- ai-bdd: context -->

Plan: the subscription level of an account, either Free or Pro.

## Upgrading

Customers on the Free plan can upgrade from the billing page.

<!-- ai-bdd: fuzzy -->
The confirmation message should feel friendly.

### Internal notes
<!-- ai-bdd: ignore -->

Draft thoughts that are not requirements.
```

Here every scenario starts at `/settings/billing` and carries the tag `billing`; the glossary informs extraction but is never tested; only the friendly-message sentence is fuzzy; the internal notes are skipped.

### Diagnostics

All are warnings and never stop a compile:

| Code | Cause |
|---|---|
| `DIRECTIVE_UNKNOWN_KEY` | Unknown key; it is ignored. |
| `DIRECTIVE_INVALID` | Bad value, malformed token, unterminated comment, an orphan directive with nothing after it, a directive inside a paragraph, or a context budget overflow. |
| `DOC_READ_FAILED` (warning) | Frontmatter that is not valid YAML; the frontmatter is ignored. |
| `DOC_CHUNK_TOO_LARGE` | A single chunk longer than `extract.maxSectionChars`; it becomes its own part. |

`ai-bdd compile` prints diagnostics per document.

## Sections and incremental recompiles

Sections (see [concepts.md](concepts.md)) are what get re-extracted. Practical consequences:

- Edit one paragraph and only its section is re-extracted; the rest of the plan stays byte-identical. Ids and review state survive when a scenario's title and steps are unchanged.
- Keep headings stable. A heading rename changes section ids and chunk addresses; relocation by content hash usually absorbs it, but a renamed and edited section is re-extracted.
- Very long sections split at deeper headings. Prefer more headings over one huge section.
- Reordering paragraphs does not dirty anything.

## Fixtures

A `given` that needs data the UI cannot create ("Given a customer with two unpaid invoices") is a **fixture**: a named, typed setup function you register in config. The extractor can pick fixtures only from this catalog, and validates the call:

- the name must exist and the arguments must match the declared types and enums;
- every **string** argument must occur verbatim (case-insensitive) in the step text, unless the param is `derived: true` (for example `unpaid: 2` from "two unpaid invoices");
- anything else removes the fixture and marks the step `requiresState`, so the scenario runs `blocked` with `FIXTURE_REQUIRED` and a stub you can paste.

```ts check
import { defineConfig } from '@ai-bdd/sdk';
import { AiBddError, type FixtureDefinition } from '@ai-bdd/sdk/contracts';

export const seedInvoices: FixtureDefinition = {
  name: 'seedInvoices',
  description: 'Reset the test account, then give it a number of unpaid invoices',
  params: {
    unpaid: { type: 'number', derived: true, description: 'How many invoices are unpaid' },
  },
  async run(args, ctx) {
    const unpaid = args['unpaid'];
    if (typeof unpaid !== 'number' || !Number.isInteger(unpaid) || unpaid < 0) {
      throw new AiBddError('FIXTURE_FAILED', 'seedInvoices: unpaid must be a non-negative integer', { retryable: false });
    }
    const request = ctx.session.request?.bind(ctx.session);
    if (request === undefined) {
      throw new AiBddError('FIXTURE_FAILED', `driver ${ctx.session.driverId} cannot make requests`, { retryable: false });
    }
    const headers = { 'x-test-token': process.env['TEST_API_TOKEN'] ?? '' };
    // Idempotent: confirm runs execute fixtures again in a fresh session.
    await request({ method: 'POST', path: '/__test/reset', headers });
    const res = await request({ method: 'POST', path: '/__test/seed', headers, body: { unpaid } });
    if (res.status < 200 || res.status >= 300) {
      throw new AiBddError('FIXTURE_FAILED', `seeding returned ${res.status}`, { retryable: false });
    }
    ctx.log(`seeded ${unpaid} unpaid invoice(s)`);
    return async () => {
      await request({ method: 'POST', path: '/__test/reset', headers });
    };
  },
};

export default defineConfig({
  docs: ['docs/**/*.md'],
  baseURL: 'http://localhost:3000',
  fixtures: [seedInvoices],
});
```

Rules for fixtures:

- **Idempotent.** Confirm runs re-run fixtures in a fresh session; a fixture that fails the second time shows up as `CHARACTERIZATION_UNSTABLE`.
- **Cleanup.** A returned function runs after the scenario, in reverse order, even on failure.
- **Trusted code.** Fixtures run in your process and are never model output. They can read `process.env` directly, but only values declared under `secrets` are redacted from logs and evidence.
- **Needs a driver `request`.** `session.request` is optional on a driver. The Playwright driver provides it (shared cookies with the page).

With the fixture registered, the doc sentence above becomes `Given a customer with two unpaid invoices` plus `fixture: seedInvoices({unpaid: 2})` in the plan, visible in `ai-bdd show`.

## Parameters

Values in step text that the model marks as parameters are stored as `params` (each value must occur in the step text). Recordings store typed text equal to a parameter as `{param}` rather than a baked-in literal, and checks can compare against a parameter the same way. Changing a value in the doc changes the step text, so the step (and every later step) is characterized again.

## Secrets

Declare `secrets: { adminPassword: { env: 'ADMIN_PASSWORD' } }` in config and write `<secret:adminPassword>` in the doc or let the extractor use the token in a step. The secret's value is read from the environment (at least 4 characters, else `SECRET_TOO_SHORT`) and exists only in the redactor and the value resolver. Recordings store `{secret: "adminPassword"}`. A `<secret:…>` token naming an undeclared secret drops the step (`SECRET_MISSING`).

## Checklist before you commit a doc

- Does each requirement say what the user sees afterwards?
- Do controls have names the UI exposes (labels, headings)?
- Are repeated controls disambiguated by region or dialog?
- Are data preconditions backed by fixtures?
- Is anything marked `fuzzy` or `ignore` on purpose?
- After `ai-bdd compile`: does `ai-bdd status` show the uncovered chunks you expect, and `notTestable` only for things that truly are?
