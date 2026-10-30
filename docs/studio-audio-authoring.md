# Audio authoring and verified export

Audio is a separate artifact type with its own persisted content, revision history, chat threads and ADR. Its canvas provides multitrack waveform lanes, source trims, clip positioning and drag movement, split at playhead, reverse, gain, pan, mute/solo, fades, high/low-pass filters and compression. Edits are non-destructive; original uploaded files remain immutable.

The transport uses decoded audio and a real WebAudio graph with seek and pause. An oscillator tone can seed a project without an external provider. Uploaded recordings are fully probed and decoded on the server before the browser allocates PCM; immutable source SHA-256, file size, channel count and duration are checked again by the editor. Project and source limits are 16 tracks, 128 clips, 32 unique sources, 300 seconds, 10 MiB per source, 64 MiB combined encoded data and 64 MiB combined decoded playback buffers. Reverse buffers have a separate 64 MiB cap. Output is stereo at 44.1 or 48 kHz.

Save uses the artifact's exact revision. A remote change preserves the local draft and disables stale writes; the user can download that draft or fetch the latest saved revision. Viewers can audition and download authorized sources, but cannot edit, upload or queue a render.

The native `.audio.json` project embeds original source bytes together with all timeline and mixer settings. Import validates the complete document, uploads its sources into the selected artifact's project, then remaps the references. The browser acceptance test verifies source bytes are identical before and after this move.

WAV, FLAC, MP3, M4A and Ogg mixes run through the durable job runtime. Enqueue freezes the saved content, source revision and configured runtime fingerprint. A different runtime requires a newly submitted export. The worker checks membership, content revision, lease and cancellation, renders bounded owned files, then stages a unique object. File registration, result, receipt and audit commit together. Stale attempts delete their staged objects; cleanup intent survives process loss. No success state is published for an interrupted or revoked job.

The native CPU driver requires FFmpeg and FFprobe on a long-lived worker. The composition accepts `audioRenderDriver` and `audioSourceProbe` ports for hosted execution. The Sandbox adapter is integrated separately; these audio checks prove local actual encoding and the shared worker contracts, not a deployed hosted worker or an external generation service. WebAudio audition uses browser filters/compression; exported mixdown uses FFmpeg's corresponding filters and compressor. Compressor implementations can differ in their transient response.

Verification:

- `pnpm --dir packages/studio test tests/audio-probe.test.ts tests/audio-renderer.test.ts tests/audio-api.test.ts tests/midi-codec.test.ts` checks actual complete-source decoding, forged metadata/resource limits, all five real codecs, independent FFprobe/PCM measurements, trims, fades, split-source clocks, reverse, track/master gain, mute/solo and filtering. MIDI codec checks use the independent `midi-file` decoder.
- `STUDIO_TEST_POSTGRES_URL=… pnpm --dir packages/studio test tests/audio-api.test.ts` runs the publication suite against actual PostgreSQL. It covers durable restart, duplicate delivery, stale uploads, cancellation, membership revocation, source changes, runtime changes, admission quotas and integrity failures. SQLite runs the same suite.
- After `pnpm --dir packages/studio build`, `pnpm --dir packages/studio exec playwright test -c playwright.audio.config.ts` runs the actual product at a dedicated loopback origin with real password login, real uploads, WebAudio analysis and CPU mixdown. It measures downloaded desktop WAV/FLAC and a separately edited mobile WAV, verifies portable project bytes, reload, chat/ADR isolation, conflict recovery and viewer denial. No route or provider response is mocked.

Reviewed evidence is in [audio-authoring/README.md](studio-evidence/audio-authoring/README.md). Screenshots show saved artifact states and completed actual jobs; signal verification comes from independent decoder assertions in the tests.
