# Final complete Studio browser regression

On 2026-10-30, **52/52 tests passed across all 18 standard Playwright spec files in 2.8 minutes**, with one worker, zero retries, zero skips and no excluded specs. The production client/server and portable connector build passed from release source `75f1e8d`. Tests ran at `e9613c6`, whose only additional change derives the MIDI fixture Origin from the actual application response URL rather than assuming the standalone port. [report.json](report.json) records the exact commands and source boundaries.

The temporary config imported the standard main-glob config unchanged except `retries: 0`, `reuseExistingServer: false` and a fresh isolated SQL directory. The baseline app used port 8877, self-contained audio used 8891, rebuild used 8895, and the other full-app fixtures owned ephemeral listeners. Every spec ran in this one invocation, including `audio-editor`, `midi-editor`, `rebuild-ui` and all four `final-product` cases. The owned listeners were closed when the suite finished.

This run follows the semantic source-version changes: all six document cases and the full questionnaire-to-human-accepted-ADR workflow passed without an observed stale-version UI race. It also covers native decision eligibility/review, explicit research start, live investigation publication, shared evidence selection, rebuild consent, actual media encodes, measured audio/synth playback, fresh viewer protection and the full older browser baseline. Local model/search/issuer/workstation protocol fixtures remain identified as fixtures. A local browser pass does not certify live provider credentials, classifier accuracy, a deployed environment or whole-product formal correctness.

The retained log is `work/final-all-browser.log` in the shared execution workspace; the build log is `work/final-all-browser-build.log`.

| Fresh reviewed image | Visible state and matching assertion |
| --- | --- |
| [Accepted questionnaire](questionnaire-accepted-desktop.png) | The model-derived proposal is published as an inline questionnaire and retains the exact attributed answer and a separate Accepted ADR after reload under the new version-touch behavior. |
| [Stale review on mobile](design-review-stale-mobile.png) | A saved source edit visibly marks a persisted native assessment Source changed; passage-discussion controls are disabled and native uncertainty remains explicit. |
| [MIDI composition](midi-complete-desktop.png) | The real piano-roll source is saved with edited notes and instrument parameters. The test also verifies untouched MIDI bytes, edited output and measured oscillator timing/pitch; those measurements are separate assertions, not inferred from the screenshot. |
| [Mobile MIDI viewer](midi-viewer-mobile.png) | A fresh viewer sees the retained note in the native piano roll with View only status and disabled edit controls, while the test checks audition/export permission and server-side write denial. |

Each retained image was opened and visually checked against these claims, including legibility, visible state, clipping/overflow and accidental credentials. These captures are from the final integrated run; earlier isolated or partial baseline receipts remain historical evidence for their recorded source commits.
