import { describe, expect, it } from 'vitest';
import { createJudge, toJudgeEvidence } from '../../src/judge/index.ts';
import { MemoryEvidence, ScriptedJudgeModel, SecretRedactor, holds, makeConfig, makeObservation, makeRequest, node, png } from './doubles.ts';

const redactor = new SecretRedactor('hunter2-secret');
const base = { vision: true, maxTreeChars: 20000, maskingProven: true, redactor };

describe('toJudgeEvidence', () => {
  it('R-JU1: tree text is rendered without refs', () => {
    const obs = makeObservation([node({ ref: 'e1', role: 'heading', name: 'Billing', level: 1 }), node({ ref: 'e2', role: 'button', name: 'Upgrade', depth: 1 })]);
    expect(obs.treeText).toContain('[ref=e1]');
    const ev = toJudgeEvidence(obs, base);
    expect(ev.treeText).not.toContain('ref=');
    expect(ev.treeText).toBe('- heading "Billing" [level=1]\n  - button "Upgrade"');
  });

  it('R-SE1: tree text is redacted before it reaches the judge', () => {
    const obs = makeObservation([node({ ref: 'e1', role: 'textbox', name: 'Password', value: 'hunter2-secret' })]);
    const ev = toJudgeEvidence(obs, base);
    expect(ev.treeText).not.toContain('hunter2-secret');
    expect(ev.treeText).toContain('<secret:pw>');
  });

  it('R-SE1: truncation happens after redaction and respects maxTreeChars', () => {
    const nodes = Array.from({ length: 200 }, (_, i) => node({ ref: `e${i}`, role: 'text', name: `row ${i} hunter2-secret` }));
    const obs = makeObservation(nodes);
    const ev = toJudgeEvidence(obs, { ...base, maxTreeChars: 500 });
    expect(ev.treeText.length).toBeLessThanOrEqual(500);
    expect(ev.treeText).toContain('[truncated]');
    expect(ev.treeText).not.toContain('hunter2');
    const full = toJudgeEvidence(obs, base);
    expect(full.treeText).not.toContain('[truncated]');
  });

  it('R-SE1: truncation never cuts a secret in half (partial secret cannot survive)', () => {
    const nodes = [node({ ref: 'e1', role: 'text', name: 'a'.repeat(30) + 'hunter2-secret' + 'b'.repeat(30) })];
    for (let max = 5; max < 120; max += 3) {
      const ev = toJudgeEvidence(makeObservation(nodes), { ...base, maxTreeChars: max });
      expect(ev.treeText.length).toBeLessThanOrEqual(max);
      expect(ev.treeText).not.toMatch(/hunter|unter2|ter2-|secret(?!:)/);
    }
  });

  const shot = png(7);
  const rows: { name: string; vision: boolean; screenshot: boolean; tainted: boolean; masked: boolean; proven: boolean; expected: boolean }[] = [
    { name: 'untainted, vision on', vision: true, screenshot: true, tainted: false, masked: false, proven: false, expected: true },
    { name: 'vision off', vision: false, screenshot: true, tainted: false, masked: false, proven: true, expected: false },
    { name: 'no screenshot', vision: true, screenshot: false, tainted: false, masked: false, proven: true, expected: false },
    { name: 'tainted, unmasked', vision: true, screenshot: true, tainted: true, masked: false, proven: true, expected: false },
    { name: 'tainted, masked but masking unproven', vision: true, screenshot: true, tainted: true, masked: true, proven: false, expected: false },
    { name: 'tainted, masked and proven', vision: true, screenshot: true, tainted: true, masked: true, proven: true, expected: true },
    { name: 'tainted, unmasked, unproven', vision: true, screenshot: true, tainted: true, masked: false, proven: false, expected: false },
  ];
  for (const r of rows) {
    it(`R-JU3: vision gating: ${r.name} -> screenshot ${r.expected ? 'sent' : 'withheld'}`, () => {
      const obs = makeObservation([node({ ref: 'e1', role: 'text', name: 'x' })], {
        tainted: r.tainted,
        ...(r.screenshot ? { screenshot: { ...shot, masked: r.masked } } : {}),
      });
      const ev = toJudgeEvidence(obs, { ...base, vision: r.vision, maskingProven: r.proven });
      if (r.expected) expect(ev.screenshot).toEqual(shot);
      else expect(ev.screenshot).toBeUndefined();
      expect('screenshot' in ev).toBe(r.expected);
    });
  }

  it('R-JU3: a withheld screenshot never reaches the model request', async () => {
    const tainted = makeObservation([node({ ref: 'e1', role: 'text', name: 'x' })], { tainted: true, screenshot: { ...shot, masked: false } });
    const ev = toJudgeEvidence(tainted, base);
    const model = new ScriptedJudgeModel('judge-model', [holds()]);
    await createJudge({ model, config: makeConfig(), cacheDir: null }).judge(makeRequest({ after: ev }));
    for (const r of model.requests) {
      for (const m of r.messages) if (m.role === 'user') expect(m.content.some((p) => p.type === 'image')).toBe(false);
    }
  });
});

describe('judge evidence artifacts', () => {
  it('judge-request and judge-response artifacts are stored per sample', async () => {
    const evidence = new MemoryEvidence();
    const model = new ScriptedJudgeModel('judge-model', [holds()]);
    await createJudge({ model, config: makeConfig(), cacheDir: null, evidence }).judge(makeRequest({ after: { treeText: '- text "x"', screenshot: png(3) } }));
    expect(evidence.artifacts.filter((a) => a.kind === 'judge-request').length).toBe(3);
    expect(evidence.artifacts.filter((a) => a.kind === 'judge-response').length).toBe(3);
    const reqJson = JSON.parse(evidence.artifacts.find((a) => a.kind === 'judge-request')?.data ?? '{}') as { messages: { content: { type: string }[] }[] };
    // image bytes are never inlined into evidence, only their hash
    expect(JSON.stringify(reqJson)).toContain('"type":"image"');
    expect(JSON.stringify(reqJson)).not.toContain('"png"');
  });

  it('cache hits store no new request artifacts', async () => {
    const evidence = new MemoryEvidence();
    const model = new ScriptedJudgeModel('judge-model', [holds()]);
    const dirless = createJudge({ model, config: makeConfig(), cacheDir: null, evidence });
    await dirless.judge(makeRequest());
    expect(evidence.artifacts.length).toBe(6);
  });
});
