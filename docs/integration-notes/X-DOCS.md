# X-DOCS integration notes

Owner: `README.md`, `docs/{concepts,authoring-docs,review-guide,drivers,sdk,cli,security,faq}.md`, `scripts/check-docs.mjs`, `scripts/test/check-docs.test.mjs`. Nothing outside these paths was edited.

## `scripts/check-docs.mjs`

```
node scripts/check-docs.mjs [--root <dir>] [--no-ts] [--no-run] [--no-links] [relative/file.md ...]
```

Scans `README.md` and `docs/*.md` (not `errors.md`, `verification-log.md`, `adversarial-findings.md`, nor `docs/integration-notes/`):

1. every fenced block tagged `ts check` is typechecked in one `tsc --noEmit` run with the repository's `tsconfig.base.json` (NodeNext, `source` condition, strict). `@playwright/test` is mapped to `packages/playwright-test/node_modules/@playwright/test`. Errors are reported as `docs/x.md:<line in the markdown file>`.
2. every block tagged `sh run` runs with `bash -e -o pipefail`. Blocks of one file run in document order and share a sandbox; each file gets a fresh one. Tags: `sh run` (cwd is the sandbox repository root), `sh run in=project` (cwd is a fresh copy of `packages/testing/corpus` at `packages/testing/.docs-project`, with `AI_BDD_FAKE=1`, `AI_BDD_FAKE_RULES`, `ACME_ADMIN_PASSWORD` and an `ai-bdd` shim on PATH), `exit=N` (expected exit status). The first failing block of a file stops that file.
3. every relative link and `#anchor` (GitHub slug rules) resolves.

Unknown tags (`ts check foo`, `py run`) are errors.

**Sandbox.** The sandbox is a directory under the OS temp dir that mirrors the repository: `node_modules` and every package except `packages/testing` are symlinks to the real ones, `packages/testing/corpus` is a real copy. `@ai-bdd/*` therefore resolves (through the symlinked `node_modules`) without placing anything in the work tree, so **no `.gitignore` entry is needed for the checker** and it leaves nothing behind (even `cp -r packages/testing/corpus packages/testing/.quickstart`, the README's first command, lands in the sandbox). The outer `CI`, `AI_BDD_*` and `ACME_*` variables are removed from the environment of documented commands.

Verified: `node scripts/check-docs.mjs` passes (9 files, 6 ts blocks, 14 sh blocks, 39 links, about 40 s, no network, no browser). `node --test scripts/test/check-docs.test.mjs` passes (14 tests: block/tag parsing, slugs, links, sandbox semantics with a fake CLI, failure reporting, a real tsc positive and negative case).

### Wiring (not done by me)

`scripts/check-all.mjs`, add to `STEPS` (it needs the finished CLI, so it need not be tolerable):

```js
{ name: 'check-docs', script: 'check-docs.mjs', args: [], tolerable: false },
```

`scripts/check-all.mjs` passes `--root <root>`; the script accepts it. `scripts/test/check-all.test.mjs` asserts the exact `STEPS` list and the tolerable set, so it must get the same entry (`check-docs.mjs` after `check-determinism.mjs`) in the order you choose. The spec's definition of done lists four check scripts for item 4 and `scripts/check-docs.mjs` separately for item 10, so you may instead run it as its own CI step (`node scripts/check-docs.mjs`, needs `bash`, Node 22.x or 24.x, `pnpm install` done; skip on Windows).

CI cost: about 40 s on one Node version; running it on one Node version is enough.

## Requests and observations for X-INTEGRATOR

1. **`.gitignore`**: the README quickstart tells users to `cp -r packages/testing/corpus packages/testing/.quickstart` and delete it afterwards. Add `packages/testing/.quickstart/` to `.gitignore` so a forgotten copy does not show up. Not needed by the checker.
2. **`ai-bdd init` and `.gitignore`**: `init` adds `.ai-bdd/runs/` and `.ai-bdd/cache/` but the repository's own `.gitignore` also ignores `.ai-bdd/report/`, which `run` writes (latest reports). `docs/faq.md` tells users to add it by hand. Suggest P-CLI add `.ai-bdd/report/` to the init entries (the spec §3.1 lists two entries, so this is a deviation to decide).
3. **No `ai-bdd` bin link in the workspace**: `node_modules/.bin/ai-bdd` does not exist after `pnpm install` because the `bin` target is `dist/bin.js` and the packages are not built at install time. The README quickstart therefore defines a shell function around `node --conditions=source packages/cli/src/bin.ts` (V1), and the docs use `pnpm exec ai-bdd` only for installed projects. After `pnpm build` and a second `pnpm install` the link would exist.
4. **Missing secret env on replay (possible bug, not mine to fix)**: replaying a recorded login (`docs-login--administrator-sign-in/...`) with `ACME_ADMIN_PASSWORD` unset does not report `SECRET_MISSING` (spec §9.2 says a missing secret makes the step an `error`). It prints `CHECK_FAILED` on "then the billing page is shown" with `1 healed` and `recording discarded`. Reproduce in a corpus copy: characterize with the variable set, then `env -u ACME_ADMIN_PASSWORD ai-bdd run docs-login--`. The docs do not claim `SECRET_MISSING` behavior for this case.
5. **`run --tag nosuch` / `--grep nosuch` match nothing and exit 0** (`Scenarios: 0 total`), whereas a selector that matches nothing exits 2 (`SCENARIO_NOT_FOUND`). `docs/cli.md` documents the selector behavior only. Decide whether filters should behave the same.
6. **`ai-bdd doctor` without `--offline` probes every model with a request** (it showed `answered with MODEL_NO_RULE` for the fake). `docs/cli.md` says "a minimal request, which can cost a few tokens".
7. **Docs claims that depend on behavior of other modules** (re-verify if those change): fixture string-argument rule and `derived` (S-EXTRACT), directive scope rules (S-MARKDOWN; verified with `createChunker` on a sample document), `CI` defaults and exit codes (P-CLI, S-FACADE), judge thresholds and caching (S-JUDGE), taint and masking rules (P-PLAYWRIGHT, S-EVIDENCE), redactor encodings (S-EVIDENCE). All commands and outputs shown in `README.md` and `docs/cli.md` are executed by the checker or were captured from real runs on 2026-10-10.

## Not folded into the docs (internal detail)

Runner internals (ring of observations, semaphore order, cleanup before confirm runs), recorder volatile-pattern duplication, evidence artifact naming, AI SDK mapping table (stays in `packages/models-ai-sdk/README.md`), the Acme app route table (stays in `packages/testing/README.md`), driver conformance kit options beyond `appUrl`.

## VERIFY outcomes

None assigned. V1 was exercised indirectly: `node --conditions=source packages/cli/src/bin.ts` runs from a symlinked mirror of the workspace (the checker sandbox) on Node 22.22.0.
