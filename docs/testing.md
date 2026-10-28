# Testing ai-bdd

ai-bdd tests itself with ten kinds of test. Each answers a different question, and each has a gate, so that a regression in one kind of confidence shows up as a red check instead of an opinion.

| Kind | Question it answers | Run it | Gate |
|---|---|---|---|
| Unit | Does each function do what it says, atomically, with specific values? | `pnpm test:unit` | CI `unit` (Node 22 and 24) |
| Acceptance (BDD) | Does the whole product behave as specified, through the real CLI and SDK? | `pnpm test:acceptance` | CI `acceptance` |
| Adversarial | Does it resist hostile documents, pages, models and file systems? | `pnpm test:adversarial` | CI `adversarial` |
| Characterization (approval) | Did any output we have approved change? | `pnpm verify:check` | CI `unit` (a snapshot that differs fails its test; `verify:check` is the local check for leftovers) |
| Contract | Does every implementation of a seam honour the seam? | part of `unit`; `driver-cua` contract against the live Cua Driver in CI `cua` | CI |
| Fuzz and property | Do the invariants hold for inputs nobody thought of? | `pnpm test:fuzz` | CI `fuzz` |
| Chaos (fault injection) | What happens when drivers, models, disks and processes fail? | `pnpm test:chaos` | CI `chaos` |
| Coverage | Which code does no test execute? | `pnpm coverage` | CI `coverage` (per-package floors) |
| CRAP | Which complex functions are insufficiently tested? | `pnpm crap` | CI `coverage` (ratcheting baseline) |
| Mutation | Would the tests notice if the code were wrong? | `pnpm mutation <target>` | scheduled workflow, per-target break score |

The live end to end test (`pnpm test:live`, a real provider model and a real browser) is separate: it costs tokens and is run on demand.

The Gherkin/evidence end-to-end acceptance test (`tests/acceptance/gherkin-evidence.test.ts`) uses the official Cucumber parser through the real CLI. It proves that a high-risk `@formal` feature fails until an external proof is attached, then passes a zero-model frozen replay, attaches screenshot/observation/test-report/formal-proof artifacts, persists feature state, and passes `verify-run`.

The commands above use pnpm, the repository's documented package manager (`packageManager`, `pnpm-lock.yaml` and CI). No step needs it, though: after the dependencies are installed by any package manager, every root script runs plain Node or a binary from `node_modules/.bin`. `build` is `node scripts/build-packages.mjs`, which runs the own `build` script of each package `pnpm-workspace.yaml` lists, in dependency order.

## Unit tests

`packages/*/test`, run by Vitest in the `unit` project. A unit test asserts exact values, never "does not throw". Anything that launches a browser or a process gets 30 s, not Vitest's 5 s default. The performance budgets of the parser, assertion and volatile-content tests use CPU time, not wall-clock time (`packages/sdk/test/kit/budget.ts`: `cpuMs`, `bestCpuMs`), so they do not flake under load or coverage instrumentation, and ratio tests have an explicit floor for the baseline. A few tests of the test doubles and the browser driver assert coarse wall-clock bounds of seconds on purpose (a hang must end, a timeout must fire).

Tests that need a desktop or a browser skip themselves when it is missing, with the reason visible. A skipped test is not a pass: CI runs them on runners that have the browser (`playwright` job) and a virtual desktop (`cua` job).

## Acceptance (behavior) tests

`tests/acceptance`. Each file covers one requirement group (`M01`..`M27`) of the specification and drives the real CLI as a subprocess against a generated project, using the deterministic doubles from `@ai-bdd/testing` through the ordinary `drivers` and `models` config keys (the product has no fake mode, see [faq.md](faq.md)). `tests/acceptance/cua.*` run the same scenarios through the real Cua Driver when it is installed.

## Adversarial tests

