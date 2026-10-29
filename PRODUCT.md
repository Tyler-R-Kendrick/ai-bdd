# ai-bdd Studio

Studio is a collaborative workspace over the existing ai-bdd acceptance engine. A project is a composition of artifacts, led by a living design document. Every artifact owns a canvas, persistent chat, anchored discussions, a dedicated architecture decision record, immutable revisions, and attributed activity.

The audience is a team of product, design, engineering, and QA contributors working together on intent, implementation, and evidence. Owners administer project access; editors author; viewers read the same documents and evidence. AI edits are reviewed proposals. Test status describes the artifact version actually executed.

The primary surface is an operating interface: quiet navigation, a document or media canvas in the center, and an artifact-specific discussion and evidence panel. The implementation preserves the existing SDK and its deterministic replay and evidence-integrity guarantees.

Required product references and boundaries are recorded in docs/studio-architecture.md and docs/studio-readiness.md. Reference products inform interaction patterns; their landing pages and claims do not establish implementation parity. Live provider-dependent behavior and production deployment require the operator's actual credentials, infrastructure, and acceptance evidence.
