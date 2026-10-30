import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { remoteFixture, until } from './remote-fixture.ts';
import { AccountMachines } from '../server/integrations/account-machines.ts';
import { AccountPlanners } from '../server/integrations/account-planners.ts';
import { MachineService } from '../server/integrations/machines.ts';
import { InvestigationService } from '../server/integrations/investigations.ts';
import { plannerIdleMs, plannerLeaseMs } from '../shared/account-planners.ts';
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
});
async function fixture() {
  const w = await remoteFixture({
      postgresUrl: process.env.STUDIO_TEST_POSTGRES_URL,
    }),
    store = w.store;
  await store.tx(async () => {
    await store.lock('project:' + w.project.id);
    await store.exec(
      'UPDATE projects SET repository=? WHERE id=?',
      'https://github.com/example/scoped-planning',
      w.project.id,
    );
  });
  const machines = new MachineService(store, { notify() {} } as any);
  await machines.initialize();
  const investigations = new InvestigationService({
    store,
    auth: {} as any,
    machines,
    objects: {} as any,
  });
  await investigations.ready;
  const accounts = new AccountMachines({ store, auth: {} as any });
  await accounts.ready;
  const device = await accounts.pair(
    (await accounts.pairing(w.user, 'Scoped WS laptop')).code,
  );
  const principal = await accounts.authenticate(
    { headers: { authorization: 'Bearer ' + device.token } } as any,
    device.id,
  );
  await accounts.assignments(principal, [
    {
      checkoutKey: 'scoped-source',
      repository: 'https://github.com/example/scoped-planning',
      sourceCommit: 'b'.repeat(40),
      branch: 'main',
    },
  ]);
  // Explicit repository boundary fixture: no live GitHub or paid model calls.
  // The durable turn still freezes the registered full source commit.
  w.agent.options.repositoryRead = async (user, repository, input) => {
    expect(user.id).toBe(w.user.id);
    expect(repository).toBe('https://github.com/example/scoped-planning');
    if (input.kind === 'commits') return [{ sha: 'b'.repeat(40) }];
    throw new Error(
      'Unexpected repository read in the scoped transport fixture',
    );
  };
  let now = Date.now();
  const service = new AccountPlanners({
    store,
    auth: {} as any,
    accounts,
    profiles: w.agent.profiles,
    enabled: true,
    now: () => now,
    hasLiveActivity: (id, user, scope) =>
      w.remote.hasLiveActivity(id, user, scope),
  });
  await service.ready;
  accounts.dependencies.plannerWorkActive = (id) => service.activeOnDevice(id);
  w.remote.options.authenticateScoped = (request) =>
    service.authenticatePlanner(request);
  w.remote.options.assertScoped = (scope) => service.assertPlanner(scope);
  const assignment = await service.assign(w.user, w.artifact.id, {
    deviceId: device.id,
    artifactVersion: w.artifact.version,
  });
  const claim = await service.claim(principal, assignment.id, assignment.epoch);
  async function connect(artifactId = w.artifact.id) {
    const ws = new WebSocket(
      w.origin.replace('http:', 'ws:') + '/api/planner/connect',
      'studio.planner.v1',
      {
        headers: {
          authorization: 'Bearer ' + claim.token,
          'Studio-Planner-Features':
            'stream-parts,questions,run-cards,run-stage-deltas',
        },
      },
    );
    sockets.push(ws);
    const frames: any[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'attach', version: 1, artifactId }));
    return { ws, frames };
  }
  return {
    ...w,
    accounts,
    device,
    principal,
    service,
    assignment,
    claim,
    connect,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
async function attached(client: { ws: WebSocket; frames: any[] }) {
  await until(() => {
    if (client.ws.readyState === WebSocket.CLOSED)
      throw new Error(
        'Scoped Planner closed before attachment: ' +
          JSON.stringify(client.frames),
      );
    return client.frames.some((f) => f.type === 'attached');
  });
}
const event = (
  ws: WebSocket,
  requestId: string,
  value: Record<string, unknown>,
) => {
  const eventId = crypto.randomUUID();
  ws.send(JSON.stringify({ requestId, eventId, ...value }));
  return eventId;
};
describe('real SQL account-scoped Planner WebSocket authority', () => {
  it('retains real background run/question activity after the model turn, then expires connection-only idle without granting bearer control', async () => {
    const w = await fixture(),
      client = await w.connect();
    await attached(client);
    const run = await w.start();
    await until(() => client.frames.some((f) => f.type === 'turn'));
    const requestId = client.frames.find((f) => f.type === 'turn').requestId;
    const epoch = { assignmentId: w.assignment.id, epoch: w.assignment.epoch };
    const started = Math.floor(Date.now() / 1000);
    event(client.ws, requestId, {
      type: 'runs',
      active: [],
      paused: ['boundary'],
      cards: [
        {
          id: 'boundary',
          name: 'Paused boundary investigation',
          status: 'paused',
          started,
          updated: started,
          waiting: 1,
          stages: [
            {
              id: 'collect',
              name: 'Collect real evidence',
              status: 'awaiting_input',
            },
          ],
        },
      ],
    });
    await until(
      () =>
        client.frames.filter((f) => f.type === 'event-accepted').length === 1,
    );
    client.ws.send(
      JSON.stringify({
        type: 'result',
        requestId,
        output: {
          text: 'The planning turn finished; the owner still has a boundary choice.',
          content: null,
        },
      }),
    );
    await run.done;
    expect((await w.runtime.get(run.job.id))?.status).toBe('completed');
    event(client.ws, requestId, {
      type: 'input-request',
      questionId: 'boundary-choice',
      runId: 'boundary',
      input: {
        method: 'select',
        title: 'Choose the boundary',
        choices: ['Contract fixture', 'Live integration'],
      },
    });
    await until(
      () =>
        client.frames.filter((f) => f.type === 'event-accepted').length === 2,
    );
    expect(
      await w.remote.hasLiveActivity(w.artifact.id, w.user.id, epoch),
    ).toBe(true);
    expect(
      await w.remote.hasLiveActivity(w.artifact.id, w.user.id, {
        ...epoch,
        epoch: epoch.epoch + 1,
      }),
    ).toBe(false);
    const stored = await w.store.one(
      'SELECT assignment_id,assignment_epoch FROM studio_remote_activity WHERE request_id=?',
      requestId,
    );
    expect(stored).toMatchObject({
      assignment_id: w.assignment.id,
      assignment_epoch: w.assignment.epoch,
    });
    const path = `/api/artifacts/${w.artifact.id}/planner/requests/${requestId}`;
    expect(
      (
        await fetch(w.origin + path, {
          headers: { authorization: 'Bearer ' + w.claim.token },
        })
      ).status,
    ).toBe(200);
    const denied = await fetch(w.origin + path + '/questions/boundary-choice', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + w.claim.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        expectedRevision: 1,
        action: 'answer',
        value: 'Contract fixture',
      }),
    });
    expect(denied.status).toBe(403);
    w.advance(40_000);
    expect(
      (await w.service.renew(w.principal, w.assignment.id, w.assignment.epoch))
        .idle,
    ).toBe(false);
    expect(
      (
        await w.request(path + '/questions/boundary-choice', {
          idempotencyKey: crypto.randomUUID(),
          expectedRevision: 1,
          action: 'answer',
          value: 'Contract fixture',
        })
      ).status,
    ).toBe(200);
    event(client.ws, requestId, {
      type: 'runs',
      active: [],
      paused: [],
      cards: [
        {
          id: 'boundary',
          name: 'Paused boundary investigation',
          status: 'finished',
          started,
          updated: started + 1,
          ended: started + 1,
          waiting: 0,
          stages: [
            {
              id: 'collect',
              name: 'Collect real evidence',
              status: 'completed',
            },
          ],
        },
      ],
    });
    await until(
      () =>
        client.frames.filter((f) => f.type === 'event-accepted').length === 3,
    );
    expect(
      await w.remote.hasLiveActivity(w.artifact.id, w.user.id, epoch),
    ).toBe(false);
    for (let i = 0; i < 3; i++) {
      client.ws.send(JSON.stringify({ type: 'ping' }));
      w.advance(40_000);
      expect(
        (
          await w.service.renew(
            w.principal,
            w.assignment.id,
            w.assignment.epoch,
          )
        ).idle,
      ).toBe(i === 2);
    }
    await until(() => client.ws.readyState === WebSocket.CLOSED);
    expect(
      (await w.service.view(w.user, w.artifact.id)).assignment?.status,
    ).toBe('idle');
    expect(plannerIdleMs).toBeGreaterThan(plannerLeaseMs);
  });
  it('rejects cross-artifact attachment and closes an actual running connection when its frozen source changes', async () => {
    const w = await fixture();
    const other = await w.store.createArtifact(
      w.user,
      w.project.id,
      'document',
      'Other artifact',
    );
    const wrong = await w.connect(other.id);
    await until(() => wrong.ws.readyState === WebSocket.CLOSED);
    expect(wrong.frames.some((f) => f.type === 'attached')).toBe(false);
    expect(
      (
        await fetch(w.origin + `/api/artifacts/${other.id}/planner/activity`, {
          headers: { authorization: 'Bearer ' + w.claim.token },
        })
      ).status,
    ).toBe(403);
    const client = await w.connect();
    await attached(client);
    const run = await w.start();
    await until(() => client.frames.some((f) => f.type === 'turn'));
    const requestId = client.frames.find((f) => f.type === 'turn').requestId;
    const latest = await w.store.artifact(w.artifact.id, w.user.id),
      content = structuredClone(latest.content);
    content.doc.content.push({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'The owner changed the source while the Planner was working.',
        },
      ],
    });
    await w.store.updateArtifact(
      w.user,
      w.artifact.id,
      latest.version,
      content,
    );
    await until(() => client.ws.readyState === WebSocket.CLOSED);
    await run.done;
    expect((await w.runtime.get(run.job.id))?.status).not.toBe('completed');
    expect(
      await w.store.all(
        'SELECT * FROM messages WHERE artifact_id=? AND role=?',
        w.artifact.id,
        'assistant',
      ),
    ).toEqual([]);
    expect(
      await w.remote.hasLiveActivity(w.artifact.id, w.user.id, {
        assignmentId: w.assignment.id,
        epoch: w.assignment.epoch,
      }),
    ).toBe(false);
    expect(
      (
        await w.store.one(
          'SELECT status FROM studio_remote_requests WHERE id=?',
          requestId,
        )
      ).status,
    ).not.toBe('complete');
  });
});
