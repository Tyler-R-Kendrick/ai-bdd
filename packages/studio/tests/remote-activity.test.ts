import { describe, it, expect } from 'vitest';
import { remoteFixture, until } from './remote-fixture.ts';
import { paragraph } from '../shared/domain.ts';
import {
  connectRemotePlanner,
  runRemotePlanner,
} from '../server/machine/planner-client.ts';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError } from '../server/store.ts';
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
  it('bridges a spawned ACP streamed turn and explicit workflow report through a real browser question without inventing pause support', async () => {
    const w = await remoteFixture(),
      dir = await mkdtemp(join(tmpdir(), 'studio-remote-input-acp-')),
      script = join(dir, 'protocol.mjs'),
      controller = new AbortController();
    await writeFile(
      script,
      `
      import readline from 'node:readline';
      const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
      let prompt;
      const update=value=>send({method:'session/update',params:{sessionId:'actual-input',update:value}});
      const report=status=>update({sessionUpdate:'studio_run_report',runs:{active:status==='running'?['acp-review']:[],paused:[],cards:[{id:'acp-review',name:'Actual ACP boundary review',status,started:1,updated:2,...(status==='finished'?{ended:2}:{}),waiting:status==='running'?1:0,stages:[{id:'review',name:'Ask the person',status:status==='running'?'awaiting_input':'completed'}]}]}});
      for await(const line of readline.createInterface({input:process.stdin})){
        const m=JSON.parse(line);
        if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}});
        if(m.method==='session/new')send({id:m.id,result:{sessionId:'actual-input'}});
        if(m.method==='session/prompt'){
          prompt=m.id;report('running');
          update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'{"summary":"'}});
          send({id:'browser-question',method:'session/request_input',params:{sessionId:'actual-input',questionId:'acp-confirmation',runId:'acp-review',input:{method:'confirm',title:'Confirm the actual ACP boundary?',message:'An answer does not authorize tools.'}}});
        }
        if(m.id==='browser-question'&&m.result){
          if(m.result.status!=='answered'||m.result.value!==true)process.exit(13);
          update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Actual ACP browser confirmation recorded."}'}});report('finished');
          send({id:prompt,result:{stopReason:'end_turn'}});
        }
      }
    `,
    );
    let attached = false;
    const client = runRemotePlanner({
      origin: w.origin,
      artifactId: w.artifact.id,
      token: 'explicit-fixture-token',
      signal: controller.signal,
      command: process.execPath,
      args: [script],
      cwd: dir,
      onAttached: () => {
        attached = true;
      },
    });
    try {
      await until(() => attached);
      const run = await w.start();
      let id = '';
      await until(async () => {
        const response = await w.request(
          `/api/artifacts/${w.artifact.id}/planner/activity`,
        );
        id = response.value.requests[0]?.id;
        return response.value.requests[0]?.questions.length === 1;
      });
      const before = await w.request(path(w, id));
      expect(before.value.runs.cards[0].name).toBe(
        'Actual ACP boundary review',
      );
      expect(before.value.stream.blocks[0].text).toBe('{"summary":"');
      expect(
        (
          await w.request(path(w, id) + '/control', {
            idempotencyKey: crypto.randomUUID(),
            action: 'pause',
            runId: 'acp-review',
          })
        ).status,
      ).toBe(200);
      await until(
        async () =>
          (await w.request(path(w, id))).value.controls[0]?.status === 'failed',
      );
      expect(
        (
          await w.request(path(w, id) + '/questions/acp-confirmation', {
            idempotencyKey: crypto.randomUUID(),
            expectedRevision: 1,
            action: 'answer',
            value: true,
          })
        ).status,
      ).toBe(200);
      await run.done;
      expect((await w.runtime.get(run.job.id))?.status).toBe('completed');
      expect(
        (await w.store.messages(w.artifact.id)).find(
          (m) => m.role === 'assistant',
        )?.body,
      ).toBe('Actual ACP browser confirmation recorded.');
      expect((await w.request(path(w, id))).value.runs.cards[0].status).toBe(
        'finished',
      );
    } finally {
      controller.abort();
      await client;
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('reports exhausted active model time back to the durable server instead of leaving its lease running forever', async () => {
    const w = await remoteFixture(),
      controller = new AbortController();
    let attached = false,
      entered = false;
    const client = connectRemotePlanner({
      origin: w.origin,
      artifactId: w.artifact.id,
      token: 'explicit-fixture-token',
      signal: controller.signal,
      activeTurnMs: 100,
      onAttached: () => {
        attached = true;
      },
      run: async (_turn, signal) => {
        entered = true;
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return { text: 'An expired model turn cannot publish.', content: null };
      },
    });
    try {
      await until(() => attached);
      const run = await w.start();
      await until(() => entered);
      await until(
        async () => (await w.runtime.get(run.job.id))?.status !== 'running',
      );
      await run.done;
      expect((await w.runtime.get(run.job.id))?.status).toBe('queued');
      expect(
        (await w.store.messages(w.artifact.id)).filter(
          (m) => m.role === 'assistant',
        ),
      ).toHaveLength(0);
    } finally {
      controller.abort();
      await client;
    }
  });
  it('aborts the actual selected-user repository read when its durable remote turn is stopped', async () => {
    const w = await remoteFixture();
    await w.store.exec(
      'UPDATE projects SET repository=? WHERE id=?',
      'https://github.com/example/remote-fixture',
      w.project.id,
    );
    w.agent.options.repositoryRead = async () => [{ sha: 'a'.repeat(40) }];
    let entered = false,
      aborted = false;
    w.remote.options.repositoryRead = async (user, _repo, input, signal) => {
      expect(user.id).toBe(w.user.id);
      expect(input).toMatchObject({
        kind: 'file',
        ref: 'a'.repeat(40),
        path: 'README.md',
      });
      entered = true;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      aborted = true;
      throw new Error('The selected-user read was aborted');
    };
    const client = await w.connect(),
      run = await turn(w, client);
    client.ws.send(
      JSON.stringify({
        type: 'tool',
        requestId: run.requestId,
        callId: 'actual-aborted-read',
        name: 'repository_file',
        input: { path: 'README.md' },
      }),
    );
    await until(() => entered);
    expect(
      (
        await w.request(path(w, run.requestId) + '/control', {
          idempotencyKey: crypto.randomUUID(),
          action: 'stop',
        })
      ).status,
    ).toBe(200);
    await until(() => aborted);
    await run.done;
    expect((await w.runtime.get(run.job.id))?.status).toBe('cancelled');
    expect(
      (await w.store.messages(w.artifact.id)).filter(
        (m) => m.role === 'assistant',
      ),
    ).toHaveLength(0);
  });
  it('returns an unavailable repository tool as a bounded error without failing a valid remote turn', async () => {
    const w = await remoteFixture(),
      client = await w.connect(),
      run = await turn(w, client);
    client.ws.send(
      JSON.stringify({
        type: 'tool',
        requestId: run.requestId,
        callId: 'missing-repository',
        name: 'repository_file',
        input: { path: 'README.md' },
      }),
    );
    await until(() =>
      client.frames.some((frame: any) => frame.type === 'tool-result'),
    );
    expect(
      client.frames.find((frame: any) => frame.type === 'tool-result'),
    ).toMatchObject({
      isError: true,
      value: { error: 'This turn has no captured repository revision' },
    });
    expect(client.ws.readyState).toBe(1);
    complete(client.ws, run.requestId);
    await run.done;
    expect((await w.runtime.get(run.job.id))?.status).toBe('completed');
  });
  it('preserves member-written choices and partial cancellation without changing the runtime answer contract', async () => {
    const w = await remoteFixture(),
      client = await w.connect(),
      run = await turn(w, client);
    const input = {
      method: 'questionnaire',
      params: {
        questions: [
          {
            header: 'Preview',
            question: 'Choose a boundary',
            options: [
              {
                label: 'Contract',
                description: 'Use a consumer contract',
                preview: 'Given the integration is unavailable',
              },
            ],
          },
          {
            header: 'Follow-up',
            question: 'Choose the next check',
            options: [{ label: 'Browser', description: '' }],
            multiSelect: true,
          },
        ],
      },
    };
    for (const questionId of [
      'human-cancel',
      'remote-cancel',
      'written',
      'preview',
    ])
      event(client.ws, run.requestId, {
        type: 'input-request',
        questionId,
        input,
      });
    event(client.ws, run.requestId, {
      type: 'input-request',
      questionId: 'select',
      input: {
        method: 'select',
        title: 'Choose deployment target',
        choices: ['Preview', 'Production'],
      },
    });
    await until(
      () =>
        client.frames.filter((f: any) => f.type === 'event-accepted').length ===
        5,
    );
    for (const questionId of ['human-cancel', 'remote-cancel', 'preview'])
      expect(
        (
          await w.request(path(w, run.requestId) + '/questions/' + questionId, {
            idempotencyKey: crypto.randomUUID(),
            expectedRevision: 1,
            action: 'answer',
            answers: [{ questionIndex: 0, kind: 'option', answer: 'Contract' }],
          })
        ).status,
      ).toBe(200);
    expect(
      (
        await w.request(path(w, run.requestId) + '/questions/human-cancel', {
          idempotencyKey: crypto.randomUUID(),
          expectedRevision: 2,
          action: 'cancel',
        })
      ).status,
    ).toBe(200);
    event(client.ws, run.requestId, {
      type: 'input-cancel',
      questionId: 'remote-cancel',
    });
    expect(
      (
        await w.request(path(w, run.requestId) + '/questions/preview', {
          idempotencyKey: crypto.randomUUID(),
          expectedRevision: 2,
          action: 'answer',
          answers: [
            {
              questionIndex: 1,
              kind: 'custom',
              answer: 'Inspect the saved evidence first',
            },
          ],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await w.request(path(w, run.requestId) + '/questions/written', {
          idempotencyKey: crypto.randomUUID(),
          expectedRevision: 1,
          action: 'answer',
          answers: [
            {
              questionIndex: 0,
              kind: 'custom',
              answer: 'Keep the existing boundary',
            },
            { questionIndex: 1, kind: 'chat', answer: 'Verify both paths' },
          ],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await w.request(path(w, run.requestId) + '/questions/select', {
          idempotencyKey: crypto.randomUUID(),
          expectedRevision: 1,
          action: 'answer',
          value: null,
          customValue: 'An isolated staging environment',
        })
      ).status,
    ).toBe(200);
    await until(
      () =>
        client.frames.filter((f: any) => f.type === 'input-result').length ===
        5,
    );
    const result = (id: string) =>
      client.frames.find(
        (f: any) => f.type === 'input-result' && f.questionId === id,
      );
    expect(result('human-cancel').value).toMatchObject({
      cancelled: true,
      answers: [
        {
          kind: 'option',
          question: 'Choose a boundary',
          preview: 'Given the integration is unavailable',
        },
      ],
    });
    expect(result('remote-cancel').value).toEqual({
      answers: [],
      cancelled: true,
    });
    expect(result('written').value.answers.map((a: any) => a.kind)).toEqual([
      'chat',
      'chat',
    ]);
    expect(result('preview').value.answers[1].kind).toBe('chat');
    expect(result('select')).toMatchObject({ status: 'answered', value: null });
    const snapshot = await w.request(path(w, run.requestId));
    expect(
      snapshot.value.questions.find((q: any) => q.id === 'select'),
    ).toMatchObject({
      value: null,
      customAnswer: 'An isolated staging environment',
      answeredBy: w.user.id,
    });
    complete(client.ws, run.requestId);
    await run.done;
  });
  it('keeps real human input waiting beyond the active model time budget without granting tool authority', async () => {
    const w = await remoteFixture(),
      controller = new AbortController();
    let attached = false;
    const client = connectRemotePlanner({
      origin: w.origin,
      token: 'explicit-fixture-token',
      artifactId: w.artifact.id,
      signal: controller.signal,
      activeTurnMs: 1000,
      onAttached: () => {
        attached = true;
      },
      run: async (_turn, _signal, ctx) => {
        await ctx.sendPart({ type: 'stream-start' });
        await ctx.sendPart({ type: 'text-start', id: 'answer' });
        await ctx.sendPart({
          type: 'text-delta',
          id: 'answer',
          delta: 'Waiting for a person to choose the boundary.',
        });
        const answer = await ctx.ask('human-wait', {
          method: 'confirm',
          title: 'Keep the current boundary?',
          message: 'This is an answer, not permission to run a tool.',
        });
        expect(answer).toMatchObject({ status: 'answered', value: true });
        await ctx.sendPart({ type: 'text-end', id: 'answer' });
        return { text: 'The person confirmed the boundary.', content: null };
      },
    });
    try {
      await until(() => attached);
      const run = await w.start();
      let requestId = '';
      await until(async () => {
        const response = await w.request(
          `/api/artifacts/${w.artifact.id}/planner/activity`,
        );
        requestId = response.value.requests[0]?.id ?? '';
        return !!response.value.requests[0]?.questions.length;
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect((await w.runtime.get(run.job.id))?.status).toBe('running');
      expect(
        (
          await w.request(path(w, requestId) + '/questions/human-wait', {
            idempotencyKey: crypto.randomUUID(),
            expectedRevision: 1,
            action: 'answer',
            value: true,
          })
        ).status,
      ).toBe(200);
      await run.done;
      expect((await w.runtime.get(run.job.id))?.status).toBe('completed');
    } finally {
      controller.abort();
      await client;
    }
  });
  it('retains background workflow stages and questions after the chat turn ends, without admitting a new root', async () => {
    const w = await remoteFixture(),
      client = await w.connect(),
      run = await turn(w, client),
      now = Math.floor(Date.now() / 1000);
    event(client.ws, run.requestId, {
      type: 'runs',
      active: ['background'],
      paused: [],
      cards: [
        {
          id: 'background',
          name: 'Retained boundary workflow',
          status: 'running',
          started: now,
          updated: now,
          waiting: 0,
          stages: [{ id: 'work', name: 'Collect evidence', status: 'running' }],
        },
      ],
    });
    await until(() =>
      client.frames.some((frame: any) => frame.type === 'event-accepted'),
    );
    complete(client.ws, run.requestId);
    await run.done;
    expect((await w.runtime.get(run.job.id))?.status).toBe('completed');
    event(client.ws, run.requestId, {
      type: 'input-request',
      questionId: 'retained-question',
      runId: 'background',
      input: {
        method: 'confirm',
        title: 'Continue collecting evidence?',
        message: 'The previous response is already published.',
      },
    });
    await until(
      () =>
        client.frames.filter((frame: any) => frame.type === 'event-accepted')
          .length === 2,
    );
    const snapshot = await w.request(path(w, run.requestId));
    expect(snapshot.value.canAnswer).toBe(true);
    expect(
      (
        await w.request(
          path(w, run.requestId) + '/questions/retained-question',
          {
            idempotencyKey: crypto.randomUUID(),
            expectedRevision: 1,
            action: 'answer',
            value: false,
          },
        )
      ).status,
    ).toBe(200);
    await until(() =>
      client.frames.some((frame: any) => frame.type === 'input-result'),
    );
    event(client.ws, run.requestId, {
      type: 'runs',
      active: [],
      paused: [],
      cards: [
        {
          id: 'background',
          name: 'Retained boundary workflow',
          status: 'finished',
          started: now,
          updated: now + 1,
          ended: now + 1,
          waiting: 0,
          stagesDelta: true,
          stages: [
            { id: 'work', name: 'Collect evidence', status: 'completed' },
          ],
        },
      ],
    });
    await until(
      () =>
        client.frames.filter((frame: any) => frame.type === 'event-accepted')
          .length === 3,
    );
    expect(
      (await w.request(path(w, run.requestId))).value.runs.cards[0].stages[0]
        .status,
    ).toBe('completed');
  });
  it('binds activity to server-selected assignment epochs and closes replaced scoped credentials', async () => {
    const w = await remoteFixture();
    let epoch = 1;
    const assignmentId = crypto.randomUUID();
    w.remote.options.authenticateScoped = async (request) =>
      request.headers.authorization === 'Bearer explicit-fixture-token'
        ? { user: w.user, artifactId: w.artifact.id, assignmentId, epoch }
        : null;
    w.remote.options.assertScoped = async (scope) => {
      if (scope.assignmentId !== assignmentId || scope.epoch !== epoch)
        throw new HttpError(401, 'Planner assignment was replaced');
    };
    const client = await w.connect(),
      run = await turn(w, client);
    event(client.ws, run.requestId, {
      type: 'input-request',
      questionId: 'scoped-question',
      input: { method: 'input', title: 'Name the boundary' },
    });
    await until(() =>
      client.frames.some((frame: any) => frame.type === 'event-accepted'),
    );
    expect(
      await w.remote.hasLiveActivity(w.artifact.id, w.user.id, {
        assignmentId,
        epoch: 1,
      }),
    ).toBe(true);
    expect(await w.remote.hasLiveActivityForArtifact(w.artifact.id)).toBe(true);
    expect(
      await w.remote.hasLiveActivity(w.artifact.id, w.user.id, {
        assignmentId,
        epoch: 2,
      }),
    ).toBe(false);
    epoch = 2;
    await run.done;
    expect((await w.runtime.get(run.job.id))?.status).not.toBe('completed');
    expect(await w.remote.hasLiveActivityForArtifact(w.artifact.id)).toBe(
      false,
    );
    expect(
      await w.remote.hasLiveActivity(w.artifact.id, w.user.id, {
        assignmentId,
        epoch: 2,
      }),
    ).toBe(false);
  });
  it('restores retained background cards on a fresh portable client without rerunning a completed model turn', async () => {
    const w = await remoteFixture();
    const initialController = new AbortController();
    let initialAttached = false;
    const initial = connectRemotePlanner({
      origin: w.origin,
      artifactId: w.artifact.id,
      token: 'explicit-fixture-token',
      signal: initialController.signal,
      onAttached: () => {
        initialAttached = true;
      },
      run: async (_turn, _signal, ctx) => {
        const now = Math.floor(Date.now() / 1000);
        await ctx.reportRuns({
          active: ['retained'],
          paused: [],
          cards: [
            {
              id: 'retained',
              name: 'Retained external work',
              status: 'running',
              started: now,
              updated: now,
              waiting: 0,
              stages: [
                { id: 'observe', name: 'Observe boundary', status: 'running' },
              ],
            },
          ],
        });
        return { text: 'The chat response is complete.', content: null };
      },
    });
    await until(() => initialAttached);
    const run = await w.start();
    await run.done;
    expect((await w.runtime.get(run.job.id))?.status).toBe('completed');
    initialController.abort();
    await initial;
    const replacementController = new AbortController();
    let reruns = 0;
    const replacement = connectRemotePlanner({
      origin: w.origin,
      artifactId: w.artifact.id,
      token: 'explicit-fixture-token',
      signal: replacementController.signal,
      run: async () => {
        reruns++;
        return { text: 'Should never run again', content: null };
      },
    });
    try {
      await until(async () => {
        const response = await w.request(
          `/api/artifacts/${w.artifact.id}/planner/activity`,
        );
        return response.value.requests[0]?.runs.cards[0]?.status === 'stopped';
      });
      expect(reruns).toBe(0);
      expect(await w.remote.hasLiveActivity(w.artifact.id, w.user.id)).toBe(
        false,
      );
      const response = await w.request(
        `/api/artifacts/${w.artifact.id}/planner/activity`,
      );
      expect(response.value.requests[0].runs.cards[0].stages).toHaveLength(1);
    } finally {
      replacementController.abort();
      await replacement;
    }
  });
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
    await run.done;
    expect((await w.runtime.get(run.job.id))?.status).toBe('failed');
    const replacement = await w.connect();
    await w.store.message(
      w.user,
      w.artifact.id,
      w.threadId,
      'Check a new turn after the rejected replay.',
    );
    const replacementRun = await turn(w, replacement);
    event(replacement.ws, replacementRun.requestId, {
      type: 'tools',
      names: ['repository_file'],
    });
    await until(() => replacement.ws.readyState === 3);
    await replacementRun.done;
    expect((await w.runtime.get(replacementRun.job.id))?.status).toBe('failed');
  });
});
