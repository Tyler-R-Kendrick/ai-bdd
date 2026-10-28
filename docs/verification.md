# Verification, evidence and PDDs

ai-bdd treats a product design document (PDD) as the source of truth for both behaviour and its acceptance state. A PDD can be Markdown prose, formal Gherkin, or both. The model is deliberately the same for each: compile to a reviewed plan, execute scenarios, attach evidence, retain the latest feature state.

## The feature contract

Every feature in every plan is reported, not only the scenarios selected by the latest command. A selected feature has to satisfy all of the following:

1. **Associated tests.** At least one scenario ran in the current run and its result is listed in `feature.tests`.
2. **Required evidence.** The artifact kinds required by the feature's binary type are present in the current run's content-addressed manifest.
3. **Risk policy.** If formal verification is required, a `formal-proof` artifact is also attached.
4. **Readable artifacts.** `ai-bdd verify-run` confirms every referenced artifact exists, is a regular file, matches its SHA-256 and is covered by the manifest digest.

A violation becomes a `blocked` feature and exits `1`. Missing files in the Playwright integration are errors: they are never silently omitted from the test report.

Features intentionally excluded by `--selectors`, `--tags` or `--grep` retain the state from their last run (`selected: false`). A documented feature with no scenarios in an unfiltered run is `blocked` with `TEST_REQUIRED`.

## The feature verification report

`report.json` is schema version 2. Version 1 remains published unchanged for legacy consumers. Each report contains a `features` array, including empty/frozen reports where it is `[]`.

```json
{
  "schemaVersion": 2,
  "features": [
    {
      "featureId": "docs-billing--upgrade-to-pro",
      "docUri": "docs/billing.md",
      "title": "Upgrade to Pro",
      "status": "passed",
      "selected": true,
      "target": "web",
      "risk": "high",
      "requiredEvidence": ["screenshot", "observation", "test-report", "formal-proof"],
      "formalVerificationRequired": true,
      "tests": [{ "scenarioId": "docs-billing--upgrade-to-pro/upgrade", "status": "passed" }],
      "evidence": [{ "kind": "test-report", "sha256": "…", "path": "artifacts/….json", "bytes": 231 }],
      "problems": [],
      "runId": "0192…",
      "lastRunAt": "2026-10-28T17:00:00.000Z"
    }
  ]
}
```

## Choosing a policy

Configuration supplies defaults; tags on a feature override them.

```js
export default defineConfig({
  verification: {
    target: 'web',
    risk: 'medium',
    evidence: {
      web: ['screenshot', 'observation', 'test-report'],
      cli: ['observation', 'test-report'],
      library: ['observation', 'test-report'],
      api: ['observation', 'test-report'],
    },
    formalVerification: { low: false, medium: false, high: false, critical: true },
  },
});
```

Recognised feature tags:

| Tag | Effect |
|---|---|
| `@target:web`, `@target:cli`, `@target:library`, `@target:api`, `@target:mobile`, `@target:desktop`, `@target:other` | Selects the binary profile. Hyphen form (`@target-cli`) and direct `@cli`/`@library`/`@web` also work. |
| `@risk:low`, `@risk:medium`, `@risk:high`, `@risk:critical` | Selects the risk level; hyphen form (`@risk-high`) works. |
| `@evidence:log,test-report` | Replaces the profile's required artifact kinds. At least one is required. |
| `@formal` | Requires a `formal-proof` attachment regardless of the risk default. |
| `@no-formal` | Disables formal proof for this feature. Use deliberately. |

Evidence profiles answer “what can prove this kind of binary?”; they are not a substitute for choosing a meaningful oracle:

| Binary | Default proof of behaviour |
|---|---|
| Web / mobile / desktop | Screenshot, accessibility observation and the generated test report. |
| CLI | Captured terminal/observation evidence and the command's test report; attach stderr/stdout logs when the terminal is not the driver's observed surface. |
| Library / API | Structured observation and test report; attach the library runner's output or API transcript. |
| Other | Structured observation and test report. |

`test-report` is generated automatically for each selected feature. It records the feature, run and scenario statuses, so even a CLI or library feature always has a machine-readable attachment. Observation and screenshot artifacts come from the runner. Supplemental artifacts cover what ai-bdd cannot generate itself.

The JSON Schema is exported as `@ai-bdd/sdk/schema/run-report.v2.json` and committed at `packages/sdk/schema/run-report.v2.schema.json`. The previous `run-report.v1.json` export remains available. A consumer should reject reports whose feature list does not cover the scenarios it contains.

`.ai-bdd/state/features.json` stores this array between runs. It lets a selected run attach the last verified state of the features it did not execute. The file contains no secret values; supplemental paths and artifact content have already passed the redactor.

## Supplemental evidence and formal verification

Place files under `.ai-bdd/evidence/<feature-id>/` and describe each one in `manifest.json`:

```
.ai-bdd/evidence/docs-billing--upgrade-to-pro/
  manifest.json
  proof.smt2
  cli-stderr.log
```

```json
{
  "artifacts": [
    { "path": "proof.smt2", "kind": "formal-proof" },
    { "path": "cli-stderr.log", "kind": "log" }
  ]
}
```

Kinds are the report's `ArtifactKind` names. Paths are relative, may not be absolute or contain `..`, and symlinks that leave the feature directory are refused. Attachment content is copied into the run's artifact store, redacted and content-addressed. The source manifest is not itself evidence.

A high/critical feature marked for formal verification is blocked until the proof kind exists. ai-bdd verifies attachment integrity, not the semantic soundness of an external prover. Run your SMT/TLA+/Lean/Coq checker in the same CI job before `ai-bdd run`, make its output the proof artifact, and keep the checker's own report as a `test-report` or `log`.

## Release gate

```sh
ai-bdd compile --check
ai-bdd run --frozen --no-agent --reporter json,junit
ai-bdd verify-run .ai-bdd/runs/<runId>
```

`run` gates scenarios and selected feature policies. `verify-run` independently checks feature test coverage, evidence kinds, formal proof obligations and artifact integrity. Use `report.json` v2 or `junit.xml` to publish the result; both are produced from the same run.

## Integration architecture

The pieces interoperate through committed data rather than a shared server:

- **PDD authoring (Chopin / PDD Kit model).** Chopin-style channels keep a repository-grounded document, decisions and discussion together. ai-bdd consumes the document as a committed Markdown or `.feature` file. Migration decisions remain explicit in the document; the generated plan cites their paragraphs and quotes.
- **Gherkin authoring.** `@ai-bdd/gherkin` accepts formal Cucumber syntax and uses the official parser/pickle compiler. Existing Gherkin linters and editors can validate the same file before `ai-bdd compile`.
- **Studio/review surface.** The v2 feature results are UI-neutral: a Gherkin Studio-style view can list each documented feature, its policy, latest tests, attached evidence URLs and verification problems without executing anything. Plans, recordings and state are ordinary JSON.
- **Execution (e2e).** The engine's session/recording/agent/judge loop is the e2e layer. It can drive Playwright, Cua or another driver. Gherkin is an input extension, not a separate runner, so there is one execution path and one evidence model.

See [Gherkin](gherkin.md) for syntax and extension configuration.
