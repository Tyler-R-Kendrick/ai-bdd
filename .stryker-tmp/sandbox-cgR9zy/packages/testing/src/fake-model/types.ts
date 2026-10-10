// @ts-nocheck
import type { JsonObject, JsonValue, ModelPurpose } from '@ai-bdd/sdk/contracts';

/** Matcher for one dotted path of the request `context`. A bare string means "equals". */
export type FakeMatcher = string | { contains: string } | { notContains: string } | { in: string[] };

/** A UI element a scripted action refers to; resolved to a `ref` through `context.nodes`. */
export type FakeTarget = { role: string; name?: string; within?: string };

/** One scripted act turn. `args.target` (if any) is resolved to `args.ref`. */
export type FakeScriptStep = { tool: string; args?: JsonObject };

export type FakeRespond =
  | { object: JsonValue }
  | { text: string }
  | { script: FakeScriptStep[] }
  | { samples: JsonValue[] }
  | { byAttempt: FakeRespond[] };

export type FakeRule = {
  id: string;
  description?: string;
  purpose: ModelPurpose;
  when?: { [path: string]: FakeMatcher };
  respond: FakeRespond;
};

export type FakeRuleFile = { rules: FakeRule[] };

/** Loosely typed rule file, e.g. straight from `JSON.parse`; validated at runtime. */
export type FakeRuleFileInput = { rules: JsonObject[] };

/** One recorded model call (request as logged, images replaced by their sha256). */
export type FakeCall = {
  purpose: string;
  request: JsonObject;
  response: JsonObject;
  /** Id of the rule that produced the response. */
  ruleId?: string;
};

export type FakeModelOptions = {
  rules?: ReadonlyArray<FakeRuleFile | FakeRuleFileInput>;
  rulesDir?: string;
  logPath?: string;
};
