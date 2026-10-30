import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../server/store.ts';
import { Auth, type Settings } from '../server/auth.ts';
import { Collaboration } from '../server/collaboration.ts';
import { Agent } from '../server/agent.ts';
import { OpenDesignService } from '../server/integrations/open-design.ts';
import { MachineService } from '../server/integrations/machines.ts';
import { integrationExportRows } from '../server/integrations/routes.ts';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function workspace() {
  const store = new Store(':memory:');
  const settings: Settings = {
    production: false,
    origin: 'http://127.0.0.1:8787',
    dataDir: '/tmp/studio-integration-lifecycle',
    demo: false,
  };
  const auth = new Auth(store, settings),
    collab = new Collaboration(store, auth),
    agent = new Agent(store, settings, collab);
  const user = store.createUser(
      'owner@lifecycle.test',
      'Project owner',
      null,
    ),
    project = store.createProject(user, 'Lifecycle', '', '');
  const artifact = store.createArtifact(
    user,
    project.id,
    'code',
    'Work target',
  );
  const machines = new MachineService(store, collab);
  cleanup.push(async () => {
    await agent.close();
    collab.close();
    store.close();
  });
  return { store, user, project, artifact, machines, collab, agent };
}
function designFixture(
  w: ReturnType<typeof workspace>,
  overrides: Record<string, (args: any) => any> = {},
) {
  const calls: { name: string; args: any }[] = [],
    logicalStarts = new Set<string>();
  const defaultActions: Record<string, (args: any) => any> = {
    collect_brief: () => ({
      pluginWorkflowId: 'private-workflow-identity',
      briefDraftId: 'private-draft',
      nonce: 'private-nonce',
      questionForm: {
        questions: [
          {
            id: 'style',
            label: 'Choose a style',
            options: ['Quiet', 'Bold'],
          },
        ],
      },
    }),
    confirm_brief: () => ({
      pluginWorkflowId: 'private-workflow-identity',
      confirmed: true,
      summary: 'A quiet project',
    }),
    get_vela_login_status: () => ({ authenticated: true }),
    start_vela_login: () => ({
      activationUrl: 'https://open-design.ai/activate',
      userCode: 'EXAMPLE-CODE',
    }),
    list_agents: () => ({
      agents: [
        { id: 'amr', available: true, authenticated: true },
        { id: 'codex', available: true, authenticated: true },
      ],
    }),
    list_byok_profiles: () => ({
      profiles: [{ id: 'saved-profile', label: 'Saved provider' }],
    }),
    list_projects: () => ({
      projects: [{ id: 'design-project', title: 'Project' }],
    }),
    start_run: (args) => {
      logicalStarts.add(args.requestId);
      return {
        runId: 'remote-run',
        status: 'queued',
        studioUrl: 'https://open-design.ai/studio/current',
      };
    },
    get_run: () => ({
      runId: 'remote-run',
      status: 'succeeded',
      studioUrl: 'https://open-design.ai/studio/current',
    }),
  };
  const actions = { ...defaultActions, ...overrides };
  const service = new OpenDesignService(w.store, {}, async () => {
    const server = new McpServer({
      name: 'explicit-open-design-protocol-fixture',
      version: '0.17.0',
    });
    for (const [name, action] of Object.entries(actions))
      server.registerTool(
        name,
        { inputSchema: z.record(z.string(), z.any()) },
        async (args) => {
          calls.push({ name, args });
          if (name !== 'collect_brief')
            expect(args.pluginWorkflowId).toBe('private-workflow-identity');
          return {
            content: [{ type: 'text', text: JSON.stringify(action(args)) }],
          };
        },
      );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: 'studio-protocol-fixture',
      version: '1',
    });
    await server.connect(a);
    await client.connect(b);
    const close = client.close.bind(client);
    client.close = async () => {
      await close();
      await server.close();
    };
    return client;
  });
  return { service, calls, logicalStarts };
}
async function confirmed(
  f: ReturnType<typeof designFixture>,
  w: ReturnType<typeof workspace>,
  mode: 'cloud' | 'local-codex' | 'byok' = 'cloud',
) {
  const flow = await f.service.begin(w.user, w.artifact.id, mode, 'en', {
    artifactType: 'website',
    title: 'A scoped design',
  });
  expect(JSON.stringify(flow)).not.toContain('private-workflow');
  expect(JSON.stringify(flow)).not.toContain('private-nonce');
  await f.service.confirm(w.user, w.artifact.id, flow.id, { style: 'Quiet' });
  return flow;
}

