# Explicit native registration of the pinned local model

The managed OpenCode provider now registers its already configured, verified local model through T3's official `customModels` setting. Native discovery may publish an empty startup inventory; the selected model no longer depends on that inventory becoming populated before strict model admission. Authentication, selected provider/model identity, Supervised mode and project/provenance checks remain unchanged.

The controlled regression uses the actual pinned T3/OpenCode executables and Qwen CPU provider. An owned loopback proxy returns `{ "data": [] }` only for OpenCode's model discovery endpoint. It forwards real native work and provides no MCP capabilities or model answers. The prior configuration fails `model-missing` with zero CPU calls and no checkpoint. Official registration succeeds with the actual answer **4**, exactly one CPU call, and one encrypted checkpoint with its SQL lease released, while four discovery requests still return an empty catalog.

The committed portable fixture ran both cases in fresh offline UID 1000 containers using only the public production dependency closure and pinned assets. The control completed in 37.079 seconds; the registered case completed in 24.365 seconds. These are bounded regression observations, not latency targets. See [native-model-registration.json](native-model-registration.json) for source pins, exact commands, hashes and outputs.

To build the two fixtures from a checkout with installed public dependencies, run `node packages/studio/verification/build-t3-model-registration-fixture.mjs /tmp/studio-registration-fixture`. Mount the generated directory at `/app/dist/server` above the production export and use the recorded commands. The registered case requires `STUDIO_FIXTURE_REGISTERED=1`; the control does not. Both cases require a fresh service account and the verified tools/weights at the recorded paths.

This fixes native model registration during empty discovery. The independent hosted CPU inference deadline requires its own diagnosis and verification; this receipt does not claim a production release or a complete image build.
