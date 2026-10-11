import type { JsonObject, ModelMessage, ModelPurpose, ModelRequest } from '@ai-bdd/sdk/contracts';

export function req(purpose: ModelPurpose, context: JsonObject, extra: Partial<ModelRequest> = {}): ModelRequest {
  return {
    purpose,
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] satisfies ModelMessage[],
    context,
    ...extra,
  };
}

export const NODES = [
  { ref: 'e1', role: 'navigation', name: 'Primary', ancestors: [] },
  { ref: 'e2', role: 'button', name: 'Submit', ancestors: ['Shipping'] },
  { ref: 'e3', role: 'button', name: 'Submit', ancestors: ['Billing address'] },
  { ref: 'e4', role: 'button', name: 'Upgrade to Pro', ancestors: ['Plan'] },
  { ref: 'e5', role: 'textbox', name: 'Street', ancestors: ['Billing address'] },
];
