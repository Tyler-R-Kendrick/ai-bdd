# Reviewed video codec acceptance captures

These captures document the stable #23 codec regression fixes `dc76b07` and `a2c1a39`, on the assembled stable workspace at `e554f1c`. They predate the new #24 Planner and document features. This evidence addition changes no product source and does not represent the newer Planner UI.

| Capture | What it shows |
| --- | --- |
| `studio-video-complete.png` | A saved five-clip composition after the real H.264 MP4/WAV import, trims, split, keyframes, captions, WOFF2, MP4 export and portable ZIP roundtrip. The screenshot shows the editor state; independent file probes establish encoding and audio. |
| `studio-video-unsupported-codec.png` | The real bundled Chromium rejects a valid MP4 containing MPEG-4 Part 2 video, names the browser decoder limitation and suggests reported WebM support. The original single clip and revision remain unchanged. This is not a claim that every MP4 or H.264 source is unsupported. |
| `studio-video-mobile.png` | A separate revision-conflict/viewer fixture at 390×844, with edits and render controls disabled and navigation contained. It is not the five-clip export project. |

All three images were visually reviewed against those claims. The error is readable and does not recommend retrying the rejected MP4 container; the composition is saved with five clips; the mobile view identifies its viewer role.

The positive acceptance file and the API's real local media renderer use official Google Chrome for Testing 156.0.8078.80. Other browser acceptance files retain Playwright's installed Chromium. The negative case explicitly launches bundled Chromium 156.0.8078.4, without a mocked decoder.

Pinned official archive: `https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.80/linux64/chrome-linux64.zip`, SHA-256 `b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7`. The preparer also verifies the executable SHA-256 `1bcad71ad1bff85955db13c6d8dd9f32374934d5a5cb079b526c46fb51f9bd97`.

Focused production App acceptance: `CI=1 PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright STUDIO_MP4_CHROMIUM_PATH=... pnpm --filter @ai-bdd/studio exec playwright test tests/video-editor.spec.ts --retries=0 --workers=1` — 3 passed in 14.2 seconds. Assertions retain original MP4/WAV bytes in the ZIP, H.264/AAC output with 96 frames at 640×360 over four seconds, actual unsupported-codec rejection and unchanged source/version, conflict protection, viewer permissions and mobile containment.

At stable head `79edefbbf4f8c9bd62de5ac740f6cb1170332ec5`, the required hosted Studio and Studio UI browser lanes passed. The Studio release image job also passed its real production startup, restart, persisted context, browser driver and demo-refusal checks. These local codec captures and hosted checks make no live model/provider claim.
