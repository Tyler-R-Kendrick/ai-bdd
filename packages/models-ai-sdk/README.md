# @ai-bdd/models-ai-sdk

Vercel AI SDK (`ai` v7) adapter for ai-bdd. It turns AI SDK language models into the four `ChatModel`s an ai-bdd engine needs (`extract`, `act`, `checkgen`, `judge`).

`ai` is a peer dependency. Install the provider package you want (for example `@ai-sdk/anthropic`) yourself.

## API

### `aiSdkModels(models, opts?) -> ModelSet`

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { aiSdkModels } from '@ai-bdd/models-ai-sdk';

const models = aiSdkModels(
  {
    extract: anthropic('claude-sonnet-5-5'),
    act: anthropic('claude-sonnet-5-5'),
    checkgen: anthropic('claude-sonnet-5-5'),
    judge: 'anthropic/claude-opus-5', // strings use the AI SDK's global provider resolution
  },
  { maxRetries: 2 }, // passed straight to the AI SDK; its default applies when omitted
);
```

Each value is an AI SDK `LanguageModel` object or a model id string. Strings are handed to the AI SDK unchanged.

### `createModelSet(options) -> ModelSet`

The JSON-config form, used by `{"models": {"use": "@ai-bdd/models-ai-sdk", "options": {...}}}`:

```json
{ "extract": "anthropic/claude-sonnet-5.5", "act": "...", "checkgen": "...", "judge": "...", "maxRetries": 2 }
```

All four purposes are required non-empty strings. Unknown keys and invalid values throw `CONFIG_INVALID`.

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
| Missing API key, unknown model id, unsupported feature, bad request shape | `MODEL_UNAVAILABLE`, `retryable: false` |
| Unparsable or schema-invalid structured output, invalid tool-call arguments, unknown tool, no tool call when `toolChoice: 'required'` | `MODEL_OUTPUT_INVALID` |
| Aborted via `signal` | `ABORTED` |