describe('Open Design through an explicit MCP protocol fixture', () => {
  it('attributes one brief, confirms once, starts one stable request, then polls the exact run', async () => {
    const w = workspace(),
      f = designFixture(w),
      flow = await confirmed(f, w);
    expect(f.calls[0]?.args.externalPluginContext).toEqual({
      id: 'open-design',
      version: '0.5.2',
      distributionMechanism: 'git_marketplace',
      publisherClass: 'open_design_first_party',
    });
    expect(f.calls[0]?.args.locale).toBe('en');
    const started = await f.service.start(w.user, w.artifact.id, flow.id, {
      projectId: 'design-project',
      prompt: 'Implement the confirmed brief',
    });
    expect(started.status).toBe('queued');
    expect(started.studioUrl).toContain('/studio/current');
    const finished = await f.service.poll(w.user, w.artifact.id, flow.id);
    expect(finished.status).toBe('succeeded');
    expect(
      f.calls.filter((call) => call.name === 'collect_brief'),
    ).toHaveLength(1);
    expect(f.calls.filter((call) => call.name === 'start_run')).toHaveLength(
      1,
    );
    expect(f.calls.at(-1)).toMatchObject({
      name: 'get_run',
      args: { runId: 'remote-run' },
    });
    await f.service.poll(w.user, w.artifact.id, flow.id);
    expect(f.calls.filter((call) => call.name === 'get_run')).toHaveLength(1);
    await expect(
      f.service.confirm(w.user, w.artifact.id, flow.id, {}),
    ).rejects.toThrow('again');
  });
  it('retries a lost start response with the identical logical request and prompt', async () => {
    const w = workspace();
    let attempts = 0;
    const requestIds: string[] = [];
    const f = designFixture(w, {
      start_run: (args) => {
        requestIds.push(args.requestId);
        if (++attempts === 1) throw new Error('fixture lost response');
        return { runId: 'remote-run', status: 'running' };
      },
    });
    const flow = await confirmed(f, w);
    await expect(
      f.service.start(w.user, w.artifact.id, flow.id, {
        projectId: 'design-project',
        prompt: 'Same action',
      }),
    ).rejects.toThrow('Open Design');
    await expect(
      f.service.start(w.user, w.artifact.id, flow.id, {
        projectId: 'design-project',
        prompt: 'Different action',
      }),
    ).rejects.toThrow('new confirmed');
    await f.service.start(w.user, w.artifact.id, flow.id, {
      projectId: 'design-project',
      prompt: 'Same action',
    });
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
  });
  it('keeps Local Codex out of Cloud login and appends the child-runtime boundary', async () => {
    const w = workspace(),
      f = designFixture(w),
      flow = await confirmed(f, w, 'local-codex');
    await expect(
      f.service.inspect(w.user, w.artifact.id, flow.id, 'start-login'),
    ).rejects.toThrow('does not use');
    await f.service.start(w.user, w.artifact.id, flow.id, {
      projectId: 'design-project',
      prompt: 'Work locally',
    });
    const start = f.calls.find((call) => call.name === 'start_run')!;
    expect(start.args.agent).toBe('codex');
    expect(start.args.prompt).toContain(
      'Do not route this request through Open Design again',
    );
    expect(f.calls.some((call) => call.name.includes('vela'))).toBe(false);
  });
  it('requires explicit BYOK profile selection and never falls back to another mode', async () => {
    const w = workspace(),
      f = designFixture(w),
      flow = await confirmed(f, w, 'byok');
    await expect(
      f.service.start(w.user, w.artifact.id, flow.id, {
        projectId: 'design-project',
        prompt: 'Use my saved provider',
      }),
    ).rejects.toThrow('profile');
    await f.service.start(w.user, w.artifact.id, flow.id, {
      projectId: 'design-project',
      prompt: 'Use my saved provider',
      byokProfile: 'saved-profile',
    });
    const start = f.calls.find((call) => call.name === 'start_run')!;
    expect(start.args.byokProfile).toBe('saved-profile');
    expect(start.args).not.toHaveProperty('agent');
    expect(f.calls.some((call) => call.name.includes('vela'))).toBe(false);
  });
  it('fails closed when the installed service omits attributed workflow support', async () => {
    const w = workspace(),
      f = designFixture(w, {
        collect_brief: () => ({ briefDraftId: 'old-runtime' }),
      });
    await expect(
      f.service.begin(w.user, w.artifact.id, 'cloud', 'en', {
        title: 'Requires attribution',
      }),
    ).rejects.toThrow('0.17.0');
    expect(f.calls).toHaveLength(1);
    expect(f.service.list(w.user, w.artifact.id)[0]?.status).toBe(
      'brief-failed',
    );
  });
  it('rejects another member continuing a signed workflow while allowing scoped read access', async () => {
    const w = workspace(),
      f = designFixture(w),
      flow = await confirmed(f, w);
    const user = w.store.createUser('editor@lifecycle.test', 'Editor', null);
    w.store.exec(
      'INSERT INTO memberships VALUES(?,?,?)',
      w.project.id,
      user.id,
      'editor',
    );
    expect(f.service.list(user, w.artifact.id)).toHaveLength(1);
    await expect(
      f.service.start(user, w.artifact.id, flow.id, {
        projectId: 'design-project',
        prompt: 'Continue',
      }),
    ).rejects.toThrow('account');
  });
});

