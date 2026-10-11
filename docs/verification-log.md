# Verification log

One entry per VERIFY item (V1-V9): date, command, observed result, action taken.

| Id | Date | Command / evidence | Result | Action |
|---|---|---|---|---|
| V1 | 2026-10-10 | `node --conditions=source packages/cli/src/bin.ts --help` on Node 22.22.0; `packages/cli/test/help-and-spawn.test.ts`; `packages/sdk` `loadConfig` of a `.ts` config | Passes. Workspace `.ts` sources load through native type stripping. | None; no fallback needed. |
| V2 | 2026-10-10 | `pnpm build` and `pnpm typecheck` with TypeScript 5.9.3 | Passes with `allowImportingTsExtensions`, `rewriteRelativeImportExtensions`, `erasableSyntaxOnly` and `customConditions`. | None. TS 7 not adopted. |
| V3 | 2026-10-10 | `docs/integration-notes/P-PLAYWRIGHT.md`; `packages/driver-playwright/test/aria.test.ts` | `page.ariaSnapshot({ mode: 'ai' })` returns `[ref=eN]` and `page.getByRef` resolves it. | None; default-mode fallback not needed. Nodes without a ref are addressed by role/name/index. |
| V4 | 2026-10-10 | goldens in `packages/driver-playwright/test/golden/` captured from Chromium and the Acme app | The grammar is pinned. The snapshot exposes password values. | The driver strips `value` for password inputs and `[data-ai-bdd-secret]` content. The redactor remains the backstop. |
| V5 | 2026-10-10 | `docs/integration-notes/P-AISDK.md` against `ai@7.0.137` | All names confirmed (`generateText`, `Output.object`, `jsonSchema`, `tool({ inputSchema })`, image parts, mock model `MockLanguageModelV4`). | Name mapping recorded in the note. |
| V6 | 2026-10-10 | `pnpm test` (vitest 5.0.3 with `test.projects`: unit, acceptance, adversarial) | Passes with `extends: true` and the alias config. | None. |
| V7 | 2026-10-10 | `docs/integration-notes/P-PLAYWRIGHT.md`; `/opt/pw-browsers` | Chromium is available without download, but at revision 1194 while playwright-core 1.64 expects 1248. | The driver uses `AI_BDD_CHROMIUM_PATH`, then `discoverChromium()`. CI installs Chromium only when missing (`scripts/ensure-chromium.mjs`). |
| V8 | 2026-10-10 | `pnpm lint` (oxlint) | Runs on the repo and is clean. | None; no eslint fallback needed. |
| V9 | 2026-10-10 | `docs/integration-notes/S-MARKDOWN.md` (mdast-util-from-markdown 2.1.0 + gfm + frontmatter) | Same document as LF, CRLF, lone CR, with and without BOM gives identical chunks and positions. | None; no offset table needed. |
