# Code workspace browser evidence

Captured from the locally built application through authenticated HTTP and Chromium. These are synthetic acceptance projects, with no AI credentials or deployed production service.

- `17-react-typescript-project.png`: renamed React/TypeScript entry persists after save/reload, locally bundled package catalog, running interactive preview.
- `18-pact-provider-state-preview.png`: the populated-cart Pact example selected in preview, without changing the saved artifact.
- `19-source-compiler-diagnostic.png`: intentionally invalid TSX reports its actual source path/line; the test then repairs it through Monaco and verifies the recovered preview. This diagnostic is the requested error case.
- `20-react-typescript-mobile.png`: 390px viewport after the navigation transition completes, interactive counter and no page overflow.

Self-review: opened all four captures, checked their visible state against the assertions and scope above. An initial capture caught the navigation transition mid-frame; the capture now waits for the sidebar to leave the viewport and disables animations. No live integration, model generation, Tailwind compiler, or production deployment claim is made by this evidence.