describe('connected-machine approval and review lifecycle', () => {
  it('pairs once, scopes a real lease, preserves proposals until review, and records no test pass', () => {
    const w = workspace(),
      code = w.machines.pairing(
        w.user,
        w.project.id,
        'Local coding agent',
      ).code;
    const machine = w.machines.pair(code);
    expect(() => w.machines.pair(code)).toThrow('already used');
    const auth = w.machines.authenticate(
      { headers: { authorization: `Bearer ${machine.token}` } } as any,
      machine.id,
    );
    const work = w.machines.queue(w.user, w.artifact.id, {
      version: w.artifact.version,
      kind: 'implementation',
      brief: 'Implement the selected code artifact.',
    });
    const claim = w.machines.claim(auth);
    expect(claim.work?.id).toBe(work.id);
    expect(claim.leaseToken).toMatch(/^[\w-]{43}$/);
    const content = {
      ...w.artifact.content,
      files: { 'index.html': '<h1>Reviewed result</h1>' },
    };
    w.machines.complete(auth, work.id, claim.leaseToken!, {
      summary: 'Proposed implementation',
      content,
      leaseToken: 'must-not-be-exported',
    } as any);
    expect(w.store.artifact(w.artifact.id, w.user.id).version).toBe(1);
    expect(
      w.machines.list(w.user, w.artifact.id)[0]?.result.evidenceStatus,
    ).toBe('external-unverified');
    expect(
      JSON.stringify(w.machines.list(w.user, w.artifact.id)),
    ).not.toContain('must-not-be-exported');
    w.machines.review(w.user, w.artifact.id, work.id, true);
    expect(
      w.store.artifact(w.artifact.id, w.user.id).content.files['index.html'],
    ).toContain('Reviewed result');
    expect(w.store.runs(w.artifact.id)).toHaveLength(0);
  });
  it('rejects stale approval, stale result application, and revoked machine credentials', () => {
    const w = workspace(),
      machine = w.machines.pair(
        w.machines.pairing(w.user, w.project.id, 'Machine').code,
      );
    const auth = w.machines.authenticate(
      { headers: { authorization: `Bearer ${machine.token}` } } as any,
      machine.id,
    );
    expect(() =>
      w.machines.queue(w.user, w.artifact.id, {
        version: 99,
        kind: 'implementation',
        brief: 'Stale',
      }),
    ).toThrow('changed');
    const work = w.machines.queue(w.user, w.artifact.id, {
      version: 1,
      kind: 'investigation',
      brief: 'Investigate',
    });
    const claim = w.machines.claim(auth);
    w.machines.complete(auth, work.id, claim.leaseToken!, {
      summary: 'Findings',
    });
    w.store.updateArtifact(w.user, w.artifact.id, 1, {
      ...w.artifact.content,
      files: { 'index.html': '<h1>Newer human work</h1>' },
    });
    expect(() =>
      w.machines.review(w.user, w.artifact.id, work.id, true),
    ).toThrow('changed');
    w.machines.revoke(w.user, w.project.id, machine.id);
    expect(() =>
      w.machines.authenticate(
        { headers: { authorization: `Bearer ${machine.token}` } } as any,
        machine.id,
      ),
    ).toThrow('credential');
  });
  it('interrupts expired leases without replaying machine side effects', () => {
    const w = workspace(),
      machine = w.machines.pair(
        w.machines.pairing(w.user, w.project.id, 'Machine').code,
      );
    const auth = w.machines.authenticate(
      { headers: { authorization: `Bearer ${machine.token}` } } as any,
      machine.id,
    );
    const work = w.machines.queue(w.user, w.artifact.id, {
      version: 1,
      kind: 'implementation',
      brief: 'An approved action',
    });
    const claim = w.machines.claim(auth);
    w.store.exec(
      'UPDATE studio_machine_work SET lease_expires=? WHERE id=?',
      Date.now() - 1,
      work.id,
    );
    expect(w.machines.claim(auth).work).toBeNull();
    expect(w.machines.list(w.user, w.artifact.id)[0]?.status).toBe(
      'interrupted',
    );
    expect(() =>
      w.machines.complete(auth, work.id, claim.leaseToken!, {
        summary: 'Late result',
      }),
    ).toThrow('lease ended');
  });
  it('streams complete public lifecycle history with cutoff and excludes credentials and signed context', async () => {
    const w = workspace(),
      f = designFixture(w);
    await confirmed(f, w);
    const machine = w.machines.pair(
      w.machines.pairing(w.user, w.project.id, 'Machine').code,
    );
    for (let i = 0; i < 25; i++)
      w.store.exec(
        'INSERT INTO studio_agent_jobs(id,artifact_id,thread_id,user_id,intent,brief,artifact_version,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        `job-${i}`,
        w.artifact.id,
        w.store.threads(w.artifact.id)[0]!.id,
        w.user.id,
        'chat',
        `History ${i}`,
        1,
        'completed',
        new Date().toISOString(),
      );
    const rows = [];
    for await (const row of integrationExportRows(
      w.store,
      w.user,
      w.artifact.id,
    ))
      rows.push(row);
    expect(rows.filter((row) => row.kind === 'agentJob')).toHaveLength(25);
    expect(JSON.stringify(rows)).not.toContain(machine.token);
    expect(JSON.stringify(rows)).not.toContain('private-workflow-identity');
    expect(JSON.stringify(rows)).not.toContain('private-nonce');
  });
});
