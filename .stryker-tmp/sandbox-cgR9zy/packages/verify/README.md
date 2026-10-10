# @ai-bdd/verify

Approval testing for vitest in the style of [VerifyTests/Verify](https://github.com/VerifyTests/Verify): the expected output is a **verified file you commit**, a changed output becomes a **received file** you review, and you **approve** it to make it the new expectation. It is what ai-bdd's own tests use for plans, reports, `--help` text, accessibility trees and parser output.

```ts
import { verify } from '@ai-bdd/verify';

it('renders the plan', async () => {
  await verify(plan);                                 // objects become stable JSON, strings stay text
  await verify(report, { name: 'report', scrubbers: [durations()] });
});
```

## How it works

| File | Meaning |
|---|---|
| `__verified__/<test file>.<test name>[.<name>].verified.<ext>` | The approved output. Committed. |
| `__verified__/<...>.received.<ext>` | What the test produced when it differed. Git-ignored, deleted when the test passes again. |

1. First run: no verified file, the test **fails** and writes the received file. Read it.
2. If it is right, approve: `pnpm verify:accept` (every received file) or run the test once with `VERIFY_ACCEPT=1`. Commit the verified file.
3. Later runs compare against it. A difference fails with a line diff and writes the received file again.

`VERIFY_ACCEPT=1` is **refused when `CI` is set**: a pipeline can never rewrite its own expectations. `pnpm verify:check` fails when received files are lying around (CI uploads them as an artifact).

## Scrubbers

Output that varies between runs is made stable before it is compared. By default guids, ISO-8601 instants and absolute paths (`{root}`, `{tmp}`) are scrubbed; equal values keep equal placeholders (`Guid_1`, `Guid_2`), so a snapshot still shows which occurrences were the same value.

```ts
import { digests, durations, ports, counted, replace } from '@ai-bdd/verify';
await verify(output, { scrubbers: [durations(), ports(), counted(/user-\d+/, 'User')] });
```

Options: `name` (several snapshots in one test), `extension`, `scrubbers`, `scrubDefaults: false`, `directory` and `fileName` (keep a fixture layout, e.g. `golden/<case>.chunks.verified.json`).

Binary values (`Uint8Array`) are compared byte for byte. Two tests whose names map to the same file are an error rather than a silently shared snapshot. Line endings and trailing blanks are normalized, so a Windows checkout of a verified file still matches.

## CLI

`ai-bdd-verify list|check|accept [dir]` finds `*.received.*` files under `dir` (default: the current directory).
