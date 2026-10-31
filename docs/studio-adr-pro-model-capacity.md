# ADR: Target the existing Pro Performance capacity for Coder

Status: prepared profile; actual authoring qualification and deployment configuration remain gated.

The connected Vercel team has an active Pro subscription. Vercel documents Standard capacity as 2 GB / 1 vCPU and Performance capacity as 4 GB / 2 vCPU on that plan. Selecting the existing Performance profile requires no subscription upgrade or AI credit purchase. No hosting setting is changed by this source commit; the project must be configured deliberately after the qualified source and release gates are ready.

The earlier 1 GiB worker and 2 GiB whole-container assessments retain their original source, limits, CPU affinity and failures. Both Coder loading variants failed during allocation before generated text. Those records do not establish edit quality, and the new capacity profile does not relabel them as passing. The 2 GiB target was an application choice rather than a user requirement.

The new profile assigns only the registered Coder identity a 2,560 MiB worker RSS ceiling inside a 4 GiB application container, leaving 1.5 GiB for the application and native harness. Qwen3 retains 1,536 MiB; all original smaller/default models retain 1 GiB. The global worker maximum is 2,560 MiB, and the immutable file/identity policy still prevents user, artifact, environment or private IPC values from raising an individual model's allocation. Private requests may only lower that model's bound.

The new case targets two permitted CPUs to match Performance capacity. The worker already caps native threads at two; no CPU code changes. Context remains 4,096 tokens, output remains 1,024 tokens, the CPU request deadline remains 45 seconds and the whole-case deadline remains 120 seconds. Model bytes, mapped read-only loading, full checksum/path checks, precision, decoding, prompts, semantic expectations, default selections and fingerprints are unchanged.

The compose sample now explicitly bounds the application at 4 GiB and two CPUs instead of leaving memory and CPU unbounded. Vercel uses the project's supported Fluid memory setting; no unsupported per-function memory field is added to the services manifest. Resource fit and authoring quality still require a new actual source/profile assessment. Controlled IPC tests establish only policy enforcement and observed limits, not a production or model-quality result.

References: [Vercel memory configuration](https://vercel.com/docs/functions/configuring-functions/memory) and [function limits](https://vercel.com/docs/functions/limitations). The earlier [worker-memory decision](studio-adr-local-model-memory.md) and [mapped-loading decision](studio-adr-mapped-model-loading.md) remain historical profile records.
