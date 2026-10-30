import { ownedFreeGatewayMetadata } from './free-gateway-fixture.ts';
import { test, expect, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp, signInBrowser } from './browser-fixture.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { ImplementationSnapshot } from '../shared/implementation.ts';

const origin = 'http://127.0.0.1:8896';
let studio: Awaited<ReturnType<typeof createApp>>,
  directory: string,
  id: string;
let modelServer: ReturnType<typeof createServer>;
const originalGatewayKey = process.env.AI_GATEWAY_API_KEY;
const modelRequests: {
  path: string;
  body: unknown;
  idempotencyKey?: string;
}[] = [];
const modelDefinition = {
  tasks: [
    {
      id: 'model-boundary',
      title: 'Model drafted boundary review',
      description:
        'Review the existing artifact boundary described by this plan.',
      acceptanceCriteria: [
        'The plan boundary is recorded with explicit evidence.',
      ],
    },
  ],
  edges: [],
};
const serverFaults: string[] = [];
const watchedPages = new WeakSet<Page>();
const ownerEmail = 'build-owner@example.test',
  reviewerEmail = 'build-reviewer@example.test';
test.beforeAll(async () => {
  modelServer = createServer(async (request, response) => {
    let source = '';
    for await (const chunk of request) source += chunk;
    modelRequests.push({
      path: request.url ?? '',
      body: source ? JSON.parse(source) : null,
      idempotencyKey: request.headers['idempotency-key'] as string | undefined,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify(modelDefinition) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 20, text: 20, reasoning: 0 },
        },
        warnings: [],
      }),
    );
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  process.env.AI_GATEWAY_API_KEY = 'explicit-local-protocol-fixture-only';
  directory = await mkdtemp('/tmp/studio-build-browser-');
  studio = await createApp(
    {
      origin,
      production: false,
      demo: false,
      dataDir: directory,
      adminEmail: ownerEmail,
      model: 'fixture/model',
      integrations: {
        gatewayBaseUrl: `http://127.0.0.1:${(modelServer.address() as { port: number }).port}`,
        gatewayMetadataFetch: ownedFreeGatewayMetadata(),
      },
    },
    {
      db: ':memory:',
      clientDir: resolve(import.meta.dirname, '../dist/client'),
    },
  );
  const owner = await studio.store.userByEmail(ownerEmail),
    project = await studio.store.createProject(
      owner,
      'Implementation UI acceptance',
      'A synthetic dependency graph workflow.',
      'https://github.com/example/build-fixture',
    );
  id = project.mainArtifactId;
  const reviewer = await studio.store.createUser(
    reviewerEmail,
    'Independent reviewer',
    null,
  );
  await studio.store.exec(
    'INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?)',
    project.id,
    reviewer.id,
    'editor',
  );
  await studio.app.listen({ host: '127.0.0.1', port: 8896 });
});
test.afterAll(async () => {
  await studio?.app.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  if (modelServer) {
    modelServer.closeAllConnections();
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
  if (originalGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
  else process.env.AI_GATEWAY_API_KEY = originalGatewayKey;
});

async function login(page: Page, email = ownerEmail) {
  if (!watchedPages.has(page)) {
    watchedPages.add(page);
    page.on('response', (response) => {
      if (response.status() === 500) serverFaults.push(response.url());
    });
    page.on('pageerror', (error) =>
      serverFaults.push('Browser exception: ' + error.message),
    );
  }
  await page.goto(origin);
  await signInBrowser(page, origin, email);
  await page.goto(origin);
  await expect(
    page.getByRole('button', { name: 'Build plan', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Build plan', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Implementation plan', exact: true }),
  ).toBeVisible();
}
async function snapshot(page: Page): Promise<ImplementationSnapshot> {
  return (
    await page.request.get(origin + `/api/artifacts/${id}/implementation`)
  ).json();
}
async function capture(page: Page, name: string) {
  await mkdir(resolve(import.meta.dirname, '../../../work/review'), {
    recursive: true,
  });
  await page.getByRole('dialog').evaluate((element) => element.scrollTo(0, 0));
  await expect(page.locator('.implementation-error')).toHaveCount(0);
  expect(serverFaults).toEqual([]);
  await page.screenshot({
    path: resolve(import.meta.dirname, `../../../work/review/${name}.png`),
    fullPage: true,
  });
}

// This test executes application transitions. Its evidence text is explicitly synthetic;
// no test claim implies a real code change, GitHub PR or external implementation occurred.
test('Build plan authors a real DAG through forms, approves an exact version, reports blockers/no-change work and requires independent criterion review', async ({
  page,
  browser,
}) => {
  await login(page);
  const panel = page.getByRole('region', {
    name: 'Implementation plan',
    exact: true,
  });
  await panel
    .getByRole('button', { name: 'Create task graph', exact: true })
    .click();
  await panel
    .getByLabel('Task 1 title', { exact: true })
    .fill('Review boundary contract');
  await panel
    .getByLabel('Task 1 description', { exact: true })
    .fill('Inspect the existing fixture boundary before the consumer.');
  await panel
    .getByLabel('Task 1 acceptance criteria (one per line)', { exact: true })
    .fill('The fixture boundary is present\nFailure states are documented');
  await panel.getByRole('button', { name: 'Add task', exact: true }).click();
  await panel
    .getByLabel('Task 2 title', { exact: true })
    .fill('Review dependent consumer');
  await panel
    .getByLabel('Task 2 description', { exact: true })
    .fill('Review the fixture consumer after its prerequisite.');
  await panel
    .getByLabel('Task 2 acceptance criteria (one per line)', { exact: true })
    .fill('The consumer uses the existing boundary');
  await panel
    .getByLabel('Prerequisite task', { exact: true })
    .selectOption('task-1');
  await panel
    .getByLabel('Dependent task', { exact: true })
    .selectOption('task-2');
  await panel
    .getByRole('button', { name: 'Add dependency', exact: true })
    .click();
  await panel
    .getByRole('button', { name: 'Save graph draft', exact: true })
    .click();
  await expect(
    panel.getByRole('heading', { name: 'Graph version 1', exact: true }),
  ).toBeVisible();
  const draft = await snapshot(page);
  expect(draft.graph?.definition.edges).toEqual([
    { from: 'task-1', to: 'task-2' },
  ]);
  expect(draft.graph?.definition.tasks[0].acceptanceCriteria).toHaveLength(2);
  await capture(page, 'studio-implementation-draft');
  await panel
    .getByRole('button', { name: 'Approve graph 1 · draft 1', exact: true })
    .click();
  await expect(
    panel.getByRole('button', {
      name: 'Build on my connected machine',
      exact: true,
    }),
  ).toBeVisible();
  expect((await snapshot(page)).graph?.approvedBy?.kind).toBe('human');
  await panel.getByText('Claim an external checkout', { exact: true }).click();
  await panel
    .getByLabel('Checkout branch', { exact: true })
    .fill('fixture/implementation-ui');
  await panel
    .getByLabel('Checkout commit', { exact: true })
    .fill('a'.repeat(40));
  await panel
    .getByRole('button', { name: 'Claim exact graph', exact: true })
    .click();
  await expect(panel.getByText(/Source editing is locked by/)).toBeVisible();
  const first = panel.getByRole('article', {
      name: 'Task Review boundary contract',
      exact: true,
    }),
    second = panel.getByRole('article', {
      name: 'Task Review dependent consumer',
      exact: true,
    });
  await expect(
    second.getByRole('button', { name: 'Start task', exact: true }),
  ).toBeDisabled();
  await second.getByText('Report task progress', { exact: true }).click();
  await second
    .getByLabel('Blocker reason', { exact: true })
    .fill('Waiting for the prerequisite fixture review.');
  await second
    .getByRole('button', { name: 'Save progress report', exact: true })
    .click();
  await expect(
    second.getByText('Blocked: Waiting for the prerequisite fixture review.', {
      exact: true,
    }),
  ).toBeVisible();
  const source = (
    await (await page.request.get(origin + `/api/artifacts/${id}`)).json()
  ).artifact;
  const denied = await page.request.patch(origin + `/api/artifacts/${id}`, {
    headers: { origin },
    data: { version: source.version, content: source.content },
  });
  expect(denied.status()).toBe(409);
  expect(await denied.text()).toContain('implementation-locked');
  await capture(page, 'studio-implementation-locked');
  for (const task of [first, second]) {
    await task.getByRole('button', { name: 'Start task', exact: true }).click();
    const details = task.locator('details');
    if ((await details.getAttribute('open')) === null)
      await task.getByText('Report task progress', { exact: true }).click();
    await task.getByLabel(/Report for task-/).selectOption('complete');
    await task
      .getByLabel('Completion summary', { exact: true })
      .fill('Synthetic browser fixture review complete.');
    await task.getByLabel('No code change needed', { exact: true }).check();
    await task
      .getByLabel('No-change reason', { exact: true })
      .fill('This acceptance fixture describes existing application behavior.');
    await task
      .getByLabel('No-change evidence', { exact: true })
      .fill(
        'Executed the actual application form and source-lock assertions in this Playwright fixture.',
      );
    await task
      .getByRole('button', { name: 'Save progress report', exact: true })
      .click();
    await expect(
      task.getByText('No change needed', { exact: true }),
    ).toBeVisible();
  }
  await panel
    .getByText('Independent whole-graph review', { exact: true })
    .click();
  for (const [taskId, index] of [
    ['task-1', 1],
    ['task-1', 2],
    ['task-2', 1],
  ] as const) {
    await panel
      .getByLabel(`Review outcome ${taskId} ${index}`, { exact: true })
      .selectOption('pass');
    await panel
      .getByLabel(`Review evidence ${taskId} ${index}`, { exact: true })
      .fill(
        'Synthetic reviewer checked the real fixture transition and retained evidence.',
      );
  }
  await panel
    .getByLabel('Whole-graph review summary', { exact: true })
    .fill('Self-review should be rejected.');
  await panel
    .getByRole('button', { name: 'Submit independent review', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toContainText(
    'independent authenticated reviewer',
  );
  expect((await snapshot(page)).activeRun?.status).toBe('running');
  const context = await browser.newContext();
  const reviewer = await context.newPage();
  await login(reviewer, reviewerEmail);
  const reviewPanel = reviewer.getByRole('region', {
    name: 'Implementation plan',
    exact: true,
  });
  await reviewPanel
    .getByText('Independent whole-graph review', { exact: true })
    .click();
  await expect(
    reviewPanel.getByRole('button', {
      name: 'Submit independent review',
      exact: true,
    }),
  ).toBeDisabled();
  await reviewPanel
    .getByLabel('Whole-graph review summary', { exact: true })
    .fill('Independent synthetic acceptance review of every task criterion.');
  for (const [taskId, index] of [
    ['task-1', 1],
    ['task-1', 2],
    ['task-2', 1],
  ] as const) {
    await reviewPanel
      .getByLabel(`Review outcome ${taskId} ${index}`, { exact: true })
      .selectOption('pass');
    await reviewPanel
      .getByLabel(`Review evidence ${taskId} ${index}`, { exact: true })
      .fill(
        'Independently inspected the retained local browser acceptance fixture evidence.',
      );
  }
  await reviewPanel
    .getByRole('button', { name: 'Submit independent review', exact: true })
    .click();
  await expect(
    reviewPanel.getByText('Independent review passed', { exact: true }),
  ).toBeVisible();
  const verified = await snapshot(reviewer);
  expect(verified.activeRun).toBeNull();
  expect(verified.editingLock).toBeNull();
  expect(verified.runs[0].status).toBe('implemented');
  expect(verified.runs[0].verification?.reviewedBy.name).toBe(
    'Independent reviewer',
  );
  await capture(reviewer, 'studio-implementation-independent-review');
  await context.close();
});

test('Planner drafting invokes the actual HTTP model transport and publishes an unapproved source-fenced graph', async ({
  page,
}) => {
  await login(page);
  const panel = page.getByRole('region', {
    name: 'Implementation plan',
    exact: true,
  });
  const before = await snapshot(page),
    calls = modelRequests.length;
  await panel.getByText('Planner runtime', { exact: true }).click();
  await expect(panel.getByLabel('Agent harness', { exact: true })).toHaveValue(
    't3-code',
  );
  expect(modelRequests.length).toBe(calls);
  await panel
    .getByLabel('Agent harness', { exact: true })
    .selectOption('vercel-fx');
  await panel
    .getByRole('button', { name: 'Save agent runtime', exact: true })
    .click();
  await expect(
    panel.getByText('Agent runtime saved.', { exact: true }),
  ).toBeVisible();
  const selected = await (
    await page.request.get(origin + `/api/artifacts/${id}/agent/profile`)
  ).json();
  expect(selected.profile).toEqual({
    harness: 'vercel-fx',
    provider: 'ai-gateway',
    model: 'fixture/model',
  });
  await panel.getByText('Planner runtime', { exact: true }).click();
  await panel
    .getByRole('button', { name: 'Draft tasks with Planner', exact: true })
    .click();
  await expect
    .poll(async () => (await snapshot(page)).graph?.definition.tasks[0].id)
    .toBe('model-boundary');
  await panel
    .getByRole('button', { name: 'Refresh build', exact: true })
    .click();
  await expect(
    panel.getByRole('article', {
      name: 'Task Model drafted boundary review',
      exact: true,
    }),
  ).toBeVisible();
  const state = await snapshot(page);
  expect(state.graph?.status).toBe('draft');
  expect(state.graph?.planRevision).toBe(state.planRevision);
  expect(state.graph?.graphVersion).toBe((before.graph?.graphVersion ?? 0) + 1);
  expect(state.graph?.approvedBy).toBeUndefined();
  expect(state.activeRun).toBeNull();
  await expect(
    page.getByRole('button', {
      name: 'Build plan',
      exact: true,
      includeHidden: true,
    }),
  ).toHaveText('Review task graph');
  expect(modelRequests.length).toBe(calls + 1);
  expect(JSON.stringify(modelRequests.at(-1)?.body)).toContain(
    'Implementation UI acceptance',
  );
  expect(JSON.stringify(modelRequests.at(-1)?.body)).toContain('task DAG');
  const jobs = await (
    await page.request.get(origin + `/api/artifacts/${id}/implementation/draft`)
  ).json();
  expect(jobs.jobs[0].status).toBe('completed');
  await capture(page, 'studio-implementation-model-draft');
});
