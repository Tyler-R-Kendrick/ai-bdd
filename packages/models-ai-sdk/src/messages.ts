import type { ModelMessage as AiMessage } from 'ai';
import type { ContentPart, ModelMessage } from '@ai-bdd/sdk/contracts';

type UserPart = { type: 'text'; text: string } | { type: 'file'; mediaType: string; data: Uint8Array };

function toParts(parts: ContentPart[]): UserPart[] {
  const out: UserPart[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text.length > 0) out.push({ type: 'text', text: part.text });
    } else {
      out.push({ type: 'file', mediaType: 'image/png', data: part.png });
    }
  }
  return out;
}

/** Maps ai-bdd messages to AI SDK model messages. Tool messages become `tool-result` parts. */
export function toAiMessages(messages: ModelMessage[]): AiMessage[] {
  const out: AiMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: toParts(m.content) });
    } else if (m.role === 'assistant') {
      const content: Array<
        UserPart | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      > = toParts(m.content);
      for (const call of m.toolCalls ?? []) {
        content.push({ type: 'tool-call', toolCallId: call.id, toolName: call.name, input: call.args });
      }
      if (content.length === 0) continue;
      out.push({ role: 'assistant', content } as AiMessage);
    } else {
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.toolCallId,
            toolName: m.toolName,
            output: { type: 'json', value: m.result },
          },
        ],
      });
    }
  }
  return out;
}
