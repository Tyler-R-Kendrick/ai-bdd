import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunEvent, RunReport } from '@ai-bdd/contracts';
import { createReporters, evidenceIndex } from '../../src/index.js';

function report(): RunReport {
  return {
    runId: 'run-1',
    version: '0.1.0',
    startedAt: '2026-10-09T00:00:00.000Z',
    finishedAt: '2026-10-09T00:00:05.000Z',
    status: 'healed',
    driver: 'fake',
    stats: {
      scenarios: 2,
      passed: 1,
      failed: 0,
      healed: 1,
      skipped: 0,
      steps: 3,
      judgeOnly: 1,
      semanticResolutions: 1,
      actReplays: 1,
      heals: 1,
      modelCalls: 4,
    },
    cost: { calls: 4, inputTokens: 100, outputTokens: 20, byPurpose: {}, estimatedUsd: 0 },
    lock: { added: 1, changed: 0, revalidated: 0, unchanged: 2, ambiguous: 0 },
    diagnostics: [],
    exitCode: 0,
    frozen: false,
    strictCache: false,
    runDir: '.ai-bdd/runs/run-1',
    rootHash: 'a'.repeat(64),
    scenarios: [
      {
        scenarioId: 's1',
        name: 'Member upgrades to Pro',
        specName: 'Workspace billing',
        uri: 'fixtures/specs/billing.spec.md',
        tags: ['billing'],
        status: 'healed',
        steps: [
          {
            stepId: 's1#0',
            text: 'Upgrade the workspace to the Pro plan',
            kind: 'action',
            kindSource: 'default',
            status: 'healed',
            resolution: { type: 'agent', mode: 'act', reason: 'no-match' },
            cache: { mode: 'healed' },
            healing: { reason: 'selector missing', replayedActions: 1, totalActions: 2 },
            evidence: [{ evidenceId: 'ev-1', kind: 'observation', sha256: 'b'.repeat(64), path: 'artifacts/bb.json' }],
            durationMs: 40,
          },
        ],
        durationMs: 100,
        traceId: 'trace-1',
        driver: 'fake',
      },
      {
        scenarioId: 's2',
        name: 'Downgrade is blocked',
        specName: 'Workspace billing',
        uri: 'fixtures/specs/billing.spec.md',
        tags: [],
        status: 'failed',
        steps: [
          {
            stepId: 's2#0',
            text: 'A message explains that unpaid invoices must be settled first',
            kind: 'assertion',
            kindSource: 'keyword',
            status: 'failed',
            resolution: { type: 'agent', mode: 'assert', reason: 'no-match' },
            check: { status: 'passed', results: [], judgeOnly: true },
            judge: {
              score: 0.5,
              verdict: 'inconclusive',
              samples: [],
              spread: 0.1,
              modelId: 'fake:judge',
              promptVersion: 'judge-1',
              cacheKey: 'k',
              reused: false,
            },
            evidence: [],
            durationMs: 20,
            error: { code: 'JUDGE_INCONCLUSIVE', message: 'the score 0.5 is between the thresholds', retryable: false },
          },
        ],
        durationMs: 30,
      },
    ],
  };
}

const events: RunEvent[] = [
  { type: 'run:start', runId: 'run-1', at: '2026-10-09T00:00:00.000Z', specs: ['fixtures/specs'], driver: 'fake' },
  { type: 'scenario:end', scenarioId: 's1', result: report().scenarios[0]!, at: '2026-10-09T00:00:01.000Z' },
  { type: 'run:end', runId: 'run-1', exitCode: 0, at: '2026-10-09T00:00:05.000Z' },
];

describe('reporters', () => {
  it('writes JSON, JUnit, markdown and Cucumber Messages', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'aibdd-rep-'));
    const reporters = createReporters(['json', 'junit', 'markdown', 'cucumber-messages'], { outDir, evidenceRunDir: '.ai-bdd/runs/run-1' });
    for (const reporter of reporters) for (const event of events) reporter.onEvent(event);
    const files: string[] = [];
    for (const reporter of reporters) files.push(...(await reporter.finish(report())).files);
    expect(files).toHaveLength(4);

    const json = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8')) as RunReport;
    expect(json.runId).toBe('run-1');

    const junit = readFileSync(join(outDir, 'junit.xml'), 'utf8');
    expect(junit).toContain('<testsuites');
    expect(junit).toContain('ai-bdd/healed');
    expect(junit).toContain('JUDGE_INCONCLUSIVE');

    const markdown = readFileSync(join(outDir, 'summary.md'), 'utf8');
    expect(markdown).toContain('# ai-bdd run summary');
    expect(markdown).toContain('Healed scenarios');
    expect(markdown).toContain('Failures');
    expect(markdown).toContain('judge-only assertions: 1');

    const messages = readFileSync(join(outDir, 'messages.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const statuses = messages.filter((entry) => entry.testStepFinished).map((entry) => entry.testStepFinished.testStepResult.status);
    expect(statuses).toEqual(['PASSED', 'FAILED']);
    const healedAttachment = messages.find((entry) => entry.attachment?.body === 'ai-bdd/healed');
    expect(healedAttachment).toBeDefined();
    const evidenceAttachment = messages.find((entry) => entry.attachment?.body === 'ai-bdd/evidence');
    expect(evidenceAttachment?.attachment.url).toBe('artifacts/bb.json');
  });

  it('indexes evidence by reference', () => {
    const index = evidenceIndex(report(), '.');
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({ id: 'ev-1', mediaType: 'application/json' });
    expect(index[0]?.sha256).toBe('b'.repeat(64));
  });

  it('produces byte-identical output for the same report', async () => {
    const first = mkdtempSync(join(tmpdir(), 'aibdd-rep-a-'));
    const second = mkdtempSync(join(tmpdir(), 'aibdd-rep-b-'));
    for (const dir of [first, second]) {
      const reporters = createReporters(['json', 'junit', 'markdown'], { outDir: dir, evidenceRunDir: '.ai-bdd/runs/run-1' });
      for (const reporter of reporters) await reporter.finish(report());
    }
    for (const name of ['report.json', 'junit.xml', 'summary.md']) {
      const version = readFileSync(join(first, name), 'utf8');
      const other = readFileSync(join(second, name), 'utf8');
      expect(other).toBe(version);
    }
  });
});
