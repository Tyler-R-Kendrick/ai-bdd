# ADR: Register read-only mapped loading for the Coder model

Status: accepted for a new loading-strategy assessment; authoring and production release remain gated.

The first Coder assessment was killed by the container's 2 GiB memory limit during model loading, before `model-loaded`, prefill, decoding or generated text. The Docker OOM event and original source are retained. That observation is an allocation failure, not a model-quality result or proof of which internal allocation caused the peak. The previous worker explicitly requested non-mapped loading.

Only the pinned Qwen2.5 Coder model now requests read-only memory-mapped I/O through the existing native loader. All earlier models retain non-mapped loading. The shared immutable registry binds this boolean to the exact model identity and file pin; parent and worker verify it, private requests cannot flip it, and a live worker refuses loading-mode rebinding. Operator preparation removes write permission only for a verified mapped asset. The worker still requires a regular non-symlink file, the expected realpath, exact size and full SHA256, and additionally refuses a writable mapped file. Production assets remain in the read-only image or verified read-only mounts.

The worker keeps `gpuLayers: 0` and `useMlock: false`. The model's 1,536 MiB worker ceiling, 2 GiB whole-container limit, one CPU, 4,096-token context, 1,024-token output and 45-second CPU deadline are unchanged. Weights, tensor precision, decoding, model prompts and validation are unchanged. This I/O allocation choice does not change model or decision fingerprints; the next assessment records a distinct source and strategy instead of relabeling the earlier failure.

Mapped loading is expected to avoid requiring an additional fully materialized file backing during loading. Resource fit and authoring quality are unmeasured for this variant until a new actual case passes. Controlled loader-option and IPC tests establish only the selected strategy and guards. Private worker observations include the registered loading-mode boolean, without paths or model content.
