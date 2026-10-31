import { signInBrowser } from './browser-fixture.ts';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { samplePreviewContract } from '../shared/preview.ts';
import { signInAcceptanceActor } from './browser-auth.ts';
const origin = 'http://127.0.0.1:8877';
async function post(request: APIRequestContext, path: string, body?: unknown) {
  const response = await request.post('/api' + path, {
    headers: { origin },
    ...(body === undefined ? {} : { data: body }),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function makeProject(
  request: APIRequestContext,
  title = 'Artifact workbench',
) {
  return post(request, '/projects', {
    title: title + ' ' + Date.now(),
    description: 'Illustrative workspace used for automated acceptance tests.',
    repository: '',
  });
}
async function open(
  page: Page,
  project: any,
  artifactId = project.mainArtifactId,
) {
  await page.goto(`/?project=${project.id}&artifact=${artifactId}`);
  await expect(page.locator('.artifact-title')).toBeVisible();
}
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await signInAcceptanceActor(page);
});
test.afterEach(async ({ page }) => {
  expect(
    pageErrors.get(page) ?? [],
    'Uncaught errors in the application',
  ).toEqual([]);
});

test('creates a project from the UI and persists edited document, chat, and attributed ADR', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const name = 'Shared specification ' + Date.now();
  await page.getByLabel('Project name', { exact: true }).fill(name);
  await page
    .getByLabel('What are you building?')
    .fill('Test the complete artifact lifecycle.');
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  const editor = page.getByLabel('Document editor', { exact: true });
  await expect(editor).toBeVisible();
  await expect(
    page.getByText('Live collaboration', { exact: true }),
  ).toBeVisible();
  await editor.click();
  await editor.press('Control+End');
  await editor.press('Enter');
  await editor.pressSequentially('A durable requirement written by the team.');
  await expect
    .poll(async () => {
      const id = new URL(page.url()).searchParams.get('artifact');
      return JSON.stringify(
        (await (await page.request.get('/api/artifacts/' + id)).json()).artifact
          .content,
      );
    })
    .toContain('A durable requirement written by the team.');
  await page
    .getByLabel('Message this artifact', { exact: true })
    .fill('Keep every discussion attached to its artifact.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page.getByText('Keep every discussion attached to its artifact.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Decisions', exact: true }).click();
  await page.getByRole('button', { name: 'Edit ADR', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Decision', exact: true })
    .fill('Persist each discussion using an artifact foreign key.');
  await page
    .getByRole('combobox', { name: 'Status', exact: true })
    .selectOption('accepted');
  await page.getByRole('button', { name: 'Save ADR', exact: true }).click();
  await expect(
    page.getByText('Persist each discussion using an artifact foreign key.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(editor).toContainText(
    'A durable requirement written by the team.',
  );
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await expect(
    page.getByText('Keep every discussion attached to its artifact.', {
      exact: true,
    }),
  ).toBeVisible();
});

test('keeps artifact chats isolated and exposes honest test configuration state', async ({
  page,
}) => {
  const request = page.request;
  const project = await makeProject(request),
    bundle = await (
      await request.get('/api/artifacts/' + project.mainArtifactId)
    ).json();
  await post(request, `/artifacts/${project.mainArtifactId}/messages`, {
    threadId: bundle.threads[0].id,
    body: 'Only the design artifact can see this discussion.',
  });
  const code = await post(request, `/projects/${project.id}/artifacts`, {
    kind: 'code',
    title: 'Independent prototype',
  });
  await open(page, project, code.id);
  await expect(
    page.getByText('Only the design artifact can see this discussion.', {
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByLabel('Message this artifact', { exact: true })
    .fill('This belongs to the code artifact.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page.getByText('This belongs to the code artifact.', { exact: true }),
  ).toBeVisible();
  await page
    .locator('.artifact-nav')
    .getByRole('button', { name: project.title + ' — design' })
    .click();
  await expect(
    page.getByText('Only the design artifact can see this discussion.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('This belongs to the code artifact.', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('tab', { name: 'Tests', exact: true }).click();
  await expect(
    page.getByText('Runner not configured', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/All tests passed/)).toHaveCount(0);
});

test('runs code preview and Pact boundary replay without integration access or parent privileges', async ({
  page,
}) => {
  const request = page.request;
  const project = await makeProject(request),
    code = await post(request, `/projects/${project.id}/artifacts`, {
      kind: 'code',
      title: 'Contract preview',
      content: {
        entry: 'index.html',
        files: {
          'index.html':
            '<main><h1>Loading contract…</h1><p id="security"></p><p id="blocked"></p></main>',
          'contracts.json': JSON.stringify(samplePreviewContract),
          'main.js':
            "fetch('/api/project').then(r=>r.json()).then(p=>document.querySelector('h1').textContent=p.title); try { parent.document.body.dataset.previewEscape='yes'; } catch { document.querySelector('#security').textContent='Parent isolated'; } fetch('/unregistered-boundary').catch(()=>document.querySelector('#blocked').textContent='Unregistered boundary blocked');",
        },
      },
    });
  const network: string[] = [];
  page.on('request', (req) => {
    if (
      req.url().includes('preview.invalid') ||
      req.url().includes('unregistered-boundary')
    )
      network.push(req.url());
  });
  await open(page, project, code.id);
  const preview = page.frameLocator('iframe[title="Live artifact preview"]');
  await expect(
    preview.getByRole('heading', { name: 'A new idea' }),
  ).toBeVisible();
  await expect(preview.getByText('Parent isolated')).toBeVisible();
  await expect(
    preview.getByText('Unregistered boundary blocked'),
  ).toBeVisible();
  expect(
    await page.locator('body').getAttribute('data-preview-escape'),
  ).toBeNull();
  expect(network).toEqual([]);
  expect(
    await page
      .locator('iframe[title="Live artifact preview"]')
      .getAttribute('sandbox'),
  ).toBe('allow-scripts');
});

test('edits code locally and retains unsaved work when a teammate saves a conflicting revision', async ({
  page,
}) => {
  const project = await makeProject(page.request),
    artifact = await post(page.request, `/projects/${project.id}/artifacts`, {
      kind: 'code',
      title: 'Concurrent prototype',
      content: {
        entry: 'index.html',
        files: { 'index.html': '<h1>Initial preview</h1>' },
      },
    });
  await open(page, project, artifact.id);
  const tabs = page.getByRole('tablist', { name: 'Code canvas' });
  await tabs.getByRole('tab', { name: 'Code', exact: true }).click();
  const source = page
    .locator('.source-pane .monaco-editor')
    .getByRole('textbox');
  await expect(source).toBeVisible();
  await source.press('Control+A');
  await page.keyboard.insertText('<h1>Saved local preview</h1>');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await tabs.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(
    page
      .frameLocator('iframe[title="Live artifact preview"]')
      .getByRole('heading', { name: 'Saved local preview' }),
  ).toBeVisible();
  await tabs.getByRole('tab', { name: 'Code', exact: true }).click();
  await source.press('Control+A');
  await page.keyboard.insertText('<h1>Unsaved local work</h1>');
  const latest = (
    await (await page.request.get('/api/artifacts/' + artifact.id)).json()
  ).artifact;
  const response = await page.request.patch('/api/artifacts/' + artifact.id, {
    headers: { origin },
    data: {
      version: latest.version,
      content: {
        ...latest.content,
        files: {
          ...latest.content.files,
          'index.html': '<h1>A teammate’s newer version</h1>',
        },
      },
    },
  });
  expect(response.ok()).toBe(true);
  await expect(
    page.getByText(
      'A teammate saved a newer version. Your local changes are retained.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator('.source-pane .view-lines')).toContainText(
    'Unsaved local work',
  );
  await page.getByRole('button', { name: 'Load latest', exact: true }).click();
  await expect(page.locator('.source-pane .view-lines')).toContainText(
    'A teammate’s newer version',
  );
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
});

test('renders and persists both bounded UI engines with working local interactions', async ({
  page,
}) => {
  const project = await makeProject(page.request),
    artifact = await post(page.request, `/projects/${project.id}/artifacts`, {
      kind: 'ui',
      title: 'A generated interface',
    });
  await open(page, project, artifact.id);
  const canvas = page.getByRole('tablist', { name: 'Generated UI canvas' });
  await expect(
    page
      .locator('.generated-preview')
      .getByRole('heading', { name: 'A generated interface' }),
  ).toBeVisible();
  await canvas.getByRole('tab', { name: 'Source', exact: true }).click();
  await page
    .getByRole('button', { name: 'Insert example', exact: true })
    .click();
  await canvas.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(
    page
      .locator('.generated-preview')
      .getByRole('heading', { name: 'Ready for your next idea.' }),
  ).toBeVisible();
  await page
    .locator('.generated-preview')
    .getByRole('button', { name: 'Try the preview', exact: true })
    .click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Your local preview action completed.' }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'UI rendering engine', exact: true })
    .selectOption('openui');
  await canvas.getByRole('tab', { name: 'Source', exact: true }).click();
  await page
    .getByRole('button', { name: 'Insert example', exact: true })
    .click();
  await canvas.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(
    page
      .locator('.generated-preview')
      .getByRole('heading', { name: 'Ready for your next idea.' }),
  ).toBeVisible();
  await page
    .locator('.generated-preview')
    .getByRole('textbox', { name: 'Project name', exact: true })
    .fill('A local-only form');
  await page
    .locator('.generated-preview')
    .getByRole('button', { name: 'Try the preview', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole('combobox', { name: 'UI rendering engine', exact: true }),
  ).toHaveValue('openui');
  await expect(
    page
      .locator('.generated-preview')
      .getByRole('heading', { name: 'Ready for your next idea.' }),
  ).toBeVisible();
});

test('preserves anchored discussions and restores a document through attributed history', async ({
  page,
}) => {
  const project = await makeProject(page.request);
  await open(page, project);
  const editor = page.getByLabel('Document editor', { exact: true });
  await expect(editor).toBeVisible();
  await expect(
    page.getByText('Live collaboration', { exact: true }),
  ).toBeVisible();
  await editor.click();
  await editor.press('Control+Home');
  await editor.press('Shift+End');
  await page
    .getByRole('button', { name: 'Comment on selection', exact: true })
    .click();
  await page
    .getByLabel('Comment text', { exact: true })
    .fill('This scope needs an explicit owner.');
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(
    page.getByText('This scope needs an explicit owner.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.getByText('Resolved', { exact: true })).toBeVisible();
  const before = await (
    await page.request.get('/api/artifacts/' + project.mainArtifactId)
  ).json();
  await editor.click();
  await editor.press('Control+End');
  await editor.press('Enter');
  await editor.pressSequentially('A revision to restore away.');
  await expect
    .poll(async () =>
      JSON.stringify(
        (
          await (
            await page.request.get('/api/artifacts/' + project.mainArtifactId)
          ).json()
        ).artifact.content,
      ),
    )
    .toContain('A revision to restore away.');
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await page
    .locator('.history-row')
    .filter({
      has: page.getByText(`v${before.artifact.version}`, { exact: true }),
    })
    .click();
  await page
    .getByRole('button', { name: 'Restore as new revision', exact: true })
    .click();
  await expect(editor).not.toContainText('A revision to restore away.');
  const restored = await (
    await page.request.get('/api/artifacts/' + project.mainArtifactId)
  ).json();
  expect(restored.artifact.version).toBeGreaterThan(before.artifact.version);
  expect(restored.threads.some((t: any) => t.quote && t.resolved)).toBe(true);
  expect(
    restored.messages.some(
      (m: any) => m.body === 'This scope needs an explicit owner.',
    ),
  ).toBe(true);
});

test('shows view-only documents to invited viewers without editable controls', async ({
  page,
  browser,
}) => {
  const project = await makeProject(page.request),
    email = `viewer-${Date.now()}@example.test`,
    context = await browser.newContext({ baseURL: origin });
  try {
    const viewer = await context.newPage();
    const actor=await signInBrowser(viewer, origin, email);
    const member=await post(page.request,`/projects/${project.id}/members`,{userId:actor.id,role:'viewer'});
    expect(member).not.toHaveProperty('temporaryPassword');
    await open(viewer, project);
    const editor = viewer.getByLabel('Document editor', { exact: true });
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await expect(
      viewer.getByRole('button', { name: 'Bold', exact: true }),
    ).toBeDisabled();
    await expect(
      viewer.getByText('You have view-only access to this project.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      viewer.getByLabel('Message this artifact', { exact: true }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('keeps mobile keyboard navigation within the visible panel and restores focus on Escape', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const project = await makeProject(page.request);
  await open(page, project);
  await expect(
    page.getByLabel('Document editor', { exact: true }),
  ).toBeVisible();
  const sidebar = page.locator('#project-navigation'),
    toggle = page.getByRole('button', {
      name: 'Toggle navigation',
      exact: true,
    });
  await expect(sidebar).toHaveAttribute('inert', '');
  await toggle.focus();
  await page.keyboard.press('Tab');
  expect(
    await page.evaluate(() =>
      document
        .querySelector('#project-navigation')
        ?.contains(document.activeElement),
    ),
  ).toBe(false);
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(sidebar).not.toHaveAttribute('inert', '');
  await expect
    .poll(() =>
      page.evaluate(() =>
        document
          .querySelector('#project-navigation')
          ?.contains(document.activeElement),
      ),
    )
    .toBe(true);
  for (let index = 0; index < 16; index++) {
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() =>
        document
          .querySelector('#project-navigation')
          ?.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(sidebar).toHaveAttribute('inert', '');
  await expect(toggle).toBeFocused();
  await page
    .getByRole('button', { name: 'Show artifact panel', exact: true })
    .click();
  await expect(page.locator('.workspace-body')).toHaveAttribute('inert', '');
  await expect(
    page.getByRole('tab', { name: 'Chat', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Hide artifact panel', exact: true })
    .click();
  await expect(page.locator('.workspace-body')).not.toHaveAttribute(
    'inert',
    '',
  );
});

test('captures the collaborative document, project canvas, and narrow viewport without page overflow', async ({
  page,
}) => {
  const request = page.request;
  const project = await makeProject(request, 'Release workspace'),
    bundle = await (
      await request.get('/api/artifacts/' + project.mainArtifactId)
    ).json();
  await post(request, `/artifacts/${project.mainArtifactId}/messages`, {
    threadId: bundle.threads[0].id,
    body: 'The design document is the shared source of intent. Let’s keep acceptance evidence attached to every requirement.',
  });
  await post(request, `/projects/${project.id}/artifacts`, {
    kind: 'code',
    title: 'Onboarding flow',
  });
  await post(request, `/projects/${project.id}/artifacts`, {
    kind: 'image',
    title: 'Welcome illustration',
  });
  await post(request, `/projects/${project.id}/artifacts`, {
    kind: 'video',
    title: 'Product walkthrough',
  });
  await open(page, project);
  await expect(
    page.getByLabel('Document editor', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Live collaboration', { exact: true }),
  ).toBeVisible();
  const review = resolve(import.meta.dirname, '../../../work/review');
  await mkdir(review, { recursive: true });
  await page.screenshot({
    path: resolve(review, 'studio-test-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page
    .getByRole('button', { name: 'Project canvas', exact: true })
    .click();
  await expect(page.locator('.project-canvas')).toBeVisible();
  await page.screenshot({
    path: resolve(review, 'studio-test-canvas.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, project);
  await expect(
    page.getByLabel('Document editor', { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: resolve(review, 'studio-test-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page
    .getByRole('button', { name: 'Toggle navigation', exact: true })
    .click();
  await expect(page.locator('.sidebar')).toBeVisible();
  await page
    .getByRole('button', { name: 'Close navigation', exact: true })
    .click();
});
