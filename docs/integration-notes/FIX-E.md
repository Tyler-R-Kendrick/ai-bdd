# FIX-E integration notes

* `node scripts/check-boundaries.mjs --root .` now reports two real violations (introduced by another fix agent's in-progress SDK edits; the scanner rule itself is unchanged):
  * `packages/sdk/src/runner/scenario.ts:17` imports `../recording/secrets.ts` (sibling module internals).
  * `packages/sdk/src/runner/steps.ts:22` imports `../recording/secrets.ts`.
  Fix (SDK owner): export the symbol from `packages/sdk/src/recording/index.ts` and import `../recording/index.ts`. Until then `tests/adversarial/a16-sdk-boundaries.test.ts` "the real repository passes the repository scanner (control)" and `scripts` check-all fail on these two lines.
* `packages/sdk/src/config/load.ts` computes module specifiers at run time (user config / driver / model packages) and uses `createRequire`. It is allow-listed in `DYNAMIC_ALLOWED` in `scripts/check-boundaries.mjs`; moving or renaming that file requires updating the list.
* Transient failures seen while other fix agents were mid-edit: `packages/sdk/src/util/index.ts` imported types without `type` (breaks `check-docs` ts blocks and a16 "public entry points do load"). Not in FIX-E's paths.
