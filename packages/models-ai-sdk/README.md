# @ai-bdd/models-ai-sdk

Vercel AI SDK (`ai` v7) adapter for ai-bdd. It turns AI SDK language models into the four `ChatModel`s an ai-bdd engine needs (`extract`, `act`, `checkgen`, `judge`).

`ai` is a peer dependency. Local model instances can be supplied directly. Gateway model strings are admitted only through the shared free-model price and routing guard.

## API

### `aiSdkModels(models, opts?) -> ModelSet`

```ts
import { aiSdkModels } from '@ai-bdd/models-ai-sdk';

const models = aiSdkModels(
  {
    extract: 'nvidia/nemotron-3.5-lightning-free',
    act: 'nvidia/nemotron-3.5-lightning-free',
    checkgen: 'nvidia/nemotron-3.5-lightning-free',
    judge: 'nvidia/nemotron-3.5-lightning-free',
  },
  { maxRetries: 2 }, // passed straight to the AI SDK; its default applies when omitted
);
```

Each value is an AI SDK `LanguageModel` object or a model id string. Strings and Gateway-provider objects use `createFreeGateway`, so a global provider cannot silently bypass the free-only routing policy. Explicit server options may provide guarded Gateway transport configuration through `opts.gateway`; JSON configuration cannot supply transport functions.

### `createModelSet(options) -> ModelSet`

The JSON-config form, used by `{"models": {"use": "@ai-bdd/models-ai-sdk", "options": {...}}}`:

```json
{ "extract": "nvidia/nemotron-3.5-lightning-free", "act": "nvidia/nemotron-3.5-lightning-free", "checkgen": "nvidia/nemotron-3.5-lightning-free", "judge": "nvidia/nemotron-3.5-lightning-free", "maxRetries": 0 }
```

All four purposes are required non-empty strings. Unknown keys and invalid values throw `CONFIG_INVALID`.

The guard checks fresh public catalog and endpoint pricing before every actual SDK attempt, restricts providers to verified zero-priced routes, and refuses model fallbacks, BYOK, tiers and unknown fees. Metadata requests carry no credentials. Free model availability and account access are separate: a zero-priced model can still return HTTP 402 without account activation. No purchase or paid fallback is performed. See [Studio free-model policy](../../docs/studio-free-models.md) for the exact bounds and evidence.

`createFreeGateway` returns a frozen provider exposing only language and native decision/evaluation factories. Unsupported modalities, SDK-hosted tools, batch APIs and direct WebSocket factories are absent, so an SDK addition cannot silently bypass the HTTP price guard. Standalone `Request` bodies are consumed once, bounded to 16 MiB while reading, and canceled on caller abort or a 10-second body deadline; explicit `init.signal: null` clears the Request signal as in Fetch.

## Mapping

| ai-bdd | AI SDK |
|---|---|
| `system` | `instructions` |
| `messages` (`user`, `assistant`) | `ModelMessage`s. Image parts become `{type: 'file', mediaType: 'image/png', data}`. |
| assistant `toolCalls`, `tool` messages | `tool-call` and `tool-result` (`output: {type: 'json'}`) parts |
| `tools` | `tool({description, inputSchema: jsonSchema(schema)})` with no `execute`, so calls are returned and never run |
| `toolChoice` | `toolChoice` (only when tools are present) |
| `output` | `Output.object({schema: jsonSchema(schema), name})` |
| `temperature`, `seed`, `maxOutputTokens`, `signal` | `temperature`, `seed`, `maxOutputTokens`, `abortSignal` |
| `context` | **never sent** (it exists for fakes, logs and evidence) |

The response maps `toolCalls[]` to `{id, name, args}`, the parsed output to `object`, `text`, `usage` (`undefined` counts as 0), `finishReason` (`content-filter` becomes `other`) and `modelId`.

## Errors

Every failure is thrown as an `AiBddError` whose `cause` is the original error.

| Situation | Code |
|---|---|
| Network, rate limit (429), 5xx, any other provider failure | `MODEL_UNAVAILABLE` (retryable) |
| Missing API key, unknown model id, unsafe or unverifiable free pricing, unsupported feature, bad request shape | `MODEL_UNAVAILABLE`, `retryable: false` |
| Unparsable or schema-invalid structured output, invalid tool-call arguments, unknown tool, no tool call when `toolChoice: 'required'` | `MODEL_OUTPUT_INVALID` |
| Aborted via `signal` | `ABORTED` |
