import { afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, hash } from '../server/store.ts';
import { readPlanSource } from '../server/plan-source.ts';
import { paragraph } from '../shared/domain.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { MachineService } from '../server/integrations/machines.ts';
import {
  InvestigationService,
  type MachinePrincipal,
} from '../server/integrations/investigations.ts';
import { DiskObjectStore } from '../server/hosting/disk-objects.ts';
import {
  investigationResultSchema,
  validateSelection,
  filteredRows,
  type InvestigationResult,
} from '../shared/investigations.ts';
const close: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of close.splice(0).reverse()) await fn();
});
const url =
  process.env.STUDIO_INVESTIGATION_TEST_POSTGRES_URL ??
  process.env.STUDIO_TEST_POSTGRES_URL;
const sourceCommit = 'a'.repeat(40),
  repository = 'https://github.com/example/investigation';
export const result: InvestigationResult = {
  title: 'Measured latency',
  report: 'A bounded local benchmark compared two implementations.',
  method:
    'Twenty synthetic requests per variant, measuring elapsed milliseconds.',
  limitations:
    'Synthetic localhost measurements do not establish production latency.',
  datasets: [
    {
      id: 'timings',
      title: 'Request latency',
      columns: [
        { id: 'variant', label: 'Variant', type: 'string' },
        { id: 'latency', label: 'Latency', type: 'number', unit: 'ms' },
        { id: 'sample', label: 'Sample', type: 'number' },
      ],
      rows: [
        {
          id: 'baseline',
          values: { variant: 'Baseline', latency: 41, sample: 1 },
        },
        {
          id: 'candidate',
          values: { variant: 'Candidate', latency: 22, sample: 2 },
        },
      ],
    },
  ],
  views: [
    {
      id: 'table',
      title: 'Observed timings',
      type: 'table',
      datasetId: 'timings',
      columns: ['variant', 'latency'],
    },
    {
      id: 'bars',
      title: 'Latency comparison',
      type: 'bar',
      datasetId: 'timings',
      columns: ['variant', 'latency'],
      x: 'variant',
      y: 'latency',
    },
    {
      id: 'line',
      title: 'Latency by sample',
      type: 'line',
      datasetId: 'timings',
      columns: ['sample', 'latency'],
      x: 'sample',
      y: 'latency',
    },
  ],
  evidence: [
    { name: 'Command output', text: 'baseline 41 ms\ncandidate 22 ms' },
  ],
  images: [],
};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'studio-investigations-'));
  close.push(() => rm(dir, { recursive: true, force: true }));
  const store = await Store.open(
    url
      ? await openDatabase({
          adapter: 'postgres',
          url,
          schema: 'inv_' + crypto.randomUUID().replaceAll('-', ''),
        })
      : ':memory:',
  );
  close.push(() => store.close());
  const user = await store.createUser(
      'investigator@example.test',
      'Investigator',
      null,
    ),
    other = await store.createUser(
      'other@example.test',
      'Other writer',
      null,
    ),
    project = (await store.createProject(
      user,
      'Investigation fixture',
      '',
      repository,
    ))!,
    artifact = await store.createArtifact(
      user,
      project.id,
      'design',
      'Measured design',
    );
  await store.exec(
    'INSERT INTO memberships VALUES(?,?,?)',
    project.id,
    other.id,
    'editor',
  );
  const machines = new MachineService(store, { notify() {} } as any);
  await machines.initialize();
  const paired = await machines.pair(
      (await machines.pairing(user, project.id, 'Local machine')).code,
    ),
    machine = (await store.one(
      'SELECT * FROM studio_machines WHERE id=?',
      paired.id,
    )) as MachinePrincipal;
  let locked = false,
    judgeCalls = 0;
  const service = new InvestigationService({
    store,
    auth: {} as any,
    machines,
    objects: new DiskObjectStore(join(dir, 'objects')),
    implementationLocked: async () => locked,
    spikes: {
      enabled: true,
      judge: async () => {
        judgeCalls++;
        return {
          useful: true,
          brief: 'Measure the uncertain requirement',
          reason: 'A prototype can establish feasibility',
        };
      },
    },
  });
  await service.ready;
  machines.hooks.otherWorkActive = (id) => service.activeOnMachine(id);
  await service.registerCheckout(machine, {
    repository,
    sourceCommit,
    branch: 'main',
  });
  const proposal = () =>
    service.propose(user, artifact.id, {
      version: artifact.version,
      brief: 'Compare the latency of two implementations',
      requiredReason: 'Choose a measured implementation',
    });
  return {
    store,
    user,
    other,
    project,
    artifact,
    machines,
    machine,
    service,
    proposal,
    setLocked: (value: boolean) => (locked = value),
    getJudgeCalls: () => judgeCalls,
  };
}
async function running(c: Awaited<ReturnType<typeof fixture>>) {
  const record = await c.proposal();
  await c.service.run(c.user, record.id);
  const claimed = await c.service.claim(c.machine);
  expect(claimed.work?.id).toBe(record.id);
  return {
    record,
    input: {
      leaseToken: claimed.leaseToken!,
      generation: claimed.work!.generation,
      result,
    },
  };
}
async function acceptSemanticChoice(
  c: Awaited<ReturnType<typeof fixture>>,
  decision: string,
) {
  return c.store.tx(async () => {
    await c.store.db.lock('project:' + c.project.id);
    const artifact = await c.store.artifact(
      c.artifact.id,
      c.user.id,
      'write',
    );
    const before = await readPlanSource(c.store, artifact);
    const adr = (await c.store.decisions(artifact.id))[0]!;
    await c.store.exec(
      "UPDATE decisions SET status='accepted',decision=?,author=?,version=version+1,updated_at=? WHERE id=?",
      decision,
      c.user.name,
      new Date().toISOString(),
      adr.id,
    );
    // Same durable semantic-source transition used by accepted ADR and questionnaire APIs.
    const current = await c.store.touchArtifactSource(c.user, artifact.id);
    const source = await readPlanSource(c.store, current);
    expect(current.content).toEqual(artifact.content);
    expect(current.version).toBe(artifact.version + 1);
    expect(source).not.toEqual(before);
    return { current, source };
  });
}
describe(`typed local investigations (${url ? 'PostgreSQL' : 'SQLite'})`, () => {
  it('keeps pending evidence valid across another investigation card and unaccepted ADR draft edits', async () => {
    const c = await fixture();
    const first = await c.proposal();
    const current = await c.store.artifact(c.artifact.id, c.user.id);
    await c.service.propose(c.user, current.id, {
      version: current.version,
      brief: 'A separate bounded investigation',
    });
    await c.store.tx(async () => {
      await c.store.db.lock('project:' + c.project.id);
      await c.store.exec(
        "UPDATE decisions SET decision='Unaccepted alternative under discussion',version=version+1 WHERE artifact_id=? AND status='proposed'",
        c.artifact.id,
      );
    });
    await c.service.run(c.user, first.id);
    expect((await c.service.claim(c.machine)).work?.id).toBe(first.id);
  });
  it('retains already published historical receipt replay after accepted ADR source changes', async () => {
    const c = await fixture();
    const { record, input } = await running(c);
    const receipt = await c.service.complete(c.machine, record.id, input);
    await acceptSemanticChoice(
      c,
      'A later human decision does not rewrite historical evidence.',
    );
    expect(await c.service.complete(c.machine, record.id, input)).toEqual(
      receipt,
    );
    expect((await c.service.get(c.user, record.id)).status).toBe('completed');
  });
  it('seals accepted human ADR source into the actual claimed investigation context', async () => {
    const c = await fixture();
    const { current, source } = await acceptSemanticChoice(
      c,
      'Benchmark the accepted blue implementation, not the superseded red approach.',
    );
    const record = await c.service.propose(c.user, current.id, {
      version: current.version,
      brief: 'Measure feasibility of the accepted implementation',
    });
    await c.service.run(c.user, record.id);
    const claimed = await c.service.claim(c.machine);
    expect(claimed.work?.id).toBe(record.id);
    expect(claimed.work?.sealed.content.acceptedDecisions).toEqual(
      source.acceptedDecisions,
    );
    expect(claimed.work?.briefHash).toBe(
      hash(JSON.stringify(claimed.work!.sealed.sealed)),
    );
    expect(claimed.work?.sealed.sealed.sourceHash).toBe(
      hash(JSON.stringify(claimed.work!.sealed.content)),
    );
  });
  it.each([false, true])(
    'runs legacy content-only snapshots only without current accepted choices (accepted=%s)',
    async (accepted) => {
      const c = await fixture();
      if (accepted)
        await acceptSemanticChoice(
          c,
          'This accepted choice was absent from the old snapshot.',
        );
      const current = await c.store.artifact(c.artifact.id, c.user.id);
      const record = await c.service.propose(c.user, current.id, {
        version: current.version,
        brief: 'A previously persisted content-only investigation',
      });
      const row = await c.store.one(
        'SELECT snapshot_json FROM studio_investigations WHERE id=?',
        record.id,
      );
      const legacy = JSON.parse(row.snapshot_json);
      delete legacy.sealed.sourcePolicy;
      delete legacy.content.acceptedDecisions;
      legacy.sealed.sourceHash = hash(JSON.stringify(legacy.content));
      const meaningful = structuredClone(legacy.content);
      meaningful.doc.content = meaningful.doc.content.filter(
        (node: any) => node.type !== 'investigationCard',
      );
      legacy.sealed.meaningfulSourceHash = hash(JSON.stringify(meaningful));
      await c.store.exec(
        'UPDATE studio_investigations SET snapshot_json=?,brief_hash=? WHERE id=?',
        JSON.stringify(legacy),
        hash(JSON.stringify(legacy.sealed)),
        record.id,
      );
      if (accepted) {
        await expect(c.service.run(c.user, record.id)).rejects.toMatchObject({
          statusCode: 409,
        });
      } else {
        await c.service.run(c.user, record.id);
        expect((await c.service.claim(c.machine)).work?.id).toBe(record.id);
      }
    },
  );
  it.each(['run', 'claim', 'complete'] as const)(
    'fences accepted-ADR-only source edits at investigation %s',
    async (stage) => {
      const c = await fixture();
      const record = await c.proposal();
      if (stage !== 'run') await c.service.run(c.user, record.id);
      const claimed =
        stage === 'complete' ? await c.service.claim(c.machine) : undefined;
      if (claimed) expect(claimed.work?.id).toBe(record.id);
      await acceptSemanticChoice(
        c,
        'The human now selected another integration boundary; previous assumptions are stale.',
      );
      if (stage === 'run') {
        await expect(c.service.run(c.user, record.id)).rejects.toMatchObject({
          statusCode: 409,
        });
      } else if (stage === 'claim') {
        expect((await c.service.claim(c.machine)).work).toBeNull();
        expect((await c.service.get(c.user, record.id)).status).toBe(
          'interrupted',
        );
      } else {
        await expect(
          c.service.complete(c.machine, record.id, {
            leaseToken: claimed!.leaseToken!,
            generation: claimed!.work!.generation,
            result,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(
          (await c.service.get(c.user, record.id)).childArtifactId,
        ).toBeNull();
      }
    },
  );
  it('inserts an investigation immediately after its exact selected passage and seals that placement', async () => {
    const c = await fixture();
    const current = await c.store.updateArtifact(
      c.user,
      c.artifact.id,
      c.artifact.version,
      {
        ...c.artifact.content,
        doc: {
          type: 'doc',
          content: [
            paragraph('First passage'),
            paragraph('Target passage'),
            paragraph('Last passage'),
          ],
        },
      },
    );
    const placement = {
      blockIndex: 1,
      digest: hash(JSON.stringify(current.content.doc.content[1])),
    };
    const record = await c.service.propose(c.user, current.id, {
      version: current.version,
      brief: 'Measure this exact selected requirement',
      placement,
    });
    const saved = await c.store.artifact(current.id, c.user.id);
    expect(saved.content.doc.content.map((node: any) => node.type)).toEqual([
      'paragraph',
      'paragraph',
      'investigationCard',
      'paragraph',
    ]);
    expect(saved.content.doc.content[2].attrs.data.investigationId).toBe(
      record.id,
    );
    expect(saved.content.doc.content[3]).toEqual(
      current.content.doc.content[2],
    );
    const row = await c.store.one(
      'SELECT snapshot_json FROM studio_investigations WHERE id=?',
      record.id,
    );
    expect(JSON.parse(row.snapshot_json).sealed.placement).toEqual(placement);
    await c.service.run(c.user, record.id);
    expect((await c.service.get(c.user, record.id)).status).toBe('queued');
  });
  it('rejects stale, moved, missing and forged passage placement without appending a replacement card', async () => {
    const c = await fixture();
    const current = await c.store.updateArtifact(
      c.user,
      c.artifact.id,
      c.artifact.version,
      {
        ...c.artifact.content,
        doc: {
          type: 'doc',
          content: [
            paragraph('Target passage'),
            paragraph('Different passage'),
          ],
        },
      },
    );
    const digest = hash(JSON.stringify(current.content.doc.content[0]));
    for (const placement of [
      { blockIndex: 0, digest: '0'.repeat(64) },
      { blockIndex: 1, digest },
      { blockIndex: 9, digest },
    ]) {
      await expect(
        c.service.propose(c.user, current.id, {
          version: current.version,
          brief: 'Investigate stale selection',
          placement,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    }
    await expect(
      c.service.propose(c.user, current.id, {
        version: current.version - 1,
        brief: 'Old revision',
        placement: { blockIndex: 0, digest },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await c.store.artifact(current.id, c.user.id)).content).toEqual(
      current.content,
    );
    expect(
      (
        await c.store.one(
          'SELECT count(*) AS n FROM studio_investigations WHERE artifact_id=?',
          current.id,
        )
      ).n,
    ).toBe(0);
  });

  it('validates typed datasets and native view semantics without accepting executable UI or undeclared values', () => {
    expect(investigationResultSchema.parse(result).views).toHaveLength(3);
    expect(
      investigationResultSchema.safeParse({
        ...result,
        ui: '<script>execute()</script>',
      }).success,
    ).toBe(false);
    const bad = structuredClone(result);
    bad.datasets[0]!.rows[0]!.values.latency = 'claimed fast';
    expect(investigationResultSchema.safeParse(bad).success).toBe(false);
    const unknown = structuredClone(result);
    unknown.views[1]!.y = 'missing';
    expect(investigationResultSchema.safeParse(unknown).success).toBe(false);
    expect(() =>
      validateSelection(result.datasets[0]!, {
        rowIds: ['unknown'],
        filters: [],
      }),
    ).toThrow('unknown');
    expect(
      filteredRows(result.datasets[0]!, {
        rowIds: [],
        filters: [{ columnId: 'latency', operator: 'lte', value: 30 }],
      }).map((r) => r.id),
    ).toEqual(['candidate']);
  });
  it('runs only on the requesting owner machine and publishes a durable child/report once', async () => {
    const c = await fixture(),
      record = await c.proposal();
    await expect(c.service.run(c.other, record.id)).rejects.toThrow('Only');
    const otherMachine = { ...c.machine, user_id: c.other.id };
    await expect(c.service.claim(otherMachine)).rejects.toThrow('revoked');
    await c.service.run(c.user, record.id);
    const claimed = await c.service.claim(c.machine),
      input = {
        leaseToken: claimed.leaseToken!,
        generation: claimed.work!.generation,
        result,
      };
    const first = await c.service.complete(c.machine, record.id, input),
      second = await c.service.complete(c.machine, record.id, input);
    expect(second).toEqual(first);
    const published = await c.service.get(c.user, record.id),
      child = await c.store.artifact(first.childArtifactId, c.user.id);
    expect(published.status).toBe('completed');
    expect(published.resultHash).toBe(
      hash(JSON.stringify(investigationResultSchema.parse(result))),
    );
    expect(JSON.stringify(child.content)).toContain(sourceCommit);
    expect(
      JSON.stringify(
        (await c.store.artifact(c.artifact.id, c.user.id)).content,
      ),
    ).toContain('investigationCard');
    expect(
      (
        await c.store.one(
          'SELECT count(*) AS n FROM artifacts WHERE project_id=?',
          c.project.id,
        )
      ).n,
    ).toBe(3);
    await expect(
      c.service.propose(c.user, child.id, {
        version: child.version,
        brief: 'Nested investigation',
      }),
    ).rejects.toThrow('cannot start');
    await expect(c.service.assertCanDeleteArtifact(child.id)).rejects.toThrow(
      'archive',
    );
  });
  it('keeps shared selections revision-checked and attributed decisions immutable', async () => {
    const c = await fixture(),
      { record, input } = await running(c);
    await c.service.complete(c.machine, record.id, input);
    const selection = {
      rowIds: ['candidate'],
      filters: [{ columnId: 'latency', operator: 'lte' as const, value: 30 }],
    };
    await c.service.selection(c.other, record.id, 'bars', {
      revision: 1,
      selection,
    });
    await expect(
      c.service.selection(c.user, record.id, 'bars', {
        revision: 1,
        selection,
      }),
    ).rejects.toThrow('changed');
    await expect(
      c.service.decide(c.user, record.id, 'bars', {
        revision: 1,
        conclusion: 'Use candidate',
        rationale: 'Measured latency',
      }),
    ).rejects.toThrow('changed');
    const decision = await c.service.decide(c.other, record.id, 'bars', {
      revision: 2,
      conclusion: 'Use candidate',
      rationale:
        'The selected observation is lower, within the stated limitations.',
    });
    await c.service.selection(c.user, record.id, 'bars', {
      revision: 2,
      selection: { rowIds: [], filters: [] },
    });
    const after = await c.service.get(c.user, record.id);
    expect(after.decisions[0]).toEqual(decision);
    expect(after.decisions[0]!.selection.rowIds).toEqual(['candidate']);
    await expect(c.service.assertReady(c.artifact.id)).rejects.toThrow(
      'Required',
    );
    await c.service.acknowledgeFindings(c.other, record.id);
    await expect(
      c.service.assertReady(c.artifact.id),
    ).resolves.toBeUndefined();
  });
  it('preserves a live lease across service restart, then fences cancelled and expired attempts without replay', async () => {
    const c = await fixture(),
      { record, input } = await running(c);
    const restarted = new InvestigationService(c.service.dependencies);
    await restarted.ready;
    await expect(
      restarted.heartbeat(
        c.machine,
        record.id,
        input.leaseToken,
        input.generation,
      ),
    ).resolves.toEqual({ leaseActive: true });
    await restarted.transition(c.user, record.id, 'cancel');
    await expect(
      restarted.complete(c.machine, record.id, input),
    ).rejects.toThrow('lease ended');
    await restarted.transition(c.user, record.id, 'retry');
    await restarted.run(c.user, record.id);
    const next = await restarted.claim(c.machine);
    expect(next.work!.sourceCommit).toBe(sourceCommit);
    expect(next.work!.generation).toBeGreaterThan(input.generation);
    await c.store.exec(
      'UPDATE studio_investigations SET lease_expires=0 WHERE id=?',
      record.id,
    );
    await restarted.expire();
    expect((await restarted.get(c.user, record.id)).status).toBe(
      'interrupted',
    );
    expect((await restarted.claim(c.machine)).work).toBeNull();
  });
  it('checks implementation locks, source revisions, and fresh machine revocation at publication', async () => {
    const c = await fixture();
    c.setLocked(true);
    await expect(c.proposal()).rejects.toThrow('locked');
    c.setLocked(false);
    const { record, input } = await running(c);
    await c.store.updateArtifact(
      c.user,
      c.artifact.id,
      (await c.store.artifact(c.artifact.id, c.user.id)).version,
      {
        ...c.artifact.content,
        doc: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Changed source' }],
            },
          ],
        },
      },
    );
    await expect(
      c.service.complete(c.machine, record.id, input),
    ).rejects.toThrow('revision changed');
    await c.machines.revoke(c.user, c.project.id, c.machine.id);
    await expect(
      c.service.complete(c.machine, record.id, input),
    ).rejects.toThrow('revoked');
    expect(
      (
        await c.store.one(
          'SELECT count(*) AS n FROM artifacts WHERE project_id=?',
          c.project.id,
        )
      ).n,
    ).toBe(2);
  });
  it('rolls child publication back if the fenced SQL publication cannot finish and detects later result corruption', async () => {
    const c = await fixture(),
      { record, input } = await running(c);
    const original = c.store.audit.bind(c.store);
    c.store.audit = async (...args) => {
      if (args[3] === 'investigation.published')
        throw new Error('Explicit SQL publication rollback fixture');
      return original(...args);
    };
    await expect(
      c.service.complete(c.machine, record.id, input),
    ).rejects.toThrow('rollback fixture');
    expect((await c.service.get(c.user, record.id)).status).toBe('running');
    expect(
      (
        await c.store.one(
          'SELECT count(*) AS n FROM artifacts WHERE project_id=?',
          c.project.id,
        )
      ).n,
    ).toBe(2);
    c.store.audit = original;
    await c.service.complete(c.machine, record.id, input);
    await c.store.exec(
      'UPDATE studio_investigations SET result_json=? WHERE id=?',
      JSON.stringify({ ...result, report: 'Tampered evidence' }),
      record.id,
    );
    await expect(c.service.get(c.user, record.id)).rejects.toThrow(
      'integrity',
    );
  });
  it('starts bounded automatic prototypes only for explicit machine-owner consent and deduplicates a passage', async () => {
    const c = await fixture(),
      block = c.artifact.content.doc.content[1],
      input = {
        version: c.artifact.version,
        blockIndex: 1,
        digest: hash(JSON.stringify(block)),
      };
    expect(
      await c.service.considerSpike(c.user, c.artifact.id, input),
    ).toBeNull();
    expect(c.getJudgeCalls()).toBe(0);
    await c.service.consent(c.user, c.machine.id, true);
    const spike = await c.service.considerSpike(c.user, c.artifact.id, input);
    expect(spike).toMatchObject({
      status: 'queued',
      mode: 'spike',
      ownerId: c.user.id,
    });
    expect(
      await c.service.considerSpike(c.user, c.artifact.id, input),
    ).toBeNull();
    expect(
      await c.service.considerSpike(c.other, c.artifact.id, input),
    ).toBeNull();
    await c.service.consent(c.user, c.machine.id, false);
    expect((await c.service.get(c.user, spike!.id)).status).toBe('cancelled');
  });
});
