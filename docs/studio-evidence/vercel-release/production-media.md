Two bounded model-free exports passed on the actual canonical production origin, https://ai-bdd-studio.vercel.app, source `a4c7fdd85e36ca366587b2dbbdd8557d255da758`, deployment `dpl_7BqK9hwArJV6cdu2pKK3KAQggM6U`. The deployment/alias binding and ten platform gates were checked by the release workflow before these requests. That workflow activated maintenance once at 16:56:07 UTC; these protocols did not bootstrap it again.

Production verification required a separate production-write opt-in plus the existing usage opt-in. No preview identity header was sent, no preview environment file was loaded, redirects were not followed, and credentials/cookies stayed in memory. No model, AI Gateway, external asset or upload was used.

| Production result | Actual evidence |
| --- | --- |
| [WAV receipt](hosted-audio-production.json), completed 16:59:01.378 UTC | Empty-track 0.25-second source; 48,078-byte RIFF/WAVE; independently parsed PCM16 stereo at 48,000 Hz, 48,000 sample-data bytes, all samples zero |
| [MP4 receipt](hosted-video-production.json), completed 17:01:39.644 UTC | One-second 128 × 96 source with a white `OK` title over `#223344`; 2,591-byte MP4; independent FFprobe found H.264, 24 fps, 24 frames and one-second duration |

WAV SHA-256: `be0eabf151ad7d3d1dba503bbe9981f9958d6dc672fc7e2d035bd87e8bf3da3f`.

MP4 SHA-256: `1654f5f7af92270b9004c400a622974f4ce38f5d93230f5c22dcde328b4f8a99`. Independent FFmpeg first-frame decoding returned 36,864 RGB bytes. Its corner was `[32, 50, 67]`, consistent with the source background after H.264 conversion, and 195 pixels were bright title pixels. Decoded-frame SHA-256: `ee86fa592f54c14874a35144bf29018c01ad7509cf3ba2e9b023295c5b0eb891`.

Each actual App render moved through the durable queue and configured Sandbox/media driver into private object/SQL publication. Authenticated file bytes matched stored checksum/size, immutable source snapshot, artifact version 1 and the configured private media-image fingerprint. A second fresh owner session reloaded the artifact/render/file and obtained the same checksum. Both file and artifact requests without a Studio session received actual application HTTP 401 with `Sign in to continue`. The four newly created verification sessions were logged out successfully.

Retained synthetic resources for the separately authorized restore workflow:

| Resource | ID |
| --- | --- |
| Shared project | `ac75c051-51af-4a3b-837c-820efdda2c82` |
| Audio artifact, version 1 | `f5a5f464-b465-485e-bb67-fa2e56384391` |
| Audio job and file | `98561d0b-c169-4321-873a-179fdd7f3753` |
| Video artifact, version 1 | `b612863a-2bea-4ff9-a74d-d2cfc27427ef` |
| Video job and file | `4bf1e47f-d55c-44fd-b864-ef2931ae299d` |

No production resources were deleted or overwritten. These two concrete exports do not establish all codecs, imported source processing, load/SLO acceptance, exactly-once provider delivery, restore success or AI inference. Restore results belong to the separate restore receipt. The later manual-chat outage correction is independently tested and is not claimed deployed by these source-pinned observations.
