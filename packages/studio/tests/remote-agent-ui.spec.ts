import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp, signInBrowser } from './browser-fixture.ts';
import {
  connectRemotePlanner,
  type RemotePlannerClientContext,
} from '../server/machine/planner-client.ts';
import { paragraph } from '../shared/domain.ts';
const origin = 'http://127.0.0.1:8896',
  email = 'remote-owner@example.test',
  viewerEmail = 'remote-viewer@example.test';
let studio: Awaited<ReturnType<typeof createApp>>, directory: string;
const clients: { controller: AbortController; promise: Promise<void> }[] = [];
const faults: string[] = [];
test.beforeEach(async () => {
  faults.length = 0;
  directory = await mkdtemp('/tmp/studio-remote-browser-');
  studio = await createApp(
    {
      origin,
      production: false,
      demo: false,
      dataDir: directory,
      adminEmail: email,
      integrations: { remotePlanner: true },
    },
    {
      db: ':memory:',
      clientDir: resolve(import.meta.dirname, '../dist/client'),
    },
  );
  await studio.app.listen({ host: '127.0.0.1', port: 8896 });
});
test.afterEach(async () => {
  for (const c of clients.splice(0)) {
    c.controller.abort();
    await c.promise.catch(() => {});
  }
  await studio?.app.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
function observe(page: Page) {
  page.on('pageerror', (e) => faults.push(e.message));
  page.on('response', (r) => {
    if (r.status() >= 500) faults.push(`${r.status()} ${r.url()}`);
  });
}
async function login(page: Page, who = email) {
  observe(page);
  await signInBrowser(page, origin, who);
}
async function open(page: Page, title: string) {
  await login(page);
  const created = await page.request.post(origin + '/api/projects', {
    headers: { origin },
    data: {
      title,
      description:
        'Explicit local protocol fixture; no external provider is claimed.',
      repository: '',
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const project = await created.json(),
    initialArtifact = await studio.store.artifact(
      project.mainArtifactId,
      (await studio.store.userByEmail(email)).id,
    ),
    threadId = (await studio.store.threads(initialArtifact.id))[0]!.id;
  const user = await studio.store.userByEmail(email);
  const content = structuredClone(initialArtifact.content);
  content.doc.content = [
    {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'Reliable integration previews' }],
    },
    paragraph(
      'Keep the payment preview available while provider access is unavailable. Use consumer contracts at the boundary and attach visual evidence to this design.',
    ),
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Acceptance criteria' }],
    },
    paragraph(
      'Given the provider is unavailable, when a teammate opens preview, then the agreed consumer contract keeps the interface usable.',
    ),
    paragraph(
      'Given a boundary decision changes, preserve its artifact conversation, ADR, review state and evidence links together.',
    ),
  ];
  const source = await page.request.patch(
    origin + `/api/artifacts/${initialArtifact.id}`,
    {
      headers: { origin },
      data: { version: initialArtifact.version, content },
    },
  );
  expect(source.ok(), await source.text()).toBe(true);
  const artifact = await studio.store.artifact(initialArtifact.id, user.id);
  const selected = await page.request.put(
    origin + `/api/artifacts/${artifact.id}/agent/profile`,
    {
      headers: { origin },
      data: {
        harness: 'remote-planner',
        provider: 'operator-acp',
        model: 'remote',
      },
    },
  );
  expect(selected.ok(), await selected.text()).toBe(true);
  const minted = await page.request.post(origin + '/api/tokens', {
    headers: { origin },
  });
  expect(minted.ok()).toBe(true);
  const { token } = await minted.json();
  await page.goto(origin + `/?project=${project.id}&artifact=${artifact.id}`);
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  return { project, artifact, threadId, token, user };
}
async function start(
  page: Page,
  w: Awaited<ReturnType<typeof open>>,
  run: (
    ctx: RemotePlannerClientContext,
    signal: AbortSignal,
  ) => Promise<{ text: string; content: null }>,
) {
  const controller = new AbortController();
  let ready = false;
  const promise = connectRemotePlanner({
    origin,
    artifactId: w.artifact.id,
    token: w.token,
    signal: controller.signal,
    onAttached: () => {
      ready = true;
    },
    run: (_turn, signal, ctx) => run(ctx, signal),
  });
  clients.push({ controller, promise });
  await expect.poll(() => ready).toBe(true);
  const response = await page.request.post(
    origin + `/api/artifacts/${w.artifact.id}/agent`,
    { headers: { origin }, data: { threadId: w.threadId, intent: 'chat' } },
  );
  expect(response.ok(), await response.text()).toBe(true);
  const job = await response.json();
  return { job, controller, promise };
}
async function activity(page: Page, id: string) {
  return (
    await page.request.get(origin + `/api/artifacts/${id}/planner/activity`)
  ).json();
}
async function capture(page: Page, name: string, focus = true) {
  if (focus)
    await page.locator('.remote-activity').evaluate((element) => {
      const body = element.closest('.detail-body');
      if (body)
        body.scrollTop +=
          element.getBoundingClientRect().top -
          body.getBoundingClientRect().top;
    });
  expect(faults).toEqual([]);
  await expect(
    page.locator(
      '.error-banner,.account-planner-error,.remote-activity [role=alert]',
    ),
  ).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await mkdir(
    resolve(import.meta.dirname, '../../../docs/studio-evidence/remote-agents'),
    { recursive: true },
  );
  await page.screenshot({
    path: resolve(
      import.meta.dirname,
      `../../../docs/studio-evidence/remote-agents/${name}.png`,
    ),
    fullPage: true,
    animations: 'disabled',
  });
}

test('actual remote stream and all typed questions persist through refresh, acknowledged pause and artifact export', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 1100 });
  const w = await open(page, 'Remote boundary review');
  const answers: unknown[] = [];
  const run = await start(page, w, async (ctx) => {
    const now = Math.floor(Date.now() / 1000);
    await ctx.sendPart({
      type: 'stream-start',
      modelId: 'explicit-local-protocol-fixture',
    });
    await ctx.sendPart({ type: 'text-start', id: 'intro' });
    await ctx.sendPart({
      type: 'text-delta',
      id: 'intro',
      delta:
        'Reviewing **the integration boundary** against the captured design. Your answers stay attached to this artifact.',
    });
    await ctx.sendPart({ type: 'text-end', id: 'intro' });
    const card = {
      id: 'boundary',
      name: 'Boundary review',
      status: 'running' as const,
      started: now,
      updated: now,
      waiting: 5,
      stages: [
        {
          id: 'source',
          name: 'Read captured source',
          status: 'completed' as const,
        },
        {
          id: 'questions',
          name: 'Confirm the boundary',
          status: 'awaiting_input' as const,
          parentIds: ['source'],
        },
        {
          id: 'summary',
          name: 'Record the recommendation',
          status: 'pending' as const,
          parentIds: ['questions'],
        },
      ],
    };
    await ctx.reportRuns({ active: ['boundary'], paused: [], cards: [card] });
    ctx.onControl(async (control) => {
      await ctx.reportRuns({
        active: ['boundary'],
        paused: control.action === 'pause' ? ['boundary'] : [],
        cards: [
          {
            ...card,
            status: control.action === 'pause' ? 'paused' : 'running',
            updated: Math.floor(Date.now() / 1000),
            stages: [],
          },
        ],
      });
      return {
        ok: true,
        message: 'Explicit fixture runtime applied the control.',
      };
    });
    const scope = { runId: 'boundary', stageId: 'questions' };
    answers.push(
      ...(await Promise.all([
        ctx.ask(
          'confirm',
          {
            method: 'confirm',
            title: 'Keep the existing boundary?',
            message:
              'Confirming guides this response; it does not approve an implementation.',
          },
          scope,
        ),
        ctx.ask(
          'questionnaire',
          {
            method: 'questionnaire',
            params: {
              questions: [
                {
                  header: 'Strategy',
                  question: 'Which boundary strategy?',
                  options: [
                    {
                      label: 'Consumer contracts',
                      description:
                        'Develop without waiting for live integrations.',
                      preview:
                        'Given the integration is unavailable\nWhen the contract is exercised\nThen the preview remains usable',
                    },
                    {
                      label: 'Live integration',
                      description: 'Use an explicitly configured endpoint.',
                    },
                  ],
                },
                {
                  header: 'Evidence',
                  question: 'Which evidence matters?',
                  multiSelect: true,
                  options: [
                    {
                      label: 'Visual evidence',
                      description: 'Capture the browser state.',
                    },
                    {
                      label: 'Contract checks',
                      description: 'Verify the boundary.',
                    },
                  ],
                },
              ],
            },
          },
          scope,
        ),
        ctx.ask(
          'select',
          {
            method: 'select',
            title: 'Choose the review target',
            choices: ['Preview', 'Production'],
          },
          scope,
        ),
        ctx.ask(
          'input',
          {
            method: 'input',
            title: 'Name the integration boundary',
            placeholder: 'A concise boundary name',
          },
          scope,
        ),
        ctx.ask(
          'editor',
          {
            method: 'editor',
            title: 'Review the acceptance note',
            initial:
              'Keep live preview independent from unavailable integrations.',
          },
          scope,
        ),
      ])),
    );
    await ctx.reportRuns({
      active: [],
      paused: [],
      cards: [
        {
          ...card,
          status: 'finished',
          ended: Math.floor(Date.now() / 1000),
          updated: Math.floor(Date.now() / 1000),
          waiting: 0,
          stages: card.stages.map((s) => ({ ...s, status: 'completed' })),
        },
      ],
    });
    return {
      text: 'The boundary review is recorded. Consumer contracts keep preview usable while visual evidence and contract checks verify the integration.',
      content: null,
    };
  });
  const region = page.getByRole('region', { name: 'Remote agent activity' });
  await expect(region).toBeVisible();
  await expect(
    region.getByText('the integration boundary', { exact: true }),
  ).toBeVisible();
  await expect(
    region.getByRole('region', { name: 'Keep the existing boundary?' }),
  ).toBeVisible();
  await region.getByRole('button', { name: 'Pause run', exact: true }).click();
  await expect(
    region.getByText('Pause accepted', { exact: true }),
  ).toBeVisible();
  await capture(page, 'remote-stream-and-run');
  await region.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => answers.length).toBe(0);
  const questionnaire = region.getByRole('region', {
    name: 'Questions from your agent',
  });
  await questionnaire
    .getByRole('radio', { name: 'Consumer contracts', exact: false })
    .check();
  await questionnaire
    .getByRole('button', { name: 'Save answer 1', exact: true })
    .click();
  await expect(
    questionnaire.getByText('Saved answer: Consumer contracts', {
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await expect(
    page.getByText('Saved answer: Consumer contracts', { exact: true }),
  ).toBeVisible();
  const refreshed = page.getByRole('region', { name: 'Remote agent activity' });
  const written = refreshed.getByRole('textbox', {
    name: 'Written answer for Which boundary strategy?',
    exact: true,
  });
  await written.fill('Keep provider contracts as the boundary.');
  await refreshed
    .getByRole('button', { name: 'Save answer 1', exact: true })
    .click();
  await expect(
    refreshed.getByText(
      'Saved answer: Keep provider contracts as the boundary.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await expect(written).toHaveValue('Keep provider contracts as the boundary.');
  await refreshed
    .getByRole('checkbox', { name: 'Visual evidence', exact: false })
    .check();
  await refreshed
    .getByRole('checkbox', { name: 'Contract checks', exact: false })
    .check();
  await refreshed
    .getByRole('button', { name: 'Save answer 2', exact: true })
    .click();
  await refreshed
    .getByRole('checkbox', { name: 'Write a different response', exact: true })
    .check();
  await refreshed
    .getByRole('textbox', {
      name: 'Written response for Choose the review target',
      exact: true,
    })
    .fill('An isolated staging environment');
  await refreshed
    .getByRole('region', { name: 'Choose the review target' })
    .getByRole('button', { name: 'Send response' })
    .click();
  await refreshed
    .getByRole('textbox', {
      name: 'Name the integration boundary',
      exact: true,
    })
    .fill('Payment provider contract');
  await refreshed
    .getByRole('region', { name: 'Name the integration boundary' })
    .getByRole('button', { name: 'Send response' })
    .click();
  await refreshed
    .getByRole('textbox', { name: 'Review the acceptance note', exact: true })
    .fill(
      'Preview remains available, with captured visual evidence and verified contracts.',
    );
  await refreshed
    .getByRole('region', { name: 'Review the acceptance note' })
    .getByRole('button', { name: 'Send response' })
    .click();
  await expect
    .poll(
      async () =>
        (await activity(page, w.artifact.id)).requests[0].questions.filter(
          (q: any) => q.status === 'answered',
        ).length,
    )
    .toBe(5);
  expect(answers).toHaveLength(0);
  await refreshed
    .getByRole('button', { name: 'Resume run', exact: true })
    .click();
  await expect
    .poll(
      async () => (
        await studio.maintenance(),
        (
          await studio.store.one(
            'SELECT status FROM studio_durable_jobs WHERE id=?',
            run.job.id,
          )
        ).status
      ),
    )
    .toBe('completed');
  expect(answers).toHaveLength(5);
  expect(answers[1]).toMatchObject({
    status: 'answered',
    value: {
      cancelled: false,
      answers: [
        {
          kind: 'chat',
          answer: 'Keep provider contracts as the boundary.',
        },
        { kind: 'multi', selected: ['Visual evidence', 'Contract checks'] },
      ],
    },
  });
  await page.reload();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await expect(
    page.getByRole('textbox', {
      name: 'Written response for Choose the review target',
      exact: true,
    }),
  ).toHaveValue('An isolated staging environment');
  expect(answers[2]).toMatchObject({ status: 'answered', value: null });
  await expect(
    page.getByText('The boundary review is recorded.', { exact: false }),
  ).toBeVisible();
  const exported = await page.request.get(
    origin + `/api/artifacts/${w.artifact.id}/export`,
  );
  expect(exported.ok(), await exported.text()).toBe(true);
  const bundle = await exported.json();
  expect(bundle.remoteActivity).toHaveLength(1);
  expect(bundle.remoteActivity[0].questions).toHaveLength(5);
  expect(bundle.remoteActivity[0].events.length).toBeGreaterThan(10);
  expect(
    (await studio.store.artifact(w.artifact.id, w.user.id)).content,
  ).toEqual(w.artifact.content);
  expect(
    (await studio.store.messages(w.artifact.id)).filter(
      (m) => m.role === 'assistant',
    ),
  ).toHaveLength(1);
  await page
    .getByRole('region', { name: 'Choose the review target', exact: true })
    .scrollIntoViewIfNeeded();
  await capture(page, 'remote-written-answers', false);
  await capture(page, 'remote-completed-history');
});

test('viewer cannot answer, source changes withdraw questions, and durable stop fences late remote output on mobile', async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const w = await open(page, 'Scoped remote cancellation');
  let finalAnswer: unknown;
  const run = await start(page, w, async (ctx, signal) => {
    await ctx.sendPart({ type: 'stream-start' });
    await ctx.sendPart({ type: 'text-start', id: 'text' });
    await ctx.sendPart({
      type: 'text-delta',
      id: 'text',
      delta: 'Waiting for a current project writer to name the boundary.',
    });
    finalAnswer = await ctx.ask('name', {
      method: 'input',
      title: 'Name the reviewed boundary',
    });
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { text: 'Late output must never publish.', content: null };
  });
  await expect(
    page.getByRole('textbox', {
      name: 'Name the reviewed boundary',
      exact: true,
    }),
  ).toBeVisible();
  const viewer =
    (await studio.store.userByEmail(viewerEmail)) ??
    (await studio.store.createUser(
      viewerEmail,
      'Read-only reviewer',
      null,
    ));
  await studio.store.exec(
    "INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,'viewer') ON CONFLICT(project_id,user_id) DO NOTHING",
    w.project.id,
    viewer.id,
  );
  const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    }),
    mobile = await context.newPage();
  await login(mobile, viewerEmail);
  await mobile.goto(
    origin + `/?project=${w.project.id}&artifact=${w.artifact.id}`,
  );
  await mobile
    .getByRole('button', { name: 'Show artifact panel', exact: true })
    .click();
  await mobile.getByRole('tab', { name: 'Chat', exact: true }).click();
  await expect(
    mobile.getByRole('textbox', {
      name: 'Name the reviewed boundary',
      exact: true,
    }),
  ).toHaveAttribute('readonly', '');
  await expect(
    mobile.getByRole('button', { name: 'Send response', exact: true }),
  ).toHaveCount(0);
  await expect(
    mobile.getByRole('button', { name: 'Stop turn', exact: true }),
  ).toHaveCount(0);
  await expect(
    mobile.getByText('Waiting for a response…', { exact: true }),
  ).toBeVisible();
  await expect(mobile.getByText('Writing…', { exact: true })).toHaveCount(0);
  await mobile
    .getByRole('region', { name: 'Remote agent activity' })
    .scrollIntoViewIfNeeded();
  await capture(mobile, 'remote-mobile-read-only');
  const current = await studio.store.artifact(w.artifact.id, w.user.id);
  const changed = structuredClone(current.content);
  changed.doc.content.push(
    paragraph('The boundary has changed after this question was asked.'),
  );
  const update = await page.request.patch(
    origin + `/api/artifacts/${w.artifact.id}`,
    {
      headers: { origin },
      data: { version: current.version, content: changed },
    },
  );
  expect(update.ok(), await update.text()).toBe(true);
  await expect
    .poll(
      async () =>
        (await activity(page, w.artifact.id)).requests[0].questions[0].status,
    )
    .toBe('stale');
  await page
    .getByRole('button', { name: 'Refresh activity', exact: true })
    .click();
  await expect(
    page
      .locator('.remote-turn > summary')
      .getByText('Source changed', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stop turn', exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await studio.store.one(
            'SELECT status FROM studio_durable_jobs WHERE id=?',
            run.job.id,
          )
        ).status,
    )
    .toBe('cancelled');
  await expect.poll(() => finalAnswer).toMatchObject({ status: 'cancelled' });
  expect(
    (await studio.store.messages(w.artifact.id)).filter(
      (m) => m.role === 'assistant',
    ),
  ).toHaveLength(0);
  await context.close();
});