`tests/adversarial`. One file per attack class from the red-team pass (`a01`..`a16`): parser CPU bombs, boundary-scanner evasions, secrets in recordings, symlinked output directories and so on. The findings and their fixes are in [adversarial-findings.md](adversarial-findings.md). A test here is never weakened to make a fix pass.

## Characterization (approval) tests

`@ai-bdd/verify` is the equivalent of [VerifyTests/Verify](https://github.com/VerifyTests/Verify) for Vitest.

```ts
import { verify } from '@ai-bdd/verify';

it('renders the report', async () => {
  await verify(render(report), { extension: 'md' });
});
```

The result is compared with the committed `__verified__/<test file>.<test name>.verified.<ext>`. On the first run there is none: the test fails and writes the received file for you to read. Afterwards a difference writes `….received.<ext>` next to the verified file and fails with a line diff. `pnpm verify:accept` approves what the last run received (or run once with `VERIFY_ACCEPT=1`); **approval is refused when `CI` is set** (both `VERIFY_ACCEPT=1` and `ai-bdd-verify accept`), so a pipeline can never rewrite its own expectations. `pnpm verify:check` fails if a `.received.` file is left behind, and CI uploads them as an artifact on failure. The test name comes from Vitest's global state, so a snapshot test must not run concurrently with another one (`it.concurrent`).

Scrubbers keep output that varies between runs stable: GUIDs, ISO instants and absolute paths by default; digests, durations, ports and your own counters on request. Equal values keep equal placeholders (`Guid_1` stays `Guid_1`), so a snapshot still shows which occurrences were the same value. Binary snapshots compare bytes. Two tests that map to one file are an error. Details: `packages/verify/README.md`.

Used for: the Markdown chunker, the report formats, the CLI help, the Playwright ARIA tree of the demo app, the Cua Driver's mapping of a **real** window state captured from the product, and the exact calls the Cua driver makes.

## Contract tests

A contract kit is a function that takes an implementation and runs every promise of the seam against it. The kits live in `packages/sdk/test/kit` and are reused by every implementation:

- `runDriverConformance` (copy it for a third-party driver, see [drivers.md](drivers.md#conformance-kit)),
- `runModelContract`: identity, response shape, structured output, tool calls, request immutability, pre-aborted and in-flight abort, failure classification (retryable or permanent), concurrency, determinism,
- `runPlanStoreContract`, `runRecordingStoreContract`, `runEvidenceStoreContract`: round trip, atomic overwrite under concurrent readers, canonical bytes, deterministic listing, hostile ids, symlinks, damaged files, tamper evidence.

Each kit has a self-test that wraps a correct implementation in named mutants (22 for models, 14 for plan stores, 11 for recording stores, 8 for evidence stores) and asserts that the kit fails every one of them. A kit that cannot fail proves nothing.

The Cua driver also has a consumer-driven contract with the real product: raw MCP responses recorded from `cua-driver` are replayed through the driver, the tool calls it makes are pinned, and in CI they are checked against the live tool schemas of the installed Cua Driver (every argument accepted, every enum value allowed, every required argument sent). A Cua Driver update that changes a schema shows up as a reviewable diff.

## Fuzz and property tests

`tests/fuzz`, [fast-check](https://fast-check.dev). A property states an invariant over generated input: the Markdown chunker never reports an internal error and is deterministic; canonical JSON equals a reference RFC 8785 implementation; `checkNavigation` agrees with `new URL`; plan merge is idempotent and independent of order; redaction removes every spelling of every secret; the CLI returns a documented exit code for any argv.

```sh
pnpm test:fuzz                 # 300 cases per property (the expensive ones fewer, never below 25)
FC_RUNS=5000 pnpm test:fuzz    # search deeper
FC_SEED=390400209 pnpm test:fuzz   # replay a failure; the seed and the shrunk counterexample are printed
```

Every default run uses a fresh random seed, so CI keeps looking for new counterexamples. When one is found, the fix is accompanied by a deterministic regression test in the owning package; the property stays.

## Chaos (fault injection) tests

`tests/chaos`, with injectors in `@ai-bdd/testing` (`chaosDriver`, `chaosModels`, real file system helpers). A fault plan is data, `{ seed, rules: [{ at, nth, fault }] }`, and a failing run prints its seed (`CHAOS_SEED=<seed>` replays it). Nothing is mocked at the `fs` level: the helpers change a real directory (replace it with a file, a symlink loop or an escaping link, mount a tiny tmpfs for a real "No space left on device", remount read-only, `chmod`).

What is covered: retry limits (an extraction gets one repair retry, check generation `checks.maxAttempts`), a driver session lost at five different points, garbled observations during characterization and replay, models that time out, refuse, answer in malformed JSON or call unknown tools, calls that never return (the run still stops on abort), SIGKILL in the middle of every kind of write (the next run converges to byte-identical plans and recordings), concurrent processes on one project, and secrets in 38 failure paths.

Tests that need root (mounting a tmpfs) skip with the reason when they cannot run; CI runs the suite unprivileged and then the file-system tests again with `sudo`.

## Coverage

`pnpm coverage` (V8, unit tests) prints a per-package table and fails when a package falls below its floor for lines, branches or functions (`vitest.config.ts`, `COVERAGE_FLOORS`). `node scripts/coverage-report.mjs --gaps` lists every file under 90 % lines or 75 % branches with the uncovered line ranges and the half-taken branches. Floors only go up. Branches that cannot be reached are documented in the pull request that left them; no `istanbul ignore` is used.

| package | lines | branches | functions |
|---|---|---|---|
| cli | 100.0 | 99.1 | 100.0 |
| driver-cua | 99.8 | 96.0 | 93.6 |
| driver-playwright | 98.7 | 91.5 | 84.3 |
| models-ai-sdk | 100.0 | 100.0 | 100.0 |
| playwright-test | 100.0 | 100.0 | 100.0 |
| sdk | 99.2 | 93.1 | 98.9 |
| testing | 99.7 | 93.5 | 99.6 |
| verify | 99.1 | 96.4 | 100.0 |

Measured on the unit tests only. The CLI is also exercised by the acceptance suite through subprocesses, which V8 coverage here does not merge.

## CRAP

`scripts/crap.mjs` scores every function in `packages/*/src` with **CRAP = complexity² × (1 − coverage)³ + complexity**: cyclomatic complexity from the TypeScript AST (nested functions are scored on their own) and the function's own statement coverage. `node scripts/crap.mjs --check` fails on a new function over 30 and on a baselined one that got worse. `scripts/crap-baseline.json` lists the functions that are over 30 today; it is a ratchet: `--update-baseline` lowers or drops entries and never raises one, a new function enters only with `--allow-new`, and the check fails when a baselined function gets worse. An entry that improved keeps its old allowance until someone runs `--update-baseline`, so lock improvements in.

## Mutation testing

Line coverage says a line ran. A mutation test says the tests would notice if it were wrong. [Stryker](https://stryker-mutator.io) changes the code one way at a time (`>` to `>=`, a string to `""`, a branch to `true`), runs only the tests that exercise the target, and counts the mutants that no test kills.

```sh
pnpm mutation --list           # the targets and their break scores
pnpm mutation cua              # one target
pnpm mutation all
```

Targets are in `scripts/mutation-targets.json`: the files to mutate, the test files to run for each mutant, and a `break` score below which the run fails. The runner uses Stryker's `command` runner: every mutant runs `vitest run` over the target's own tests in a fresh process, stopping at the first failure. (The `vitest-runner` plugin was tried first and ran no tests at all with this Vitest version, so every mutant "survived"; a 0 % score that measured nothing. The score is only trusted because a deliberate change in the sources turns it red.)

Surviving mutants are either a test that is missing (write it) or an **equivalent mutant**, one that cannot change behaviour. Equivalent mutants are marked in the source with `// Stryker disable next-line <mutator>: <why>` and a reason; there is no blanket exclusion.

### Measured results

All seven targets were run to completion with the final sources and tests.

| target | mutates | mutants run | killed | timed out (counted as killed) | survived | equivalent (marked) | score | `break` |
|---|---|---|---|---|---|---|---|---|
| `cua` | Cua Driver `keys.ts`, `nodes.ts` | 357 | 357 | 0 | 0 | 18 | 100 % | 95 |
| `verify` | `scrub`, `diff`, `serialize`, `files`, `verify` | 371 | 357 | 14 | 0 | 70 | 100 % | 95 |
| `sdk-util` | `util/index.ts` | 274 | 263 | 11 | 0 | 32 | 100 % | 95 |
| `sdk-assert` | `evaluate`, `volatile`, `lint`, `generate` | 943 | 929 | 14 | 0 | 107 | 100 % | 95 |
| `sdk-plan` | `planner`, `match`, `refs`, `schema`, `store` | 804 | 799 | 5 | 0 | 66 | 100 % | 95 |
| `sdk-recording` | `effect`, `selector`, `secrets`, `volatile`, `verify` (not `recorder`, `store`, `schema`) | 385 | 379 | 6 | 0 | 53 | 100 % | 95 |
| `sdk-markdown` | 7 of the 9 Markdown files (not `discover`, `index`) | 1086 | 1012 | 74 | 0 | 257 | 100 % | 95 |

4,220 mutants run, none survived. 603 mutants are marked equivalent. A further 2,191 were rejected by the TypeScript checker (they do not compile) and are not counted either way.

The first measurements were far lower (the Markdown target started at 66 %, the Cua Driver mapping at 72 %, `sdk-assert` at 76 %). The tests that closed the gap are the `*-mutants.test.ts` files next to the unit tests of the assert, markdown, plan and recording modules (`mutants.test.ts` for verify, `nodes-tables.test.ts` for the Cua mapping, the `sdk-util` tests in `packages/sdk/test/util`): exact values, both sides of every boundary, whole result objects and exact messages.

What these numbers do **not** say:

- The targets cover the modules the user-facing guarantees rest on (parsing, planning, recording, assertions, snapshots, the Cua mapping). They do not cover every file: the CLI, the Playwright driver, the model adapter and the runner are not mutated yet. Add a target to `scripts/mutation-targets.json` to include them.
- "Equivalent" is a judgement. Each of the 603 carries a reason in a comment, and each was checked by applying the mutant by hand and running the module's whole test set. A wrong judgement hides a real gap; review the comments like any other code.
- A `// Stryker disable next-line` comment hides **every** mutant of the named mutators on that line, including ones the tests do kill. The score is therefore a little rosier than the real kill rate on those lines. Where a line mixed equivalent and killable mutants, the comment names only the mutators that are equivalent.
- Stryker binds such a comment to the statement that follows it. Inside a method chain or between `}` and `else` it binds to nothing and the mutant shows up as a survivor; the code was restructured (a named comparator, separate statements) wherever that happened.
- A timed-out mutant (an infinite loop, for instance) counts as detected.
- Each mutant runs the module's tests with 40 random cases per property (`FC_RUNS=40`), so a mutant that only a rare input exposes can survive a run and be caught on another.


## Adding a test

1. Find the lowest kind that can see the behaviour. A pure function wants a unit test and a property; a seam wants the contract kit; a failure mode wants a chaos plan.
2. A bug fix starts with a failing test that reproduces it. Fuzz and chaos failures keep their property and add a deterministic regression test.
3. Never weaken or skip a test to get green. A test that is wrong is fixed with a reason in the commit message.
4. Run `pnpm typecheck && pnpm lint && pnpm test:unit` before pushing; `pnpm coverage` and `node scripts/crap.mjs --check` when you touched `src`.
