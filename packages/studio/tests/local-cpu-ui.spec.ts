import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp, signInBrowser } from './browser-fixture.ts';
import { decisionSettingsFromEnv } from '../server/decisions/settings.ts';
import { paragraph } from '../shared/domain.ts';
import {
  LOCAL_MODEL_ID,
  LOCAL_PROVIDER_ID,
  localModelFingerprint,
} from '../server/local/catalog.ts';
const directory = process.env.STUDIO_LOCAL_TEST_MODEL_DIR;
if (process.env.STUDIO_REQUIRE_LOCAL_MODEL_TEST === '1' && !directory)
  throw new Error(
    'Real local browser acceptance requires STUDIO_LOCAL_TEST_MODEL_DIR',
  );
test.skip(
  !directory,
  'Requires the real SHA-pinned local model; no provider fixture is substituted.',
);
const origin = 'http://127.0.0.1:8891',
  email = 'local-cpu-owner@example.test';
let studio: Awaited<ReturnType<typeof createApp>>, data: string;
test.beforeAll(async () => {
  data = await mkdtemp('/tmp/studio-local-cpu-ui-');
  studio = await createApp(
    {
      production: false,
      demo: false,
      origin,
      dataDir: data,
      adminEmail: email,
      integrations: { localModel: { directory: directory! } },
    },
    {
      db: ':memory:',
      decisionSettings: decisionSettingsFromEnv({
        STUDIO_LOCAL_MODEL_DIR: directory,
      }),
      clientDir: resolve(import.meta.dirname, '../dist/client'),
    },
  );
  await studio.app.listen({ host: '127.0.0.1', port: 8891 });
});
test.afterAll(async () => {
  await studio?.app.close();
  if (data) await rm(data, { recursive: true, force: true });
});
test('selects genuine offline CPU inference and keeps its generated artifact conversation and ADR after reload', async ({
  page,
}) => {
  const faults: string[] = [];
  page.on('request', (request) => {
    const target = new URL(request.url());
    // Only the explicitly owned OAuth chooser is outside this app's origin.
    // Inference and every other application request retain the offline guard.
    if (
      /^https?:/.test(target.protocol) &&
      target.origin !== origin &&
      !(target.origin === studio.testGitHubAuthorizationOrigin &&
        target.pathname === '/authorize')
    )
      faults.push('Unexpected external browser request');
  });
  page.on('pageerror', (error) => faults.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 500)
      faults.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const response = await page.request.fetch(origin + '/api' + path, {
      method,
      headers: { origin },
      ...(body === undefined ? {} : { data: body }),
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const user = await signInBrowser(page, origin, email);
  const project = await api('/projects', 'POST', {
    title: 'Offline design review',
    description: 'Actual local CPU inference; no external model provider.',
    repository: '',
  });
  const artifact = await api(`/projects/${project.id}/artifacts`, 'POST', {
    kind: 'document',
    title: 'Release actions',
    content: {
      doc: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: 'Accessible release actions' }],
          },
          paragraph(
            'The home page must show a blue button labelled Start. Its accessible name must also be Start.',
          ),
          paragraph(
            'Keep this design, its discussion and architecture decision record together. Human review is required before applying any agent proposal.',
          ),
        ],
      },
    },
  });
  const initial = await api(`/artifacts/${artifact.id}`);
  expect(initial.decisions).toHaveLength(1);
  expect(initial.decisions[0].artifactId).toBe(artifact.id);
  const adr = initial.decisions[0].id,
    thread = initial.threads[0].id;
  const evaluation = await studio.decisions.decide({
    user,
    artifactId: artifact.id,
    artifactVersion: artifact.version,
    profile: await studio.decisions.captureProfile(user, artifact.id),
    input: 'The chosen color is blue.',
    questions: [
      {
        id: 'blue',
        kind: 'boolean',
        instructions: 'Does the document mention the color blue?',
      },
    ],
    purpose: 'semantic-design-gap',
    idempotencyKey: 'local-browser-blue',
  });
  expect(evaluation.answers[0]?.value).toBe(true);
  expect(evaluation.provenance.localInference?.calibrated).toBe(false);
  expect(evaluation.provenance.localInference?.runtimeFingerprint).toBe(
    localModelFingerprint(),
  );
  expect(
    (
      await api(`/artifacts/${artifact.id}/decision/evaluations`)
    ).evaluations.map((entry: any) => entry.id),
  ).toContain(evaluation.id);

  await page.goto(origin + `/?project=${project.id}&artifact=${artifact.id}`);
  await page.getByRole('tab', { name: 'Connections', exact: true }).click();
  await page
    .getByLabel('Agent harness', { exact: true })
    .selectOption('local-cpu');
  await expect(page.getByLabel('Model provider', { exact: true })).toHaveValue(
    LOCAL_PROVIDER_ID,
  );
  await page
    .getByLabel('Agent model', { exact: true })
    .selectOption(LOCAL_MODEL_ID);
  await page
    .getByRole('button', { name: 'Save agent runtime', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await api(`/artifacts/${artifact.id}/agent/profile`)).profile,
    )
    .toEqual({
      harness: 'local-cpu',
      provider: LOCAL_PROVIDER_ID,
      model: LOCAL_MODEL_ID,
    });
  await expect(page.locator('.agent-profile')).toContainText('Available');
  await expect(page.locator('.agent-profile')).not.toContainText('SmolLM2');
  await expect(page.locator('.decision-profile')).toContainText('Available');
  await expect(
    page.getByLabel('Decision provider', { exact: true }),
  ).toHaveValue(LOCAL_PROVIDER_ID);
  const capture = async (name: string) => {
    expect(faults).toEqual([]);
    await expect(page.locator('.error-banner')).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    await mkdir(
      resolve(import.meta.dirname, '../../../docs/studio-evidence/local-cpu'),
      { recursive: true },
    );
    await page.screenshot({
      path: resolve(
        import.meta.dirname,
        `../../../docs/studio-evidence/local-cpu/${name}.png`,
      ),
      animations: 'disabled',
      fullPage: true,
    });
  };
  await page.locator('.agent-profile').scrollIntoViewIfNeeded();
  await capture('local-runtime-picker');
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.getByLabel('Message action', { exact: true }).selectOption('chat');
  await page
    .getByLabel('Message this artifact', { exact: true })
    .fill(
      'What color and label does this design require for the button?',
    );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message-assistant')).toHaveCount(1, {
    timeout: 45000,
  });
  await expect(page.locator('.message-assistant')).toContainText(/blue/i);
  await expect(page.locator('.message-assistant')).toContainText('Start');
  const completed = await api(`/artifacts/${artifact.id}`),
    reply = completed.messages.find(
      (message: any) => message.role === 'assistant',
    );
  const savedReply = { id: reply.id, body: reply.body };
  expect(savedReply.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(completed.messages.filter((message: any) => message.id === savedReply.id)
    .map((message: any) => ({ id: message.id, body: message.body }))).toEqual([savedReply]);
  // Persisted Markdown and its rendered DOM are separate representations.
  const replyBody = page.locator('.message-assistant .message-body');
  const renderedText = await replyBody.innerText();
  const renderedMarkup = await replyBody.innerHTML();
  expect(reply.threadId).toBe(thread);
  expect(completed.decisions[0].id).toBe(adr);
  expect(completed.artifact.content).toEqual(initial.artifact.content);
  const jobs = await studio.store.all(
    "SELECT input_json,status FROM studio_durable_jobs WHERE artifact_id=? AND kind='agent.chat'",
    artifact.id,
  );
  expect(jobs).toHaveLength(1);
  expect(jobs[0].status).toBe('completed');
  expect(JSON.parse(jobs[0].input_json).profile).toEqual({
    harness: 'local-cpu',
    provider: LOCAL_PROVIDER_ID,
    model: LOCAL_MODEL_ID,
  });
  await capture('local-design-chat');
  await page.reload();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await expect(replyBody).toHaveJSProperty('innerText', renderedText);
  await expect(replyBody).toHaveJSProperty('innerHTML', renderedMarkup);
  const reloaded = await api(`/artifacts/${artifact.id}`);
  expect(reloaded.messages.filter((message: any) => message.id === savedReply.id)
    .map((message: any) => ({ id: message.id, body: message.body }))).toEqual([savedReply]);
  expect(reloaded.decisions[0].id).toBe(adr);
  expect(reloaded.threads[0].id).toBe(thread);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('.artifact-title')).toHaveText(artifact.title);
  if (
    await page
      .getByRole('button', { name: 'Show artifact panel', exact: true })
      .isVisible()
  )
    await page
      .getByRole('button', { name: 'Show artifact panel', exact: true })
      .click();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await expect(page.locator('.message-assistant')).toContainText('Start');
  await expect(replyBody).toHaveJSProperty('innerText', renderedText);
  await expect(replyBody).toHaveJSProperty('innerHTML', renderedMarkup);
  await expect(page.locator('.message-assistant')).toContainText(/blue/i);
  const mobileReloaded = await api(`/artifacts/${artifact.id}`);
  expect(mobileReloaded.messages.filter((message: any) => message.id === savedReply.id)
    .map((message: any) => ({ id: message.id, body: message.body }))).toEqual([savedReply]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await capture('local-design-chat-mobile');
  await page.request.post(origin + '/api/auth/logout', { headers: { origin } });
  await signInBrowser(page, origin, email);
  const signedInAgain = await api(`/artifacts/${artifact.id}`);
  expect(
    signedInAgain.messages.filter(
      (message: any) => message.role === 'assistant',
    ),
  ).toHaveLength(1);
  expect(signedInAgain.messages.filter((message: any) => message.id === savedReply.id)
    .map((message: any) => ({ id: message.id, body: message.body }))).toEqual([savedReply]);
  expect(localModelFingerprint()).toContain('6eb923e7d26e9cea');
  expect(faults).toEqual([]);
});
