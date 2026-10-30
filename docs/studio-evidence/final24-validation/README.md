# Frozen PR24 validation

Runtime source: `ddee70150b81adb37e344709c026d3c1c9e9646e`. The follow-up applies only fixture patch `93f89e1739be723fbe6ff525707e008e1ba554c9`, locally cherry-picked as `2851e1af839c1d94ba1842dcbccc845170a75e32`.

The full PostgreSQL-enabled Studio run executed 109 files: **754 passed, two failed and 14 were blocked by suite setup**, in 195.11 seconds. Both failures were questionnaire-position assertions expecting the questionnaire after the newly canonical editable paragraph. The 14 compiler cases could not start because the local Playwright headless-shell installation was absent. They were not passing or intentionally skipped cases.

After applying the named fixture-only correction and selecting the existing `/usr/bin/chromium`, the focused follow-up passed **43/43 with zero skips** in 8.87 seconds: 29 conversation cases, including PostgreSQL, and 14 real Chromium code-bundler cases. This is **not a claim of one clean 770-case full run**. No product source change or repeated full-suite run was needed for these corrections.

Other checks at the frozen runtime source:

| Check | Result | Wall time |
| --- | --- | --- |
| Production Studio build, including TypeScript, Vite, server/hosting bundles and standalone connector | Passed | 18.623s |
| Separate Studio typecheck | Passed | 11.304s |
| Studio lint | Passed | 0.519s |
| Formal interface verification | Passed | 1.394s |

Formal verification produced six exact rational layout certificates, checked nine finite role cases, and returned Z3 `unsat` for the compiled Handwired graph with 483,330 tensor-equivalence cases. External Magnetar verification was not requested and remains `verified:false`; this is not a whole-application proof.

`report.json` records exact commands, source revisions, timing and scope. PostgreSQL 17.11 was checked before execution; the existing fixture volume and ports were preserved. Local Node was 24.19.0 and pnpm 10.28.0. No fat Docker build, unchanged SDK test repeat, live-provider acceptance or full-App browser run belongs to this lane. The genuine hosted Node22 runner investigation and newer UI authority patch are separate workflows and are not represented as covered by this frozen-source record.
