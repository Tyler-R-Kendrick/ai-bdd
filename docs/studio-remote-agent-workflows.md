# Remote agent conversations, questions and workflow progress

Remote Planner turns now persist typed incremental text, reasoning, tool input/results, usage, interactive questions and workflow stage reports. The artifact conversation shows these records alongside its design document. These reports describe what the connected runtime observed; they do not establish independent test evidence, approve a build graph, or grant a tool permission.

The implementation is informed by the public Chopin agent-connection reference saved in `work/continuation/references/chopin-agent-connection.md`, especially streamed parts, questions and stage deltas. Studio retains its own negotiated `studio.planner.v1` protocol.

## Behavior

- Ordered, bounded stream parts are acknowledged after durable SQL persistence. Replaying an event identity with different data is rejected. Agent-reported tools cannot impersonate Studio repository tools. Failed tool details are redacted before storage and display.
- Confirm, select, input, editor and questionnaire requests are artifact/thread scoped. Questionnaire answers can be saved individually, including previews, multiple choice and written responses. Written select responses remain visible to the member and return the reference-compatible `null` runtime value. Only a member cancellation retains partial questionnaire answers; other withdrawals return an empty answer set.
- Answers require a signed-in project writer, same-origin browser request, exact source and question revision. An agent bearer token cannot answer its own question. Concurrent responses retain the local draft for explicit review. Questions are withdrawn when the source changes.
- Pause and resume are persisted requests with explicit runtime acknowledgements. Answers to a paused root are held until resume. Stop cancels the durable job and aborts repository reads; late results cannot publish. The portable runtime exposes `onControl` for a runtime that supports pause/resume. The ordinary ACP adapter reports unsupported controls as failed rather than presenting a successful pause.
- Run cards retain full stages and negotiated deltas across reconnects. Parent links stop unfinished descendants while preserving finished outcomes. A reported `finished` run without an end timestamp remains live. A fresh portable client can restore a background session through `resumeSession`; its safe default marks retained work stopped without replaying the completed model turn.
- Human questions have no fixed expiry timer. The portable client suspends its active model time budget while awaiting a person, and reports active work timeout to the durable server. At most 16 questions may remain open across current and retained turns on the same artifact connection; the seventeenth request receives a durable failure without ending the valid turn. Source, membership, job fence, scoped device assignment and assignment epoch remain authoritative.
- Account device credentials use the separate assignment service and cannot become ordinary browser/API credentials. Activity is bound to the server-selected assignment and epoch. Heartbeat traffic alone does not establish live work. Artifact lifecycle checks scan all retained activity in bounded pages.
- Artifact conversation activity offers stable cursor pagination past its latest eight turns, preserves loaded cards and drafts during refresh, and refreshes an older record after an answer or control. Artifact JSON export contains sanitized remote activity, questions, control receipts and ordered events. Read APIs/history remain registered when the remote execution feature is disabled.

The portable ACP client accepts ordinary `agent_message_chunk` updates, explicit `session/request_input` questions and the optional `session/update` extension `{sessionUpdate: 'studio_run_report', runs: <typed report>}`. Its frozen profile records configuration intent; the actual model remains unknown unless the runtime reports it.

## Verification and screenshot review

`tests/remote-agent-state.test.ts` checks pure stream order, tool identity, redaction, stage merging and terminal display semantics. `tests/remote-activity.test.ts` uses actual HTTP and WebSocket servers, the durable runtime and SQLite or PostgreSQL. It covers scoped credential replacement, human waits, timeout delivery, question validation, paused answers, reconnects, retained background work, source changes, stop/read aborts, tool errors and event replay violations. One test spawns a real ACP child process, streams its output and workflow report, answers its question over HTTP, verifies the canonical result, and verifies that an unsupported pause is not claimed as successful.

`tests/remote-planner.test.ts` and `tests/remote-planner-postgres.test.ts` retain the original transport, credential revocation, actual ACP and independent SQL/server reconnect checks. `tests/account-planner-end-to-end.test.ts` separately exercises the real account-device assignment, worker, scoped WebSocket and spawned ACP chain.

The dedicated browser command is:

```sh
pnpm --filter @ai-bdd/studio exec playwright test --config remote.playwright.config.ts
```

All three browser cases use the built application with real password/session/token authentication and actual API/WebSocket traffic. They verify all five question methods, partial and written-answer reloads, held answers and acknowledged controls, export contents, one canonical assistant message, unchanged source, read-only member restrictions, source withdrawal late-output cancellation, and browsing an answered question after nine completed turns and a fresh page load. Captures assert no page errors, server errors, global error banner, device-panel error or activity error.

| Capture | Reviewed claim |
| --- | --- |
| [Stream and paused run](studio-evidence/remote-agents/remote-stream-and-run.png) | Incremental response, source version, reported stage dependencies, paused root, open confirm and questionnaire beside the relevant design. |
| [Completed history](studio-evidence/remote-agents/remote-completed-history.png) | Completed turn, ended workflow, finished stages and retained member responses after reload. |
| [Written answers](studio-evidence/remote-agents/remote-written-answers.png) | Saved custom select/input/editor responses, actual control acknowledgements and one published assistant reply. |
| [Mobile read-only view](studio-evidence/remote-agents/remote-mobile-read-only.png) | Normal mobile artifact drawer, visible question and absence of writer/control actions for a viewer. |

All four PNGs were opened and inspected after the final three-case browser run. Normal panel scrolling focuses the demonstrated controls; the screenshots do not alter application state or styles. The earlier captures containing an unwired device-panel error were replaced and are not release evidence.

The browser runtime is an explicit local protocol fixture, and the ACP integration is a spawned protocol fixture. These checks establish product/protocol behavior, not a live external model, GitHub tenant or production deployment acceptance. Runtime-specific control support remains explicit.
