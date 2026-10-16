# Contributing

Thanks for helping with ai-bdd. This repository is the home of the CLI, SDK, drivers, and docs. Behavior changes belong in code and tests; policy for the project itself lives in [GOVERNANCE.md](GOVERNANCE.md). By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- **Node.js >= 22.18** (`engines.node` in [package.json](package.json) is `>=22.18.0`). Continuous integration runs Node 22.x and Node 24.x.
- **pnpm 10.28.0**, the version in the `packageManager` field of [package.json](package.json). Node ships Corepack, which installs that exact version:

  ```sh
  corepack enable
  corepack prepare pnpm@10.28.0 --activate
  ```

## Setup

```sh
git clone https://github.com/Tyler-R-Kendrick/ai-bdd.git
cd ai-bdd
pnpm install
pnpm build
```

`pnpm install` links the workspace packages. `pnpm build` compiles each package under `packages/` to its `dist/`. Some tests import that output, so build before you run acceptance, chaos, or anything that loads a package by name.

## Tests

Continuous integration is [.github/workflows/ci.yml](.github/workflows/ci.yml). The commands below are the ones that workflow runs for the everyday gate:

| Command | What it covers |
|---|---|
| `pnpm check` | Full local gate: generated error doc, requirements, package boundaries, stubs, dependency licenses, plan determinism, and docs (typechecked examples, runnable shell blocks, links). |
| `pnpm test:unit` | Unit tests (Vitest project `unit`). CI runs this on Node 22.x and 24.x. |
| `pnpm lint` | `oxlint` on `packages`, `tests`, and `scripts`. CI runs this on Node 22.x and 24.x. |
| `pnpm typecheck` | `tsc -p tsconfig.json --noEmit`. CI runs this on Node 22.x and 24.x. |

Run `pnpm check` before you open a pull request. Run `pnpm test:unit`, `pnpm lint`, and `pnpm typecheck` for the slice you touched; CI will run all three. The workflow also runs coverage, acceptance, adversarial, fuzz, chaos, Playwright, Cua Driver, and cross-OS determinism jobs. Match the job that your change can affect.

CI installs with `pnpm install --frozen-lockfile`. Commit `pnpm-lock.yaml` when dependencies change.

## Proposing a change

Open a pull request against `main`. Describe what changed and how you tested it. The pull request template asks for a summary, the type of change, the testing you did, and an AI disclosure.

Keep the diff limited to the problem you are solving. Product code lives under `packages/`, `tests/`, and `scripts/`. Update the docs in `docs/` when behavior that users rely on changes.

## Commit messages

Use a clear imperative subject, then a body that explains why:

```text
Reject scenarios whose quote is not in the source chunk

The extractor was keeping paraphrases. A quote that does not match
the chunk after normalization is dropped, so the plan stays grounded.
```

The subject says what the commit does. The body says why, including any constraint a reviewer would not see from the diff alone.

## AI-assisted contributions

Contributions built with coding agents under human direction and review are welcome. You stay responsible for the change: read the diff, run the tests that apply, and do not submit output you cannot explain.

Disclose significant AI-generated content in the pull request. Commits made with an agent should credit the tool and model in the commit message or in the pull request description, for example:

```text
Assisted-by: <tool> (<model>)
```

A typo fix or a line you finished yourself does not need a disclosure. A patch, test suite, or document drafted by an agent does.

## Reporting bugs and requesting features

Use the GitHub issue forms (bug report, feature request). Vulnerability reports go through private reporting, described in [SECURITY.md](SECURITY.md). Please leave secrets, tokens, and customer data out of issues, pull requests, and logs.