test('older remote questions remain browseable after more than eight completed turns and a fresh page load', async ({
  page,
}) => {
  test.setTimeout(90000);
  const w = await open(page, 'Retained remote history');
  let index = 0;
  const first = await start(page, w, async (ctx) => {
    const current = index++;
    await ctx.sendPart({ type: 'stream-start' });
    await ctx.sendPart({ type: 'text-start', id: 'turn' });
    await ctx.sendPart({
      type: 'text-delta',
      id: 'turn',
      delta: `Retained boundary review ${current + 1}.`,
    });
    await ctx.sendPart({ type: 'text-end', id: 'turn' });
    if (current === 0)
      await ctx.ask('oldest', {
        method: 'confirm',
        title: 'Keep the oldest recorded boundary?',
        message:
          'This answered question must stay reachable in this artifact history.',
      });
    return { text: `Recorded boundary review ${current + 1}.`, content: null };
  });
  await page
    .getByRole('region', {
      name: 'Keep the oldest recorded boundary?',
      exact: true,
    })
    .getByRole('button', { name: 'Confirm', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await studio.store.one(
            'SELECT status FROM studio_durable_jobs WHERE id=?',
            first.job.id,
          )
        ).status,
    )
    .toBe('completed');
  for (let turn = 1; turn < 9; turn++) {
    const message = await page.request.post(
      origin + `/api/artifacts/${w.artifact.id}/messages`,
      {
        headers: { origin },
        data: {
          threadId: w.threadId,
          body: 'Review the next retained boundary ' + turn,
        },
      },
    );
    expect(message.ok(), await message.text()).toBe(true);
    const result = await page.request.post(
      origin + `/api/artifacts/${w.artifact.id}/agent`,
      { headers: { origin }, data: { threadId: w.threadId, intent: 'chat' } },
    );
    expect(result.ok(), await result.text()).toBe(true);
    const job = await result.json();
    await expect
      .poll(
        async () =>
          (
            await studio.store.one(
              'SELECT status FROM studio_durable_jobs WHERE id=?',
              job.id,
            )
          ).status,
      )
      .toBe('completed');
  }
  expect(index).toBe(9);
  await page.reload();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await expect(page.locator('.remote-turn')).toHaveCount(8);
  await page
    .getByRole('button', { name: 'Load earlier activity', exact: true })
    .click();
  await expect(page.locator('.remote-turn')).toHaveCount(9);
  const oldest = page
    .locator('.remote-turn')
    .filter({ hasText: 'Keep the oldest recorded boundary?' });
  await oldest.locator(':scope > summary').click();
  await expect(
    oldest.getByText('Saved response: Confirmed', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Load earlier activity', exact: true }),
  ).toHaveCount(0);
  await capture(page, 'remote-earlier-history');
  expect(faults).toEqual([]);
});
