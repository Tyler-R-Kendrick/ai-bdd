# Account-device Planner controls

Source: `46b088f4422594591adf091798888fc9c969b66a`.

These are cropped screenshots of the actual React component in Chromium, using explicitly synthetic, typed API responses. They demonstrate device controls and layout; they do not claim that the full application/backend authorization or a live provider account was exercised by this browser fixture. Both published PNGs were visually reviewed against their asserted states.

- `desktop-queued.png`: a request to queue on the user's busy build machine returned a queued assignment. The test verifies the exact device/current artifact revision, shows queued state, and subsequently stops that same assignment with its exact epoch.
- `mobile-viewer.png`: the component at a 390px viewport exposes no launch, stop or device-picker controls to a read-only viewer and has no horizontal document overflow.
- `browser-probe.json`: results extracted from the actual Playwright JSON report. All four cases passed without retries, HTTP 500s or uncaught page errors. Additional cases cover source-conflict feedback with retained selection, other-writer control exclusion, offline devices, and updated artifact/revision request identity.

The separate connector tests exercise real Git, private nonpush worktrees, HTTP control-plane fixtures, scoped WebSockets, a spawned standalone connector and ACP fixture processes. Backend SQL authorization and final full-App mounting are separate integration checks; this component evidence must not be used as a substitute for those checks.

Screenshot SHA-256:

- `desktop-queued.png`: `daf8af67477c26bb24ee9bdd8c4a9e30b10b9e06bbf4d2fed307d56c6709264b`
- `mobile-viewer.png`: `76b15d50608b52ca292569862b5a3b406828169ceddc18f7b7bce06f54a42cf3`
