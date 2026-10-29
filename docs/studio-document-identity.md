# Canonical document identities

A document block's ID is part of its durable collaborative source, not a browser-local label. Questionnaires, passage reviews, artifact references, and decision anchors must refer to the same block in stored JSON and Yjs state.

`canonicalDocumentIds` clones input, preserves valid unique existing IDs, reserves IDs before allocation, and generates fresh identities for missing or duplicate anchor-bearing nodes. The schema and client UniqueID extension use the same node-type list. Importers return already-canonical nodes; the authoritative Store also canonicalizes authored writes and merged Yjs state under its project lock before persistence and broadcast. A client effect is not the source of truth.

The regression cases cover:

- Missing and duplicated IDs, later reserved IDs, stable repeat normalization, and malformed generators.
- IDs surviving the actual ProseMirror schema for images, block math, and questionnaires.
- A real restricted-MDX questionnaire import, answer, accepted ADR, and browser reload without requiring another edit to initialize the anchor.
- Agent/MCP-shaped authored source on real SQLite and PostgreSQL, with the same questionnaire ID in JSON and durable Yjs state, a working answer endpoint, and unchanged version/state after a viewer reads it.
- Async SQL acceptance, rollback, cursor export, duplicate retry, and source/membership changes while another PostgreSQL instance waits for the project lock.

The SQL tests use actual adapters and transactions. Their authentication and notification transports are explicit fixture doubles; they do not claim a live identity issuer or Redis delivery. The browser import case uses the built UI and authenticated local application. Final integration CI must run the same cases against the assembled application and its actual cloud wiring.
