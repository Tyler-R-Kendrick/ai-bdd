import { describe, it, expect } from 'vitest';
import { remoteFixture, until } from './remote-fixture.ts';
import { paragraph } from '../shared/domain.ts';
const event = (ws: any, requestId: string, value: Record<string, unknown>) => {
  const eventId = crypto.randomUUID();
  ws.send(JSON.stringify({ requestId, eventId, ...value }));
  return eventId;
};
async function turn(w: Awaited<ReturnType<typeof remoteFixture>>, client: any) {
  const run = await w.start();
  await until(() => client.frames.some((frame: any) => frame.type === 'turn'));
  return {
    ...run,
    requestId: client.frames.find((frame: any) => frame.type === 'turn')
      .requestId,
  };
}
const path = (w: any, id: string) =>
  `/api/artifacts/${w.artifact.id}/planner/requests/${id}`;
const complete = (ws: any, id: string) =>
  ws.send(
    JSON.stringify({
      type: 'result',
      requestId: id,
      output: {
        text: 'Actual remote test completed after browser input.',
        content: null,
      },
    }),
  );
describe('durable remote stream/question/run actions over actual WS and HTTP', () => {
  it('persists ordered incremental output, authenticates human answers, resumes after reconnect and publishes once', async () => {
    const w = await remoteFixture(),
      first = await w.connect(),
      run = await turn(w, first);
    event(first.ws, run.requestId, {
      type: 'part',
      part: { type: 'stream-start', modelId: 'fixture-reported' },
    });
    event(first.ws, run.requestId, {
      type: 'part',
      part: { type: 'text-start', id: 'text' },
    });
    const delta = {
        type: 'part',
        part: {
          type: 'text-delta',
          id: 'text',
          delta: 'Reviewing the captured artifact…',
        },
      },
      key = event(first.ws, run.requestId, delta);
    first.ws.send(
      JSON.stringify({ requestId: run.requestId, eventId: key, ...delta }),
    );
    event(first.ws, run.requestId, {
      type: 'input-request',
      questionId: 'confirmation',
      input: {
        method: 'confirm',
        title: 'Keep the existing integration boundary?',
        message:
          'This answer guides the current turn; it does not approve implementation.',
      },
    });
    await until(
      () =>
        first.frames.filter((frame: any) => frame.type === 'event-accepted')
          .length === 5,
    );
    const before = await w.request(path(w, run.requestId));
    expect(before.status).toBe(200);
    expect(before.value.stream.blocks[0].text).toBe(delta.part.delta);
    expect(before.value.cursor).toBe(4);
    expect(before.value.questions[0].status).toBe('open');
    first.ws.terminate();
    const replacement = await w.connect();
    await until(() =>
      replacement.frames.some((frame: any) => frame.type === 'turn'),
    );
    const resumed = replacement.frames.find(
      (frame: any) => frame.type === 'turn',
    );
    expect(resumed.requestId).toBe(run.requestId);
    expect(resumed.resume.cursor).toBe(4);
    const body = {
      idempotencyKey: crypto.randomUUID(),
      expectedRevision: 1,
      action: 'answer',
      value: true,
    };
    expect(
      (
        await w.request(
          path(w, run.requestId) + '/questions/confirmation',
          body,
          'viewer-browser',
        )
      ).status,
    ).toBe(403);
    const bearer = await fetch(
      w.origin + path(w, run.requestId) + '/questions/confirmation',
      {
        method: 'POST',
        headers: {
          Origin: w.origin,
          Authorization: 'Bearer explicit-fixture-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    expect(bearer.status).toBe(403);
    const answered = await w.request(
      path(w, run.requestId) + '/questions/confirmation',
      body,
    );
    expect(answered.status).toBe(200);
    expect(
      (
        await w.request(
          path(w, run.requestId) + '/questions/confirmation',
          body,
        )
      ).status,
    ).toBe(200);
    await until(() =>
      replacement.frames.some((frame: any) => frame.type === 'input-result'),
    );
    expect(
      replacement.frames.find((frame: any) => frame.type === 'input-result'),
    ).toMatchObject({
      questionId: 'confirmation',
      status: 'answered',
      value: true,
    });
    complete(replacement.ws, run.requestId);
    await run.done;
    expect((await w.runtime.get(run.job.id))?.status).toBe('completed');
    expect(
      (await w.store.messages(w.artifact.id)).filter(
        (message) => message.role === 'assistant',
      ),
    ).toHaveLength(1);
    const persisted = await w.request(path(w, run.requestId));
    expect(persisted.value.questions[0]).toMatchObject({
      status: 'answered',
      answeredBy: w.user.id,
    });
  });
  it('holds fully answered questionnaires during an acknowledged pause and sends them only after resume', async () => {
    const w = await remoteFixture(),
      client = await w.connect(),
      run = await turn(w, client),
      now = Math.floor(Date.now() / 1000);
    event(client.ws, run.requestId, {
      type: 'runs',
      active: ['review'],
      paused: [],
      cards: [
        {
          id: 'review',
          name: 'Review integration boundary',
          status: 'running',
          started: now,
          updated: now,
          waiting: 1,
          stages: [
            { id: 'inspect', name: 'Inspect source', status: 'awaiting_input' },
          ],
        },
      ],
    });
    event(client.ws, run.requestId, {
      type: 'input-request',
      questionId: 'questions',
      runId: 'review',
      input: {
        method: 'questionnaire',
        params: {
          questions: [
            {
              header: 'Storage',
              question: 'Which storage boundary?',
              options: [
                {
                  label: 'PostgreSQL',
                  description: 'Use the current durable database.',
                },
                { label: 'SQLite', description: 'Use a local fixture.' },
              ],
            },
            {
              header: 'Checks',
              question: 'Which checks should run?',
              multiSelect: true,
              options: [
                { label: 'Contracts', description: '' },
                { label: 'Browser', description: '' },
              ],
            },
          ],
        },
      },
    });
    await until(
      () =>
        client.frames.filter((frame: any) => frame.type === 'event-accepted')
          .length === 2,
    );
    const pause = await w.request(path(w, run.requestId) + '/control', {
      idempotencyKey: crypto.randomUUID(),
      action: 'pause',
      runId: 'review',
    });
    expect(pause.status).toBe(200);
    await until(() =>
      client.frames.some((frame: any) => frame.type === 'control'),
    );
    let control = client.frames.find((frame: any) => frame.type === 'control');
    client.ws.send(
      JSON.stringify({
        type: 'control-result',
        requestId: run.requestId,
        controlId: control.controlId,
        ok: true,
      }),
    );
    await until(async () =>
      (
        (await w.request(path(w, run.requestId))).value.runs.paused as string[]
      ).includes('review'),
    );
    expect(
      (
        await w.request(path(w, run.requestId) + '/questions/questions', {
          idempotencyKey: crypto.randomUUID(),
          expectedRevision: 1,
          action: 'answer',
          answers: [{ questionIndex: 0, kind: 'option', answer: 'PostgreSQL' }],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await w.request(path(w, run.requestId) + '/questions/questions', {
          idempotencyKey: crypto.randomUUID(),
          expectedRevision: 2,
          action: 'answer',
          answers: [
            {
              questionIndex: 1,
              kind: 'multi',
              answer: null,
              selected: ['Contracts', 'Browser'],
            },
          ],
        })
      ).status,
    ).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(
      client.frames.filter((frame: any) => frame.type === 'input-result'),
    ).toHaveLength(0);
    expect(
      (
        await w.request(path(w, run.requestId) + '/control', {
          idempotencyKey: crypto.randomUUID(),
          action: 'resume',
          runId: 'review',
        })
      ).status,
    ).toBe(200);
    await until(
      () =>
        client.frames.filter((frame: any) => frame.type === 'control')
          .length === 2,
    );
    control = client.frames.filter((frame: any) => frame.type === 'control')[1];
    client.ws.send(
      JSON.stringify({
        type: 'control-result',
        requestId: run.requestId,
        controlId: control.controlId,
        ok: true,
      }),
    );
    await until(() =>
      client.frames.some((frame: any) => frame.type === 'input-result'),
    );
    expect(
      client.frames.find((frame: any) => frame.type === 'input-result').value
        .answers,
    ).toHaveLength(2);
    complete(client.ws, run.requestId);
    await run.done;
  });
  it('withdraws questions when the source changes and persists a real durable stop instead of accepting a late result', async () => {
    const w = await remoteFixture(),
      client = await w.connect(),
      run = await turn(w, client);
    event(client.ws, run.requestId, {
      type: 'input-request',
      questionId: 'name',
      input: { method: 'input', title: 'Name this boundary' },
    });
    await until(() =>
      client.frames.some((frame: any) => frame.type === 'event-accepted'),
    );
    await w.store.updateArtifact(w.user, w.artifact.id, w.artifact.version, {
      ...w.artifact.content,
      doc: {
        type: 'doc',
        content: [paragraph('Changed source must receive a fresh answer.')],
      },
    });
    const stale = await w.request(path(w, run.requestId));
    expect(stale.value.questions[0].status).toBe('stale');
    expect(
      (
        await w.request(path(w, run.requestId) + '/questions/name', {
          idempotencyKey: crypto.randomUUID(),
          expectedRevision: 2,
          action: 'answer',
          value: 'Too late',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await w.request(path(w, run.requestId) + '/control', {
          idempotencyKey: crypto.randomUUID(),
          action: 'stop',
        })
      ).status,
    ).toBe(200);
    await run.done;
    expect((await w.runtime.get(run.job.id))?.status).toBe('cancelled');
    expect(
      (await w.store.messages(w.artifact.id)).filter(
        (message) => message.role === 'assistant',
      ),
    ).toHaveLength(0);
  });
  it('retains negotiated stage deltas and rejects remote tool impersonation and changed replay identities', async () => {
    const w = await remoteFixture(),
      client = await w.connect(),
      run = await turn(w, client),
      now = Math.floor(Date.now() / 1000);
    event(client.ws, run.requestId, {
      type: 'runs',
      active: ['run'],
      paused: [],
      cards: [
        {
          id: 'run',
          name: 'Boundary checks',
          status: 'running',
          started: now,
          updated: now,
          waiting: 0,
          stages: [{ id: 'first', name: 'Read source', status: 'completed' }],
        },
      ],
    });
    event(client.ws, run.requestId, {
      type: 'runs',
      active: ['run'],
      paused: [],
      cards: [
        {
          id: 'run',
          name: 'Boundary checks',
          status: 'running',
          started: now,
          updated: now,
          waiting: 0,
          stagesDelta: true,
          stages: Array.from({ length: 80 }, (_, index) => ({
            id: 'stage-' + index,
            name: 'Stage ' + index,
            status: 'pending',
          })),
        },
      ],
    });
    await until(
      () =>
        client.frames.filter((frame: any) => frame.type === 'event-accepted')
          .length === 2,
    );
    const snapshot = await w.request(path(w, run.requestId));
    expect(snapshot.value.runs.cards[0].stages).toHaveLength(81);
    const key = event(client.ws, run.requestId, {
      type: 'part',
      part: { type: 'text-start', id: 'text' },
    });
    await until(() =>
      client.frames.some((frame: any) => frame.eventId === key),
    );
    client.ws.send(
      JSON.stringify({
        type: 'part',
        requestId: run.requestId,
        eventId: key,
        part: { type: 'text-start', id: 'different' },
      }),
    );
    await until(() => client.ws.readyState === 3);
    const replacement = await w.connect();
    await until(() =>
      replacement.frames.some((frame: any) => frame.type === 'turn'),
    );
    event(replacement.ws, run.requestId, {
      type: 'tools',
      names: ['repository_file'],
    });
    await until(() => replacement.ws.readyState === 3);
    await w.runtime.cancel(run.job.id, w.user);
    await run.done;
  });
});
