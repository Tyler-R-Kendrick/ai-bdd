import { notImplemented, type JsonObject, type ModelSet } from '@ai-bdd/sdk/contracts';
export interface FakeRuleFile { rules: JsonObject[] }
export interface FakeCall { purpose: string; request: JsonObject; response: JsonObject }
export function createFakeModels(_opts: { rules?: FakeRuleFile[]; rulesDir?: string; logPath?: string }): ModelSet & { calls: FakeCall[] } {
  return notImplemented('testing.createFakeModels');
}
