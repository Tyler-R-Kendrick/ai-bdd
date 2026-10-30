import { describe, it, expect } from 'vitest';
import {
  emptyRemoteRuns,
  emptyRemoteStream,
  mergeRemoteRuns,
  displayRemoteStages,
  remoteIncomingSchema,
  remoteQuestionInputSchema,
  type RemoteRun,
} from '../shared/remote-agent.ts';
import {
  applyRemotePart,
  declaredRemoteTools,
  redactRemoteError,
} from '../shared/remote-stream.ts';
describe('typed remote agent events and materialized display state', () => {
  it('renders deep and cyclic stage graphs in linear work while preserving completed outcomes', () => {
    const base: RemoteRun = {
      id: 'deep',
      name: 'Deep bounded report',
      status: 'running',
      started: 0,
      updated: 0,
      waiting: 0,
      stages: Array.from({ length: 8000 }, (_, index) => ({
        id: 's' + index,
        name: 'Stage',
        status: 'pending' as const,
        parentIds: index ? ['s' + (index - 1)] : [],
      })),
    };
    expect(displayRemoteStages(base).at(-1)?.status).toBe('pending');
    base.stages[0].status = 'blocked';
    base.stages[4000].status = 'completed';
    base.stages[0].parentIds = ['s7999'];
    const view = displayRemoteStages(base);
    expect(view[4000].status).toBe('completed');
    expect(view[7999].status).toBe('stopped');
    expect(base.stages[7999].status).toBe('pending');
  });
  it('enforces stream order, preserves text and usage, and never accepts remote impersonation of host tools', () => {
    let state = applyRemotePart(emptyRemoteStream(), {
      type: 'stream-start',
      modelId: 'operator-reported',
    });
    state = applyRemotePart(state, { type: 'text-start', id: 'answer' });
    state = applyRemotePart(state, {
      type: 'text-delta',
      id: 'answer',
      delta: 'A real incremental response.',
    });
    state = applyRemotePart(state, { type: 'text-end', id: 'answer' });
    expect(state.blocks[0]).toMatchObject({
      text: 'A real incremental response.',
      ended: true,
    });
    expect(() =>
      applyRemotePart(state, {
        type: 'text-delta',
        id: 'answer',
        delta: 'late',
      }),
    ).toThrow('open');
    expect(() => declaredRemoteTools(state, ['repository_file'])).toThrow(
      'impersonate',
    );
    state = declaredRemoteTools(state, ['local_inspection']);
    state = applyRemotePart(state, {
      type: 'tool-call',
      toolCallId: 'own1',
      toolName: 'local_inspection',
      input: { path: 'src.ts' },
      providerExecuted: true,
    });
    expect(() =>
      applyRemotePart(state, {
        type: 'tool-call',
        toolCallId: 'own1',
        toolName: 'local_inspection',
        input: {},
        providerExecuted: true,
      }),
    ).toThrow('duplicated');
    expect(() =>
      applyRemotePart(state, {
        type: 'tool-result',
        toolCallId: 'own1',
        toolName: 'repository_file',
        result: {},
      }),
    ).toThrow('matching');
    state = applyRemotePart(state, {
      type: 'tool-result',
      toolCallId: 'own1',
      toolName: 'local_inspection',
      result: {
        error: {
          code: 'unauthorized',
          message: 'Authorization: Bearer ghp_aReallyPrivateFixtureToken123456',
        },
      },
      isError: true,
    });
    expect(JSON.stringify(state)).not.toContain('ghp_');
    expect(state.calls[0]).toMatchObject({
      source: 'remote',
      status: 'failed',
    });
    state = applyRemotePart(state, {
      type: 'finish',
      finishReason: { unified: 'stop' },
      totalUsage: { inputTokens: { total: 4 }, outputTokens: { total: 7 } },
    });
    expect(state.usage?.outputTokens?.total).toBe(7);
  });
  it('negotiates delta cards, preserves stages across reconnect reports, and stops unfinished descendants only', () => {
    const base: RemoteRun = {
      id: 'run',
      name: 'Inspect the boundary',
      status: 'running',
      started: 1,
      updated: 2,
      waiting: 0,
      stages: [
        { id: 'parent', name: 'Inspect', status: 'running' },
        {
          id: 'done',
          name: 'Done',
          parentIds: ['parent'],
          status: 'completed',
        },
      ],
    };
    let state = mergeRemoteRuns(
      emptyRemoteRuns(),
      { cards: [base], active: ['run'], paused: [] },
      false,
    );
    const delta = {
      ...base,
      stagesDelta: true as const,
      stages: [
        { id: 'parent', name: 'Inspect', status: 'failed' as const },
        {
          id: 'child',
          name: 'Later step',
          status: 'running' as const,
          parentIds: ['parent'],
        },
      ],
    };
    expect(() =>
      mergeRemoteRuns(
        state,
        { cards: [delta], active: ['run'], paused: [] },
        false,
      ),
    ).toThrow('negotiated');
    state = mergeRemoteRuns(
      state,
      { cards: [delta], active: ['run'], paused: [] },
      true,
    );
    expect(state.cards[0].stages).toHaveLength(3);
    expect(
      displayRemoteStages(state.cards[0]).find((stage) => stage.id === 'child')
        ?.status,
    ).toBe('stopped');
    expect(
      displayRemoteStages(state.cards[0]).find((stage) => stage.id === 'done')
        ?.status,
    ).toBe('completed');
    state = mergeRemoteRuns(
      state,
      {
        cards: [{ ...base, status: 'finished', ended: 3, stages: [] }],
        active: [],
        paused: [],
      },
      true,
    );
    expect(state.cards[0].stages).toHaveLength(3);
  });
  it('rejects unknown fields and invalid question choices without turning confirmations into authorization', () => {
    expect(
      remoteQuestionInputSchema.safeParse({
        method: 'confirm',
        title: 'Use this naming convention?',
        message: 'This guides the agent turn.',
        approve: true,
      }).success,
    ).toBe(false);
    expect(
      remoteQuestionInputSchema.safeParse({
        method: 'questionnaire',
        params: {
          questions: [
            {
              header: 'Pick',
              question: 'Pick a boundary',
              options: [
                { label: 'A', description: '' },
                { label: 'A', description: '' },
              ],
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      remoteIncomingSchema.safeParse({
        type: 'part',
        requestId: 'request',
        eventId: crypto.randomUUID(),
        part: {
          type: 'tool-call',
          toolCallId: 'id',
          toolName: 'anything',
          input: {},
          providerExecuted: false,
        },
      }).success,
    ).toBe(false);
  });
  it('masks credential assignments, token shapes and encoded URL credentials before persisting failed tool displays', () => {
    for (const text of [
      'HTTPS_PROXY=https://user:password@proxy.test',
      'Failed https://alice:hunter2@host.test',
      'Failed https://alice:hunter2%2540host.test',
      'Failed https://alice:hunter2\\u0040host.test',
      'token ghp_aReallyPrivateFixtureToken12345',
    ]) {
      const masked = redactRemoteError(text);
      expect(masked).toContain('[redacted]');
      expect(masked).not.toContain('hunter2');
      expect(masked).not.toContain('aReallyPrivate');
    }
  });
});
