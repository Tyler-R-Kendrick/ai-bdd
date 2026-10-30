import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { signInAcceptanceActor } from './browser-auth.ts';
const origin = 'http://127.0.0.1:8877';
test('captures the requested artifact workspace with honest illustrative review content', async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const call = async (path: string, method = 'POST', data?: unknown) => {
    const r = await page.request.fetch('/api' + path, {
      method,
      headers: { origin },
      ...(data === undefined ? {} : { data }),
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  await signInAcceptanceActor(page);
  const project = await call('/projects', 'POST', {
    title: 'Customer onboarding',
    description:
      'Illustrative review project · a clearer first run for every teammate.',
    repository: 'https://github.com/Tyler-R-Kendrick/ai-bdd',
  });
  const initial = await call('/artifacts/' + project.mainArtifactId, 'GET');
  const p = (text: string) => ({
      type: 'paragraph',
      content: [{ type: 'text', text }],
    }),
    h = (text: string, level = 2) => ({
      type: 'heading',
      attrs: { level },
      content: [{ type: 'text', text }],
    });
  await call('/artifacts/' + project.mainArtifactId, 'PATCH', {
    version: initial.artifact.version,
    content: {
      doc: {
        type: 'doc',
        content: [
          h('Customer onboarding', 1),
          p(
            'Help a new teammate turn a first idea into a working project, with the context to make confident decisions.',
          ),
          h('The first five minutes'),
          p(
            'A teammate should understand the project, find the right artifact, and see why a decision was made without reconstructing a conversation.',
          ),
          {
            type: 'bulletList',
            content: [
              'Start with a shared design document.',
              'Keep the prototype and visual work connected to the plan.',
              'Review acceptance criteria alongside the evidence they produce.',
            ].map((text) => ({ type: 'listItem', content: [p(text)] })),
          },
          h('Acceptance criteria'),
          p(
            'Given a project with a design document, when a teammate opens an artifact, then its conversation, decisions, and evidence belong to that artifact.',
          ),
          {
            type: 'testBlock',
            attrs: {
              label: 'A teammate finds the right context',
              scenarioId: '',
            },
          },
          h('Decisions that travel with the work'),
          p(
            'Every artifact has a dedicated ADR. Tests record the version they executed, so a passing result cannot silently describe a newer design.',
          ),
          p(
            'This is illustrative review content. The acceptance scenario above has not been run in this capture.',
          ),
        ],
      },
    },
  });
  const bundle = await call('/artifacts/' + project.mainArtifactId, 'GET'),
    threadId = bundle.threads.find((t: any) => t.anchor === null).id;
  await call(`/artifacts/${project.mainArtifactId}/messages`, 'POST', {
    threadId,
    body: 'Let’s keep the acceptance criteria next to the design, and the evidence next to the tests.',
  });
  await call(`/artifacts/${project.mainArtifactId}/messages`, 'POST', {
    threadId,
    body: 'The prototype can stay live while integration contracts evolve. Each artifact keeps its own conversation.',
  });
  const adr = bundle.decisions[0];
  await call(
    `/artifacts/${project.mainArtifactId}/decisions/${adr.id}`,
    'PUT',
    {
      title: 'ADR · artifact-owned context',
      context:
        'Project-level chats make it difficult to recover the reasoning behind a specific artifact.',
      decision:
        'Persist each conversation and decision directly against its artifact. Compose those artifacts into a shared project.',
      consequences:
        'The team can move between media canvases without losing the discussion. Cross-artifact references remain explicit.',
      status: 'accepted',
      version: adr.version,
    },
  );
  const code = await call(`/projects/${project.id}/artifacts`, 'POST', {
    kind: 'code',
    title: 'Onboarding flow',
  });
  await call(`/projects/${project.id}/artifacts`, 'POST', {
    kind: 'image',
    title: 'Welcome illustration',
  });
  await call(`/projects/${project.id}/artifacts`, 'POST', {
    kind: 'video',
    title: 'Product walkthrough',
  });
  const directory = resolve('../../work/review');
  await mkdir(directory, { recursive: true });
  const open = async (id: string) => {
    await page.goto(`/?project=${project.id}&artifact=${id}`);
    await expect(page.locator('.artifact-title')).toBeVisible();
  };
  await open(project.mainArtifactId);
  await expect(
    page.getByLabel('Document editor', { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.inline-test .badge').filter({ hasText: 'Not linked' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Let’s keep the acceptance criteria next to the design, and the evidence next to the tests.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(directory, 'studio-desktop.png'),
    fullPage: true,
  });
  await page.getByRole('tab', { name: 'Decisions', exact: true }).click();
  await expect(
    page.getByText('artifact-owned context', { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(directory, 'studio-decisions.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Project canvas', exact: true })
    .click();
  await expect(page.locator('.canvas-artifact')).toHaveCount(4);
  await page.screenshot({
    path: resolve(directory, 'studio-canvas.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await open(project.mainArtifactId);
  await expect(
    page.getByLabel('Document editor', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: resolve(directory, 'studio-mobile.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(code.id);
  const preview = page.frameLocator('iframe[title="Live artifact preview"]');
  await expect(
    preview.getByRole('heading', { name: 'Your next idea.' }),
  ).toBeVisible();
  await preview.getByRole('button', { name: 'Try it', exact: true }).click();
  await expect(preview.getByText('It works.', { exact: true })).toBeVisible();
  await page.screenshot({
    path: resolve(directory, 'studio-code.png'),
    fullPage: true,
  });
  const ui = await call(`/projects/${project.id}/artifacts`, 'POST', {
    kind: 'ui',
    title: 'Workspace components',
  });
  await open(ui.id);
  await expect(
    page
      .locator('.generated-preview')
      .getByRole('heading', { name: 'Workspace components' }),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(directory, 'studio-json-render.png'),
    fullPage: true,
  });
  await page
    .getByRole('combobox', { name: 'UI rendering engine', exact: true })
    .selectOption('openui');
  const tabs = page.getByRole('tablist', { name: 'Generated UI canvas' });
  await tabs.getByRole('tab', { name: 'Source', exact: true }).click();
  await page
    .getByRole('button', { name: 'Insert example', exact: true })
    .click();
  await tabs.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(
    page
      .locator('.generated-preview')
      .getByRole('heading', { name: 'Ready for your next idea.' }),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(directory, 'studio-openui.png'),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
