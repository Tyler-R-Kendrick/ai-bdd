# S-EVIDENCE integration notes

Module: `packages/sdk/src/evidence/` (settle, redactor, evidence store, `verifyRun`, `systemClock`). No contract changes are needed and no new dependencies were added.

## Behavior decisions the integrator and neighbors should know

- **`verifyRun` never throws.** An unreadable, non-JSON or malformed `manifest.json` (or a missing run dir) returns `{ ok: false, problems: ['EVIDENCE_CORRUPT: ...'] }`. The CLI maps `ok:false` to exit 1 as in SPEC 5. If the CLI wants a distinct treatment, match the `EVIDENCE_CORRUPT:` prefix.
- **Problem strings:** `missing: <path>`, `modified: <path> (...)`, `extra: <path>`, `digest mismatch: ...`, `unsafe path in manifest: ...`, `manifest entry inconsistent: ...`. "Extra" is evaluated only under `artifacts/` (run-dir files such as `events.jsonl`, `report.json`, `summary.md` are not artifacts and are not checked).
- **Threat model (SPEC 10.6):** detects corruption and naive edits. A malicious runner host that rewrites artifacts and the manifest consistently is out of scope.
- **Manifest entries** are unique per `(path, kind)`. The same bytes stored under two kinds produce one file and two entries. `digest = sha256Hex(canonicalJson(artifacts))` over `{sha256, path, kind, bytes}` entries sorted by path then kind.
- **Artifact extension** is `.png` for `screenshot` byte input, otherwise `.json` when the redacted text parses as JSON, else `.txt`. Non-screenshot `Uint8Array` input is decoded as UTF-8 and redacted. Screenshot bytes are stored verbatim (pixels cannot be redacted; taint gating is the caller's responsibility, R-SE2).
- **Redactor** scrubs, besides the three required forms, the lowercase-hex percent form, the `+` space form, unpadded base64, base64url and the JSON-escaped form. Replacement is a single regex pass (longest candidate first), so placeholders are never re-scanned. `SECRET_TOO_SHORT` carries only `{name}` in `details`, never the value. `redactJson` also redacts object keys.
- **Run ids** containing `/`, `\`, NUL, `.`, `..` or empty are rejected with `POLICY_DENIED`. `runId` generation (`uuidv7()`) stays with the caller (engine).
- **`finalize()`** may be called more than once; each call rewrites the manifest from the artifacts stored so far.
- **Settler:** polling uses `observe({pixels:false})`; a pixel observation that is busy or has a different `treeHash` restarts the quiet window. Aborts reject with `AiBddError('ABORTED')`.
- `systemClock` moved to `evidence/clock.ts` (re-exported from `evidence/index.ts`) and now also rejects immediately for an already-aborted signal and removes its listener.
