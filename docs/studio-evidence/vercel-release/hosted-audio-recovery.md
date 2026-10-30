The existing synthetic audio job `3cb03628-bdbb-4c93-81cc-f313255b85b6` passed actual hosted export acceptance at 2026-10-30 16:13:51 UTC. The [sanitized HTTP receipt](hosted-audio-recovery.json) binds both deployments:

| Stage | Source and deployment |
| --- | --- |
| Original admission, observed queued at 15:04:40 UTC | `ff297243772cb39ad46169b86be4d3289955433c`, `dpl_BiuAyCudYtsvsK9GeEmZoQ2pZ6AD` |
| Recovery and fresh-session verification | `a4c7fdd85e36ca366587b2dbbdd8557d255da758`, `dpl_o8cEai5irUYhxfMnSFEnw9nrLoPu` |

Recovery used https://ai-bdd-studio-enjdwsu1u-tyler-r-kendricks-projects.vercel.app. It resumed the same artifact/version/job from the [preserved dispatch checkpoint](hosted-audio-dispatch-checkpoint.md), with no new render admission, source edit, cancellation or replacement. The earlier stopped local poller was retired without changing the hosted job.

The integrations workflow performed one authorized native maintenance bootstrap at 16:12:30 UTC, then observed a completed maintenance tick, dispatched successor, recovered outbox receipts and the job's single fenced SQL publication receipt. These are SQL observations by that workflow; the following HTTP/file observations were independently performed here with fresh owner sessions:

- The existing job returned `completed`, progress 1 and finished time `16:12:37.402Z`.
- Its authenticated same-origin file returned 48,078 bytes with SHA-256 `be0eabf151ad7d3d1dba503bbe9981f9958d6dc672fc7e2d035bd87e8bf3da3f`.
- Independent RIFF/WAVE chunk parsing verified PCM16, stereo, 48,000 Hz, 48,000 sample-data bytes, duration 0.25 seconds and all-zero samples.
- The artifact export's stored byte size/SHA, immutable source snapshot and version 1 matched. The runtime fingerprint referenced private image manifest `sha256:d7d38332686b625e0d8f04b74f16a483d75676023fadac148333d39a9c15c689`.
- A second fresh login retrieved the artifact, completed render list and identical file SHA. Both newly created verification sessions were logged out successfully.
- Requests without a Studio session returned actual application HTTP 401 with `Sign in to continue` for both the file and artifact, while still using the approved preview-access identity. These were not deployment-protection redirects.

This is a real, model-free, hosted queue-to-media-to-private-object/SQL publication recovery check on the approved preview. It does not claim exactly-once provider delivery, successful AI inference, production-domain media acceptance, a load/latency SLO, or broad audio-content coverage. No model calls or external asset sources were used. The retained synthetic project/artifact/file remain available for review; no production content was deleted. The receipt contains no credential values, cookies, environment contents or operator paths.
