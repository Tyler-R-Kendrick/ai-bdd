# Video authoring browser self-review

Fresh captures from the locally built media-stack head, using a synthetic authenticated project. All four captures were opened and checked against the actual browser assertions.

- `video-timeline-desktop.png`: saved and reloaded title clip, composition dimensions, transport, timeline and export controls.
- `video-keyframes-desktop.png`: the same saved clip with opacity keyframes at 0 and 0.5 seconds, with value 0.8 retained after reload.
- `integration-policy-desktop.png`: persisted manual/paused participation policy after reload; configured provider state and absence of paired machines remain explicit. This screenshot does not represent a live agent session.
- `video-timeline-mobile.png`: 390px layout after the navigation transition, local horizontal scrolling for export controls and no page overflow.

The real UI workflow authors the clip/keyframes, saves/reloads, downloads and parses the portable HyperFrames ZIP, then renders/downloads MP4. Independent ffprobe verifies H.264, 320x180, 24fps and 1.5 seconds. The preview uses the bundled Inter Variable font rather than falling back to serif. Full local validation before the final focused addition: production build, 161 checks and 29 browser cases; all 4 focused code/video browser cases pass afterward. Hosted CI runs all 30 browser cases at the published head.

These screenshots substantiate the authoring controls and saved state shown. MP4 validity comes from the downloaded-file probe, not from a screenshot. No live media-provider, HeyGen-account or production-deployment claim is made.
