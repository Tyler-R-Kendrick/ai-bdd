# Assembled release verification

The actual Studio suite passed **578 tests across 88 files** at `ff88c51`, with the mandatory PostgreSQL binding connected to real PostgreSQL 17. It completed in 114.93 seconds. Production typecheck/build also passed and emitted the client, server, Vercel entry and standalone connector. [report.json](report.json) retains exact source identifiers and workspace log paths.

Subsequent focused checks passed four real client-disconnect/probe cases and eleven source-runtime video/Chromium cases. The MIDI fixture-origin correction was included in the [complete 52-case integrated browser run](../final-all-browser/README.md). The final media-worker bytes were independently executed in actual OCI containers: [worker receipt](../../../../packages/studio/verification/evidence/media-container.json), source `cd3c351`, worker SHA-256 `fb00b1617f865c8cf1ea5eec8e351c430c5562fe2eb1d00cd50f6d52a7f7b2e7`.

The separate [bounded runtime review](../runtime-boundary-review.md) reproduced four issues before owner fixes and independently passed 58 checks afterward. [Repository/SDK evidence](../repo-release/README.md) retains its own source, coverage, script, acceptance and mathematical/proof boundaries. Overlapping counts are not additive.

This is a record of observed local results. Hosted final-head Actions, production deployment, actual identity/provider credentials, private registry/Sandbox execution, object recovery and capacity acceptance require their own receipts. Screenshots establish their stated visible states; they do not prove those operational gates.
