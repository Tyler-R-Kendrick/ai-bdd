# Canonical editable documents

Every authored design/document source ends in a paragraph before it becomes durable JSON or Yjs state. This matches the installed Tiptap StarterKit `TrailingNode` behavior: any final heading, list, table, code block or atom receives a final editable paragraph; an existing final paragraph, including its text and ID, is preserved.

Use `canonicalDocument` from `packages/studio/shared/document-canonical.ts` for server-authored document normalization. It completes the document ending first, then assigns missing/duplicate anchor IDs with the existing identity helper. It never mutates the caller. The same canonical JSON is serialized into Yjs; normalizing only the returned JSON would leave the collaborative source inconsistent.

`Store.checkedContent` applies this to create, import, agent/MCP and whole-source updates before seeding Yjs. `Store.persistDoc` applies it to the merged latest durable Yjs state under the project source lock before serializing either representation. Replaying canonical state preserves paragraph IDs and does not consume another source version. Authorization, expected versions, accepted-ADR source fences and implementation locks remain enforced. Viewer reads do not perform a source migration.

Without this rule, a server-inserted terminal investigation/questionnaire card caused an editable browser to append a blank paragraph as a second revision. An evidence action against the just-reviewed version then correctly failed as stale. The fix makes the server write match the editor, rather than relaxing the version check or hiding the extra write.

`tests/document-canonical.test.ts` checks pure non-mutation/idempotence and actual SQLite/PostgreSQL JSON/Yjs consistency, viewer reads, authored updates and replay. `tests/findings-ui.spec.ts` checks the complete application: exactly one source revision after reviewed findings, live collaboration without reload, and person-only text-evidence acknowledgement without a source rewrite. Local model/workstation observations are explicit protocol fixtures, not live production measurements.
