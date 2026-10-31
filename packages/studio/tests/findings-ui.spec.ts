import { ownedFreeGatewayMetadata } from './free-gateway-fixture.ts';
import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp, signInBrowser, provisionBrowserActor } from './browser-fixture.ts';
import type { User } from '../shared/domain.ts';
import { decisionProfileSchema } from '../shared/decision-profile.ts';
import type { FindingsProposal } from '../shared/findings-review.ts';
import type { FindingsReviews } from '../server/integrations/findings-review.ts';
const email = 'findings-owner@example.test',
  viewerEmail = 'findings-viewer@example.test';
const original =
  'Compare the two queue implementations before choosing the production boundary.';
let studio: Awaited<ReturnType<typeof createApp>> & {
    findings: FindingsReviews;
  },
  directory: string,
  origin: string,
  id: string,
  investigationId: string,
  owner: User;
let provider: ReturnType<typeof createServer>;
const previousKey = process.env.AI_GATEWAY_API_KEY,
  requests: any[] = [],
  faults: string[] = [];
const proposal: FindingsProposal = {
  summary:
    'Retain the measured improvement and its local limitation, then ask a human to choose the production boundary.',
  edits: [
    {
      blockId: randomUUID(),
      original,
      replacement:
        'Local fixture measurements found B at 22 ms and A at 41 ms. Production latency remains unverified.',
      evidence: 'B at 22 ms and A at 41 ms',
    },
  ],
  questions: [
    {
      question: 'Which production queue boundary should the team choose?',
      options: ['Variant A', 'Variant B'],
      context:
        'The local measurement informs the choice; it does not authorize it.',
    },
  ],
};
test.beforeAll(async ({ browser }) => {
  provider = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push({
      path: req.url,
      body,
      model: req.headers['ai-language-model-id'],
    });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/native/decisions') {
      res.end(
        JSON.stringify({
          model: body.model,
          answers: body.questions.map((question: any) => ({
            name: question.name,
            type: 'predicate',
            probability: 0.95,
          })),
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify(proposal) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
        warnings: [],
      }),
    );
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  process.env.AI_GATEWAY_API_KEY = 'explicit-local-findings-browser-fixture';
  const endpoint = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  directory = await mkdtemp(join(tmpdir(), 'studio-findings-ui-'));
  const settings = {
    origin: 'http://127.0.0.1:8894',
    dataDir: directory,
    production: false,
    demo: false,
    adminEmail: email,
    model: 'fixture/author',
    integrations: { gatewayBaseUrl: endpoint, gatewayMetadataFetch: ownedFreeGatewayMetadata() },
  };
  studio = (await createApp(settings, {
    db: ':memory:',
    clientDir: resolve(import.meta.dirname, '../dist/client'),
    decisionSettings: {
      production: false,
      timeoutMs: 10000,
      defaultProfile: decisionProfileSchema.parse({
        provider: 'openai-decisions',
        model: 'fixture/decision',
      }),
      openai: {
        baseUrl: endpoint + '/native',
        apiKey: 'native-findings-browser-fixture',
        models: ['fixture/decision'],
      },
    },
  })) as typeof studio;
  await studio.app.listen({ host: '127.0.0.1', port: 0 });
  origin = studio.app.listeningOrigin;
  settings.origin = origin;
  owner = await provisionBrowserActor(browser, origin, email);
  const project = await studio.store.createProject(
      owner,
      'Evidence-grounded queue design',
      '',
      'https://github.com/example/findings-browser',
    );
  id = project.mainArtifactId;
  const viewer = await provisionBrowserActor(browser, origin, viewerEmail);
  await studio.store.exec(
    'INSERT INTO memberships VALUES(?,?,?)',
    project.id,
    viewer.id,
    'viewer',
  );
  await studio.agent.profiles.view(owner, id, {
    harness: 'vercel-fx',
    provider: 'ai-gateway',
    model: 'fixture/author',
  });
  await studio.collab.replace(
    id,
    owner,
    {
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { id: proposal.edits[0]!.blockId },
            content: [{ type: 'text', text: original }],
          },
        ],
      },
    },
    (await studio.store.artifact(id, owner.id)).version,
  );
  const machines = studio.integrations.machines,
    paired = await machines.pair(
      (
        await machines.pairing(
          owner,
          project.id,
          'Explicit browser workstation fixture',
        )
      ).code,
    ),
    machine = await studio.store.one(
      'SELECT * FROM studio_machines WHERE id=?',
      paired.id,
    );
  await studio.investigations.registerCheckout(machine, {
    repository: 'https://github.com/example/findings-browser',
    sourceCommit: 'a'.repeat(40),
    branch: 'main',
  });
  const record = await studio.investigations.propose(owner, id, {
    version: (await studio.store.artifact(id, owner.id)).version,
    brief: 'Measure the queue alternatives in a bounded local fixture',
    requiredReason:
      'Review the measurement before choosing the production boundary',
  });
  investigationId = record.id;
  await studio.investigations.run(owner, record.id);
  const claim = await studio.investigations.claim(machine);
  await studio.investigations.complete(machine, record.id, {
    leaseToken: claim.leaseToken!,
    generation: claim.work!.generation,
    result: {
      title: 'Local queue measurement',
      report: 'The fixture measured B at 22 ms and A at 41 ms.',
      method: 'Twenty synthetic requests on a local workstation fixture.',
      limitations:
        'These fixture observations do not establish production latency.',
      datasets: [],
      views: [],
      evidence: [{ name: 'Fixture output', text: 'A: 41 ms; B: 22 ms' }],
      images: [],
    },
  });
  await studio.agent.claimPlanner(owner, id);
});
test.afterAll(async () => {
  await studio?.app.close();
  provider?.closeAllConnections();
  if (provider)
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
  if (previousKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
  else process.env.AI_GATEWAY_API_KEY = previousKey;
});
async function login(page: Page, selected = email) {
  page.on('pageerror', (error) => faults.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 500)
      faults.push(response.status() + ' ' + response.url());
  });
  await signInBrowser(page, origin, selected);
  await page.goto(origin);
  await page
    .getByRole('button', { name: 'Investigations', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Apply investigation findings' }).first(),
  ).toBeVisible();
}
async function capture(page: Page, name: string) {
  const target = process.env.STUDIO_CAPTURE_DIR;
  if (!target) return;
  await mkdir(target, { recursive: true });
  await page.screenshot({
    path: join(target, name + '.png'),
    fullPage: true,
    animations: 'disabled',
  });
}
test('actual App reviews findings through native decision and frozen harness, then a person applies an exact edit while questionnaire readiness remains blocked', async ({
  page,
  browser,
}) => {
  await login(page);
  const panel = page.getByRole('region', {
    name: 'Apply investigation findings',
  });
  await panel
    .getByRole('button', { name: 'Ask Planner to apply findings' })
    .click();
  await expect(
    panel.getByText(proposal.summary, { exact: true }),
  ).toBeVisible();
  const apply = panel.getByRole('button', { name: 'Apply reviewed findings' });
  await expect(apply).toBeDisabled();
  const before = await studio.store.artifact(id, owner.id);
  expect(JSON.stringify(before.content)).not.toContain(
    proposal.edits[0]!.replacement,
  );
  expect(
    (await studio.investigations.get(owner, investigationId)).requiredReason,
  ).toBeTruthy();
  expect(
    requests.filter((request) => request.path === '/native/decisions'),
  ).toHaveLength(1);
  expect(
    requests.find((request) => request.model === 'fixture/author'),
  ).toBeTruthy();
  await capture(page, 'findings-human-review');
  await panel.getByRole('checkbox').check();
  await apply.click();
  await expect(
    panel.getByText('Applied by a person', { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      JSON.stringify((await studio.store.artifact(id, owner.id)).content),
    )
    .toContain(proposal.edits[0]!.replacement);
  expect(
    (await studio.investigations.get(owner, investigationId)).requiredReason,
  ).toBeNull();
  await capture(page, 'findings-applied');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(
    page
      .locator('.tiptap')
      .getByText(proposal.edits[0]!.replacement, { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator('.tiptap')
      .getByRole('heading', {
        name: proposal.questions[0]!.question,
        exact: true,
      }),
  ).toBeVisible();
  const after = await studio.store.artifact(id, owner.id);
  expect(after.version).toBe(before.version + 1);
  const readiness = await page.request.get(
    origin + `/api/artifacts/${id}/implementation/readiness`,
  );
  expect(readiness.status()).toBe(200);
  expect(JSON.stringify(await readiness.json())).toContain('questionnaire');
  await expect(
    page
      .locator('.tiptap')
      .getByText(
        'Review the measurement before choosing the production boundary',
        { exact: true },
      ),
  ).toHaveCount(0);
  await capture(page, 'findings-live-document');
  const context = await browser.newContext(),
    viewer = await context.newPage();
  await login(viewer, viewerEmail);
  const readOnly = viewer.getByRole('region', {
    name: 'Apply investigation findings',
  });
  await expect(
    readOnly.getByText('Applied by a person', { exact: true }),
  ).toBeVisible();
  await expect(
    readOnly.getByRole('button', { name: 'Ask Planner to apply findings' }),
  ).toHaveCount(0);
  const denied = await viewer.request.post(
    origin + `/api/investigations/${investigationId}/findings`,
    { headers: { origin }, data: { requestId: randomUUID() } },
  );
  expect(denied.status()).toBe(403);
  await viewer.reload();
  await viewer
    .getByRole('button', { name: 'Investigations', exact: true })
    .click();
  await expect(
    viewer
      .getByRole('region', { name: 'Apply investigation findings' })
      .getByText('Applied by a person', { exact: true }),
  ).toBeVisible();
  await context.close();
  expect(faults).toEqual([]);
});
test('a person can incorporate text-only evidence with an explicit rationale and no model call or source rewrite', async ({
  page,
}) => {
  const artifact = await studio.store.artifact(id, owner.id),
    machine = await studio.store.one(
      'SELECT * FROM studio_machines WHERE project_id=? AND user_id=?',
      artifact.projectId,
      owner.id,
    );
  const record = await studio.investigations.propose(owner, id, {
    version: artifact.version,
    brief: 'Already-covered observation needs human incorporation',
    requiredReason:
      'Explain why this measured evidence requires no further source edit',
  });
  await studio.investigations.run(owner, record.id);
  const claim = await studio.investigations.claim(machine);
  await studio.investigations.complete(machine, record.id, {
    leaseToken: claim.leaseToken!,
    generation: claim.work!.generation,
    result: {
      title: 'Text-only local observation',
      report: 'The current plan already retains the measured limitation.',
      method: 'Read and compare the saved local measurement.',
      limitations:
        'This is a local protocol fixture, not live production acceptance.',
      datasets: [],
      views: [],
      evidence: [],
      images: [],
    },
  });
  const before = await studio.store.artifact(id, owner.id),
    requestCount = requests.length;
  await login(page);
  const card = page.locator('.inv-card').filter({
      hasText: 'Already-covered observation needs human incorporation',
    }),
    panel = card.getByRole('region', { name: 'Apply investigation findings' });
  await panel
    .getByText('Incorporate findings manually', { exact: true })
    .click();
  const submit = panel.getByRole('button', {
    name: 'Record human incorporation',
  });
  await expect(submit).toBeDisabled();
  const rationale =
    'The plan already records this exact local measurement and its limitation; no additional source edit or production claim is justified.';
  await panel
    .getByLabel('How were these findings incorporated?')
    .fill(rationale);
  await panel
    .getByRole('checkbox', {
      name: 'I reviewed the current evidence and plan and take responsibility for this acknowledgement.',
    })
    .check();
  await submit.click();
  await expect(
    panel.getByText('Incorporated by ' + owner.name, { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText(rationale, { exact: true })).toBeVisible();
  expect(await studio.store.artifact(id, owner.id)).toEqual(before);
  expect(requests).toHaveLength(requestCount);
  expect(
    (await studio.investigations.get(owner, record.id)).requiredReason,
  ).toBeNull();
  await capture(page, 'findings-human-incorporation');
  expect(faults).toEqual([]);
});
