import { z } from 'zod';

const nonNegInt = z.number().int().min(0);
const selector = z.object({
  role: z.string(),
  name: z.string(),
  testId: z.string().optional(),
  ancestors: z.array(z.object({ role: z.string(), name: z.string() })),
  index: nonNegInt,
  of: nonNegInt,
});
const valueSource = z.union([z.object({ literal: z.string() }), z.object({ param: z.string() }), z.object({ secret: z.string() })]);

const recordedAction = z.discriminatedUnion('verb', [
  z.object({ verb: z.literal('navigate'), url: z.string() }),
  z.object({ verb: z.literal('click'), target: selector }),
  z.object({ verb: z.literal('fill'), target: selector, value: valueSource }),
  z.object({ verb: z.literal('press'), key: z.string(), target: selector.optional() }),
  z.object({ verb: z.literal('select'), target: selector, option: valueSource }),
  z.object({ verb: z.literal('check'), target: selector, checked: z.boolean() }),
  z.object({ verb: z.literal('hover'), target: selector }),
  z.object({ verb: z.literal('scroll'), direction: z.enum(['up', 'down']), target: selector.optional() }),
  z.object({ verb: z.literal('back') }),
  z.object({ verb: z.literal('wait'), ms: nonNegInt }),
]);

const nodeKey = z.object({ role: z.string(), name: z.string() });
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const effect = z.object({
  routeBefore: z.string(),
  routeAfter: z.string(),
  appeared: z.array(nodeKey),
  disappeared: z.array(nodeKey),
  changed: z.array(z.object({ key: nodeKey, state: z.string(), from: z.json(), to: z.json() })),
});

const actProgram = z.object({ startRoute: z.string(), startLandmarks: sha256, actions: z.array(recordedAction), effect });

const nodeQuery = z.object({
  role: z.string().optional(),
  name: z.string().optional(),
  nameMatch: z.enum(['exact', 'contains']).optional(),
  testId: z.string().optional(),
  within: nodeKey.optional(),
});
const textValue = z.union([z.object({ literal: z.string() }), z.object({ param: z.string() })]);
const nodeStateName = z.enum(['checked', 'disabled', 'expanded', 'selected', 'pressed', 'focused', 'busy', 'invalid']);
const predicate = z.discriminatedUnion('op', [
  z.object({ op: z.literal('exists'), query: nodeQuery, negate: z.boolean().optional() }),
  z.object({ op: z.literal('count'), query: nodeQuery, cmp: z.enum(['eq', 'gte', 'lte']), value: z.number() }),
  z.object({ op: z.literal('text'), query: nodeQuery, match: z.enum(['equals', 'contains']), value: textValue }),
  z.object({ op: z.literal('state'), query: nodeQuery, state: nodeStateName, value: z.boolean() }),
  z.object({ op: z.literal('route'), match: z.enum(['equals', 'prefix']), value: z.string() }),
]);

const checkProgram = z.object({
  classification: z.enum(['change', 'invariant']),
  predicates: z.array(predicate),
  generatedBy: z.object({ modelId: z.string(), promptVersion: z.string() }),
  verified: z.object({ afterTrue: z.boolean(), probeTrue: z.boolean(), beforeFalse: z.boolean().nullable(), judgePassed: z.boolean() }),
});

const fuzzyReason = z.enum([
  'directive', 'subjective', 'volatile-content', 'check-not-discriminative', 'check-generation-failed',
  'confirm-replay-failed', 'confirm-check-failed', 'coordinate-action', 'no-observable-effect', 'heal-threshold', 'agent-only-driver',
]);

const stepRecording = z.object({
  stepKey: z.string(),
  stepTextHash: sha256,
  kind: z.enum(['given', 'when', 'then']),
  determinism: z.enum(['deterministic', 'fuzzy']),
  fuzzyReasons: z.array(fuzzyReason),
  act: actProgram.optional(),
  check: checkProgram.optional(),
  stats: z.object({ healCount: nonNegInt }),
});

export const ScenarioRecordingSchema = z.object({
  schemaVersion: z.literal(1),
  scenarioId: z.string(),
  scenarioFingerprint: sha256,
  driver: z.object({ id: z.string(), major: nonNegInt }),
  steps: z.array(stepRecording),
  promptVersions: z.object({ act: z.string(), checkgen: z.string(), judge: z.string() }),
});
