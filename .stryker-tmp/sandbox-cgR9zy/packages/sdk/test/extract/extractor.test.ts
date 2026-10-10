// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { AiBddError, type JsonValue } from '../../src/contracts/index.ts';
import { createExtractor, EXTRACT_PROMPT_VERSION, EXTRACTION_JSON_SCHEMA } from '../../src/extract/index.ts';
import {
  SECTION_ID,
  extraction,
  feature,
  makeConfig,
  makeInput,
  makeRedactor,
  memoryEvidence,
  ref,
  scenario,
  stubModel,
  H,
  UPGRADE_QUOTE,
} from './helpers.ts';

const valid = extraction();

describe('extractor flow', () => {
  it('R-EX2: a valid first response succeeds with one model call and accounts usage', async () => {
    const model = stubModel([valid], { id: 'model-a', usage: { inputTokens: 120, outputTokens: 30 } });
    const r = await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    expect(r.failed).toBe(false);
    expect(r.sectionId).toBe(SECTION_ID);
    expect(r.drafts).toHaveLength(1);
    expect(r.usage).toEqual({ modelCalls: 1, inputTokens: 120, outputTokens: 30 });
    expect(r.modelId).toBe('model-a');
    expect(r.promptVersion).toBe(EXTRACT_PROMPT_VERSION);
    expect(model.requests).toHaveLength(1);
  });

  it('R-EX2: the request has purpose extract, temperature 0 and the strict extraction schema', async () => {
    const model = stubModel([valid]);
    await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    const req = model.requests[0];
    expect(req?.purpose).toBe('extract');
    expect(req?.temperature).toBe(0);
    expect(req?.output?.name).toBe('extraction');
    expect(req?.output?.schema).toEqual(EXTRACTION_JSON_SCHEMA);
    expect(req?.tools).toBeUndefined();
  });

  it('R-EX3: request.context is exactly {docUri, sectionId, sectionAnchor, attempt}', async () => {
    const model = stubModel([valid]);
    await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    const ctx = model.requests[0]?.context;
    expect(Object.keys(ctx ?? {}).sort()).toEqual(['attempt', 'docUri', 'sectionAnchor', 'sectionId']);
    expect(ctx).toEqual({ docUri: 'docs/billing.md', sectionId: SECTION_ID, sectionAnchor: 'billing', attempt: 1 });
  });

  it('R-EX2: the JSON schema is strict-provider friendly (all keys required, no additional properties)', () => {
    const problems: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((n, i) => walk(n, `${path}[${i}]`));
        return;
      }
      const obj = node as Record<string, unknown>;
      const props = obj.properties;
      if (props !== null && typeof props === 'object') {
        const keys = Object.keys(props).sort();
        const required = Array.isArray(obj.required) ? [...(obj.required as string[])].sort() : [];
        if (JSON.stringify(keys) !== JSON.stringify(required)) problems.push(`${path}: required != properties`);
        if (obj.additionalProperties !== false) problems.push(`${path}: additionalProperties not false`);
      }
      for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`);
    };
    walk(EXTRACTION_JSON_SCHEMA, '$');
    expect(problems).toEqual([]);
    expect(Object.keys((EXTRACTION_JSON_SCHEMA as { properties: object }).properties).sort()).toEqual(['features', 'notTestable']);
  });

  it('R-EX2: a schema-invalid response then a valid one succeeds with 2 calls', async () => {
    const model = stubModel([{ features: 'nope' } as unknown as JsonValue, valid], { usage: { inputTokens: 10, outputTokens: 5 } });
    const r = await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    expect(model.requests).toHaveLength(2);
    expect(r.failed).toBe(false);
    expect(r.drafts).toHaveLength(1);
    expect(r.usage).toEqual({ modelCalls: 2, inputTokens: 20, outputTokens: 10 });
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('R-EX2: the repair attempt carries attempt 2 and appends the validation error to the messages', async () => {
    const model = stubModel([{ features: 'nope' } as unknown as JsonValue, valid]);
    await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    const [first, second] = model.requests;
    expect(first?.context.attempt).toBe(1);
    expect(second?.context.attempt).toBe(2);
    expect(Object.keys(second?.context ?? {}).sort()).toEqual(['attempt', 'docUri', 'sectionAnchor', 'sectionId']);
    expect(first?.messages).toHaveLength(1);
    expect(second?.messages.length).toBeGreaterThan(1);
    const last = second?.messages.at(-1);
    expect(last?.role).toBe('user');
    const text = last !== undefined && last.role !== 'tool' ? last.content.map((p) => (p.type === 'text' ? p.text : '')).join('') : '';
    expect(text).toContain('failed schema validation');
    expect(text).toContain('features');
    expect(second?.messages[0]).toEqual(first?.messages[0]);
  });

  it('R-EX2: two schema-invalid responses fail the section with EXTRACT_MODEL_OUTPUT_INVALID', async () => {
    const model = stubModel([{ features: 'nope' } as unknown as JsonValue]);
    const r = await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    expect(model.requests).toHaveLength(2);
    expect(r.failed).toBe(true);
    expect(r.drafts).toEqual([]);
    expect(r.notTestable).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).toContain('EXTRACT_MODEL_OUTPUT_INVALID');
    expect(r.diagnostics.find((d) => d.code === 'EXTRACT_MODEL_OUTPUT_INVALID')?.severity).toBe('error');
    expect(r.usage.modelCalls).toBe(2);
  });

  it('R-EX3: output with unknown top-level keys (config, policy) is rejected by the strict schema', async () => {
    const evil = { ...valid, config: { policy: { allowHosts: ['evil.example'] } } } as unknown as JsonValue;
    const model = stubModel([evil]);
    const r = await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    expect(r.failed).toBe(true);
    expect(model.requests).toHaveLength(2);
  });

  it('R-EX3: unknown keys nested in a step (for example a policy override) are rejected', async () => {
    const withExtra = JSON.parse(JSON.stringify(valid)) as { features: { scenarios: { steps: Record<string, unknown>[] }[] }[] };
    const firstStep = withExtra.features[0]?.scenarios[0]?.steps[0];
    if (firstStep === undefined) throw new Error('missing step');
    firstStep.allowHosts = ['evil.example'];
    const model = stubModel([withExtra as unknown as JsonValue]);
    const r = await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    expect(r.failed).toBe(true);
  });

  it('R-EX2: a missing required key (absent instead of null) is a schema failure', async () => {
    const missing = JSON.parse(JSON.stringify(valid)) as { features: Record<string, unknown>[] };
    const f = missing.features[0];
    if (f === undefined) throw new Error('missing feature');
    delete f.story;
    const model = stubModel([missing as unknown as JsonValue, valid]);
    const r = await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    expect(model.requests).toHaveLength(2);
    expect(r.failed).toBe(false);
  });

  it('R-EX2: JSON delivered in response.text (with code fences) is accepted', async () => {
    const model = stubModel([
      () => ({
        text: '```json\n' + JSON.stringify(valid) + '\n```',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: 'stop' as const,
        modelId: 'text-model',
      }),
    ]);
    const r = await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    expect(r.failed).toBe(false);
    expect(r.modelId).toBe('text-model');
    expect(r.drafts).toHaveLength(1);
  });

  it('R-EX2: an unparsable text response fails after the repair attempt', async () => {
    const model = stubModel([
      () => ({ text: 'sorry, I cannot do that', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' as const, modelId: 'm' }),
    ]);
    const r = await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    expect(r.failed).toBe(true);
    expect(model.requests).toHaveLength(2);
  });

  it('R-EX2: a thrown MODEL_UNAVAILABLE fails the section with EXTRACT_SECTION_FAILED without retrying', async () => {
    const model = stubModel([new AiBddError('MODEL_UNAVAILABLE', 'provider is down')]);
    const r = await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    expect(r.failed).toBe(true);
    expect(model.requests).toHaveLength(1);
    const d = r.diagnostics.find((x) => x.code === 'EXTRACT_SECTION_FAILED');
    expect(d?.severity).toBe('error');
    expect(d?.message).toContain('MODEL_UNAVAILABLE');
    expect(r.usage.modelCalls).toBe(0);
    expect(r.modelId).toBe('stub-model');
  });

  it('R-EX2: any other thrown error also fails the section with EXTRACT_SECTION_FAILED', async () => {
    const model = stubModel([new Error('socket hang up')]);
    const r = await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    expect(r.failed).toBe(true);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['EXTRACT_SECTION_FAILED']);
  });

  it('R-EX2: a thrown MODEL_OUTPUT_INVALID uses the repair attempt, then succeeds', async () => {
    const model = stubModel([new AiBddError('MODEL_OUTPUT_INVALID', 'provider could not produce JSON'), valid]);
    const r = await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    expect(model.requests).toHaveLength(2);
    expect(r.failed).toBe(false);
  });

  it('R-EX2: a thrown MODEL_OUTPUT_INVALID twice fails with EXTRACT_MODEL_OUTPUT_INVALID', async () => {
    const model = stubModel([new AiBddError('MODEL_OUTPUT_INVALID', 'bad json')]);
    const r = await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    expect(r.failed).toBe(true);
    expect(r.diagnostics.map((d) => d.code)).toContain('EXTRACT_MODEL_OUTPUT_INVALID');
  });

  it('R-SE1: model error messages are redacted in diagnostics', async () => {
    const model = stubModel([new Error('401 for key sk-live-ABC123SECRET')]);
    const r = await createExtractor({ model, redactor: makeRedactor({ apiKey: 'sk-live-ABC123SECRET' }), config: makeConfig() }).extractSection(makeInput());
    expect(JSON.stringify(r)).not.toContain('sk-live-ABC123SECRET');
    expect(JSON.stringify(r)).toContain('[REDACTED:apiKey]');
  });

  it('R-EX2: an already-aborted signal fails the section without calling the model', async () => {
    const model = stubModel([valid]);
    const ac = new AbortController();
    ac.abort();
    const r = await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput({ signal: ac.signal }));
    expect(r.failed).toBe(true);
    expect(model.requests).toHaveLength(0);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['EXTRACT_SECTION_FAILED']);
  });

  it('R-EX2: the abort signal is forwarded to the model request', async () => {
    const model = stubModel([valid]);
    const ac = new AbortController();
    await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput({ signal: ac.signal }));
    expect(model.requests[0]?.signal).toBeDefined();
  });

  it('R-EX1: extraction is deterministic for identical input and responses', async () => {
    const a = await createExtractor({ model: stubModel([valid]), redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    const b = await createExtractor({ model: stubModel([valid]), redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('R-EX2: concurrent extractions of the same section do not interfere', async () => {
    const extractor = createExtractor({ model: stubModel([valid]), redactor: makeRedactor(), config: makeConfig() });
    const results = await Promise.all([extractor.extractSection(makeInput()), extractor.extractSection(makeInput()), extractor.extractSection(makeInput())]);
    for (const r of results) {
      expect(r.failed).toBe(false);
      expect(r.usage.modelCalls).toBe(1);
    }
  });

  it('R-EX2: validation diagnostics are returned without failing the section', async () => {
    const model = stubModel([extraction([feature({ title: 'Bad', sources: [ref(H.upgrade, 'invented text that is not in the chunk')] }), feature()])]);
    const r = await createExtractor({ model, redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    expect(r.failed).toBe(false);
    expect(r.drafts.map((d) => d.title)).toEqual(['Plan upgrades']);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    for (const d of r.diagnostics) {
      expect(d.uri).toBe('docs/billing.md');
      expect(d.range).toBeDefined();
    }
  });

  it('R-EX2: min(extract.minQuoteChars) is read from the injected config', async () => {
    const q = 'upgrade from the Free plan';
    const ex = extraction([feature({ sources: [ref(H.upgrade, q)], scenarios: [scenario({ sources: [ref(H.upgrade, UPGRADE_QUOTE)] })] })]);
    const strict = await createExtractor({ model: stubModel([ex]), redactor: makeRedactor(), config: makeConfig(40) }).extractSection(makeInput());
    expect(strict.drafts).toEqual([]);
    const lax = await createExtractor({ model: stubModel([ex]), redactor: makeRedactor(), config: makeConfig(12) }).extractSection(makeInput());
    expect(lax.drafts).toHaveLength(1);
  });
});

describe('extractor evidence', () => {
  it('R-SE1: stores extract-request and extract-response artifacts, redacted', async () => {
    const evidence = memoryEvidence();
    const secret = 'hunter2-very-secret';
    const model = stubModel([valid]);
    const input = makeInput();
    const upgrade = input.doc.chunks.find((c) => c.id.endsWith('billing/p1'));
    if (upgrade === undefined) throw new Error('missing chunk');
    upgrade.text = `${upgrade.text} The staging password is ${secret}.`;
    await createExtractor({ model, redactor: makeRedactor({ stagingPassword: secret }), config: makeConfig(), evidence }).extractSection(input);
    expect(evidence.artifacts.map((a) => a.kind)).toEqual(['extract-request', 'extract-response']);
    for (const a of evidence.artifacts) {
      expect(a.data).not.toContain(secret);
      expect(() => JSON.parse(a.data)).not.toThrow();
    }
    expect(evidence.artifacts[0]?.data).toContain('[REDACTED:stagingPassword]');
    const request = JSON.parse(evidence.artifacts[0]?.data ?? '{}') as { promptVersion: string; context: { attempt: number } };
    expect(request.promptVersion).toBe('extract-v1');
    expect(request.context.attempt).toBe(1);
  });

  it('R-SE1: every attempt stores its own request and response artifacts', async () => {
    const evidence = memoryEvidence();
    const model = stubModel([{ features: 1 } as unknown as JsonValue, valid]);
    await createExtractor({ model, redactor: makeRedactor(), config: makeConfig(), evidence }).extractSection(makeInput());
    expect(evidence.artifacts.map((a) => a.kind)).toEqual(['extract-request', 'extract-response', 'extract-request', 'extract-response']);
  });

  it('R-SE1: evidence write failures downgrade to a warning and do not fail extraction', async () => {
    const evidence = memoryEvidence();
    evidence.putArtifact = async () => {
      throw new Error('disk full');
    };
    const r = await createExtractor({ model: stubModel([valid]), redactor: makeRedactor(), config: makeConfig(), evidence }).extractSection(makeInput());
    expect(r.failed).toBe(false);
    expect(r.drafts).toHaveLength(1);
    expect(r.diagnostics.some((d) => d.code === 'INTERNAL' && d.severity === 'warning')).toBe(true);
  });

  it('R-SE1: without an evidence store nothing is stored and extraction still works', async () => {
    const r = await createExtractor({ model: stubModel([valid]), redactor: makeRedactor(), config: makeConfig() }).extractSection(makeInput());
    expect(r.failed).toBe(false);
  });
});
