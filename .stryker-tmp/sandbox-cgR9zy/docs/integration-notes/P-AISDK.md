# P-AISDK integration note

## VERIFY V5 (AI SDK v7 names) - confirmed against ai@7.0.137

All names in SPEC section 12.1 exist unchanged, with these adaptations:

| Spec | Installed `ai@7.0.137` |
|---|---|
| `generateText` | present. `system` is still accepted but `instructions` is the current name, so the adapter uses `instructions`. |
| `Output.object({schema})`, `jsonSchema`, `tool({description, inputSchema})` | present as specified. A `tool()` without `execute` makes `generateText` return the calls (default `stopWhen` is one step, so `stopWhen` is not needed). |
| image part `{type:'file', mediaType:'image/png', data}` | present. A bare `Uint8Array` is accepted; the mock model sees `data: {type: 'data', data}`. |
| `result.toolCalls[].{toolCallId,toolName,input}`, `result.output`, `result.usage.{inputTokens,outputTokens}` | present. `usage.*Tokens` are `number \| undefined`. `finishReason` also includes `content-filter`, mapped to `other`. |
| Mock model in `ai/test` | `MockLanguageModelV4` (also `MockLanguageModelV3`/`V2`, `MockProviderV4`). Its `doGenerateCalls` records the provider-level call. Usage is `{inputTokens: {total,...}, outputTokens: {total,...}}` and finish reason `{unified, raw}`. |
| Tool results | `{role:'tool', content:[{type:'tool-result', toolCallId, toolName, output: {type:'json', value}}]}` |

Behaviours worth knowing (all covered by tests):

- `result.output` throws `NoOutputGeneratedError` when the model returned tool calls instead of text, so the adapter only reads it when there are no tool calls.
- With `toolChoice: 'required'`, a model that answers with plain text makes the AI SDK throw `ToolChoiceViolationError`. The adapter maps it to `MODEL_OUTPUT_INVALID`, so S-AGENT will see this as an error from `generate`, not as a response with zero tool calls. If the actor wants an "empty turn" it should use `toolChoice: 'auto'` (or catch `MODEL_OUTPUT_INVALID`).
- Tool calls the SDK marks `invalid` (unparsable JSON arguments, unknown tool name) and tool calls whose input is not a JSON object are mapped to `MODEL_OUTPUT_INVALID`. No schema validation of tool arguments or structured output happens in the adapter (`jsonSchema` without `validate`); consumers validate with zod.
- `RetryError` (retries exhausted) is unwrapped to classify by its last error.
- `ABORTED` is used when the request `signal` is aborted. The AI SDK does not check an already-aborted signal before calling the model, so a pre-aborted signal only surfaces if the provider honours it.
- `ModelResponse.modelId` and `ChatModel.id` are the model object's `modelId`, or the string as given (not prefixed with the provider).

## Dependencies / contracts

No dependency or contract changes needed. `ai` is imported only from `packages/models-ai-sdk/src`; the test mock comes from `ai/test`.
