# Local artifact-edit capability control

[Controlled runtime picker](controlled-granite-edit-capability-picker.png), 960 × 800, shows the actual `AgentProfile` component with its normal shared styles. The explicit native T3/Granite profile displays: “Artifact edit proposals are unavailable for this model. Chat and repository reads remain available. Choose another model for edits.”

The component uses an owned read-only HTTP configuration fixture populated by the actual `AgentProfiles.catalog()`. It is an isolated component capture, not a complete Studio editor or account-login test. It includes no generated answer, model inference, decision inference, authentication or production GitHub claim. Selecting another model and applying an edit are not demonstrated by this image.

The fresh build pins source `a263f19b5fa4324022a76123a3fb0d4074b40b8d`, tree `4eedcba61f365c87dcea55486f3db57e2cff64ed`, 141 client inputs, 34 catalog bundle inputs and all 10 emitted assets. Their hashes were rechecked before capture. The first isolated capture omitted Tailwind discovery for imported component utility classes and was preserved privately; this second version corrects only fixture source discovery. Product source and image pixels were not edited between capture and publication.

The bounded capture completed in 2.016 seconds, exited successfully and left no owned processes. It admitted one local Chromium process and zero model/native execution attempts, API mutations or browser faults. The sampled process-tree RSS reached 174,514,176 bytes; this is a sampled observation, not a continuous peak measurement. [Verification metadata](verification.json) records the exact image hash and scope. The author and an independent reviewer opened the image and checked its dimensions, hash and caption.

Controlled source tests separately verify edit admission, old persisted edit jobs, cached visual-output receipts, independent visual classification, allowed chat/repository functions and unchanged decision fingerprints. These software controls do not establish that a model produces correct artifact edits. Actual authoring qualification remains a separate release gate.
