import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { passwordHash } from '../server/auth.ts';
import { paragraph } from '../shared/domain.ts';
const origin = 'http://127.0.0.1:8902',
  password = 'synthetic-archive-browser-password',
  email = 'archive-browser-owner@example.test',
  viewerEmail = 'archive-browser-viewer@example.test';
let studio: Awaited<ReturnType<typeof createApp>>,
  directory: string,
  projectId: string,
  draftId: string,
  proofId: string;
const faults: string[] = [];
async function signIn(page: Page, user = email) {
  page.on('pageerror', (error) => faults.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 500)
      faults.push(response.url() + ':' + response.status());
  });
  await page.goto(origin);
  const result = await page.request.post(origin + '/api/auth/login', {
    headers: { origin },
    data: { email: user, password },
  });
  expect(result.status(), await result.text()).toBe(200);
  await page.goto(origin + `/?project=${projectId}&artifact=${draftId}`);
  await expect(page.locator('.artifact-title')).toHaveText(
    'Archive lifecycle note',
  );
}
async function archiveBrowser(page: Page) {
  const navigation = page.getByRole('button', {
    name: 'Archived artifacts',
    exact: true,
  });
  if (!(await navigation.isVisible()))
    await page
      .getByRole('button', { name: 'Toggle navigation', exact: true })
      .click();
  await navigation.click();
  const modal = page.getByRole('dialog', {
    name: 'Archived artifacts',
    exact: true,
  });
  await expect(modal).toBeVisible();
  return modal;
}
async function archiveCurrent(page: Page) {
  await page
    .getByRole('button', { name: 'Artifact actions', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Archive artifact', exact: true })
    .click();
  await expect
    .poll(async () =>
      Number(
        (
          await studio.store.one(
            'SELECT archived FROM artifacts WHERE id=?',
            draftId,
          )
        )?.archived,
      ),
    )
    .toBe(1);
}
async function capture(page: Page, name: string) {
  if (!process.env.STUDIO_CAPTURE_DIR) return;
  await mkdir(process.env.STUDIO_CAPTURE_DIR, { recursive: true });
  await page.screenshot({
    path: resolve(process.env.STUDIO_CAPTURE_DIR, name + '.png'),
    fullPage: true,
    animations: 'disabled',
  });
}
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'studio-archive-browser-'));
  studio = await createApp(
    {
      origin,
      production: false,
      demo: false,
      dataDir: directory,
      adminEmail: email,
      adminPassword: password,
    },
    {
      db: join(directory, 'store.sqlite'),
      clientDir: resolve(import.meta.dirname, '../dist/client'),
    },
  );
  const owner = await studio.store.userByEmail(email),
    project = await studio.store.createProject(
      owner,
      'Release planning',
      'Archive lifecycle acceptance',
      '',
    );
  projectId = project.id;
  const draft = await studio.store.createArtifact(
    owner,
    projectId,
    'document',
    'Archive lifecycle note',
    {
      doc: {
        type: 'doc',
        content: [
          paragraph(
            'This draft can be archived, reviewed with its discussion, restored, and explicitly removed when no evidence depends on it.',
          ),
        ],
      },
    },
  );
  draftId = draft.id;
  const thread = (await studio.store.threads(draft.id))[0]!;
  await studio.store.message(
    owner,
    draft.id,
    thread.id,
    'Keep the design rationale with its artifact through archive and restore.',
  );
  const proof = await studio.store.createArtifact(
    owner,
    projectId,
    'document',
    'Acceptance evidence to retain',
    {
      doc: {
        type: 'doc',
        content: [
          paragraph(
            'This source has a recorded acceptance run. Its failure evidence stays attached, including while the source is archived.',
          ),
        ],
      },
    },
  );
  proofId = proof.id;
  await studio.store.exec(
    'INSERT INTO runs(id,artifact_id,artifact_version,status,error,created_at,finished_at) VALUES(?,?,?,?,?,?,?)',
    randomUUID(),
    proof.id,
    proof.version,
    'failed',
    'Explicit archive fixture: retained failure receipt',
    new Date().toISOString(),
    new Date().toISOString(),
  );
  const viewer = await studio.store.createUser(
    viewerEmail,
    'Archive viewer',
    await passwordHash(password),
  );
  await studio.store.exec(
    'INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?)',
    projectId,
    viewer.id,
    'viewer',
  );
  await studio.app.listen({ host: '127.0.0.1', port: 8902 });
});
test.afterAll(async () => {
  await studio?.app.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
test('owner archives restores and explicitly deletes an eligible draft while retaining acceptance evidence', async ({
  page,
}) => {
  await signIn(page);
  await archiveCurrent(page);
  let modal = await archiveBrowser(page);
  await modal.getByRole('button', { name: /^Archive lifecycle note/ }).click();
  await expect(
    modal.getByRole('region', { name: 'Archived artifact details' }),
  ).toBeVisible();
  await expect(
    modal.getByText('1 messages · 1 decisions · 1 versions · 0 uploaded files'),
  ).toBeVisible();
  await capture(page, 'archive-browse-desktop');
  await modal
    .getByRole('button', { name: 'Restore artifact', exact: true })
    .click();
  await expect
    .poll(async () =>
      Number(
        (
          await studio.store.one(
            'SELECT archived FROM artifacts WHERE id=?',
            draftId,
          )
        )?.archived,
      ),
    )
    .toBe(0);
  await expect(
    modal.getByRole('button', { name: /^Archive lifecycle note/ }),
  ).toHaveCount(0);
  await modal
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await page.goto(origin + `/?project=${projectId}&artifact=${draftId}`);
  await expect(page.locator('.tiptap')).toHaveAttribute(
    'contenteditable',
    'true',
  );
  expect(await studio.store.messages(draftId)).toHaveLength(1);
  expect(await studio.store.decisions(draftId)).toHaveLength(1);
  await archiveCurrent(page);
  modal = await archiveBrowser(page);
  await modal.getByRole('button', { name: /^Archive lifecycle note/ }).click();
  await modal
    .getByRole('button', { name: 'Delete permanently…', exact: true })
    .click();
  const confirm = modal.getByRole('group', {
    name: 'Confirm permanent artifact deletion',
  });
  await expect(
    confirm.getByRole('button', {
      name: 'Permanently delete artifact',
      exact: true,
    }),
  ).toBeDisabled();
  await confirm
    .getByRole('textbox', { name: 'Artifact title confirmation' })
    .fill('Archive lifecycle note');
  await confirm.getByRole('checkbox').check();
  await expect(
    confirm.getByRole('button', {
      name: 'Permanently delete artifact',
      exact: true,
    }),
  ).toBeEnabled();
  await capture(page, 'archive-delete-confirmation-desktop');
  await confirm
    .getByRole('button', { name: 'Permanently delete artifact', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        await studio.store.one('SELECT id FROM artifacts WHERE id=?', draftId),
    )
    .toBeUndefined();
  expect(
    await studio.store.one(
      "SELECT id FROM audit WHERE project_id=? AND artifact_id IS NULL AND action='artifact.permanently-deleted'",
      projectId,
    ),
  ).toBeTruthy();
  await expect(
    modal.getByRole('button', { name: /^Archive lifecycle note/ }),
  ).toHaveCount(0);
  await modal
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  const archived = await page.request.post(
    origin + `/api/artifacts/${proofId}/archive`,
    { headers: { origin }, data: { version: 1 } },
  );
  expect(archived.status(), await archived.text()).toBe(200);
  modal = await archiveBrowser(page);
  await modal
    .getByRole('button', { name: /^Acceptance evidence to retain/ })
    .click();
  await expect(
    modal.getByText(
      'Recorded acceptance runs and their evidence must remain linked. Keep this artifact archived.',
    ),
  ).toBeVisible();
  await expect(
    modal.getByRole('button', { name: 'Delete permanently…', exact: true }),
  ).toBeDisabled();
  await capture(page, 'archive-retained-evidence-desktop');
  expect(
    await studio.store.one('SELECT id FROM runs WHERE artifact_id=?', proofId),
  ).toBeTruthy();
  expect(faults).toEqual([]);
});
test('mobile viewer browses retained archives in read mode and cannot restore or delete', async ({
  browser,
}) => {
  const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    }),
    page = await context.newPage();
  try {
    await page.goto(origin);
    const login = await page.request.post(origin + '/api/auth/login', {
      headers: { origin },
      data: { email: viewerEmail, password },
    });
    expect(login.status()).toBe(200);
    await page.goto(origin + `/?project=${projectId}&artifact=${proofId}`);
    page.on('pageerror', (error) => faults.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 500)
        faults.push(response.url() + ':' + response.status());
    });
    await expect(page.locator('.artifact-title')).toHaveText(
      'Acceptance evidence to retain',
    );
    await expect(page.locator('.artifact-title')).toBeDisabled();
    await expect(page.locator('.tiptap')).toHaveAttribute(
      'contenteditable',
      'false',
    );
    let modal = await archiveBrowser(page);
    await modal
      .getByRole('button', { name: /^Acceptance evidence to retain/ })
      .click();
    await expect(
      modal.getByRole('button', { name: 'Restore artifact', exact: true }),
    ).toHaveCount(0);
    await expect(
      modal.getByRole('button', { name: 'Delete permanently…', exact: true }),
    ).toHaveCount(0);
    await expect(modal.getByText(/Project owners can restore/)).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await capture(page, 'archive-viewer-mobile');
    const inspection = await page.request.get(
      origin + `/api/artifacts/${proofId}/lifecycle`,
    );
    expect(inspection.status()).toBe(200);
    const artifact = (await inspection.json()).artifact;
    for (const [method, path] of [
      ['POST', '/restore'],
      ['DELETE', ''],
    ] as const) {
      const result = await page.request.fetch(
        origin + `/api/artifacts/${proofId}${path}`,
        {
          method,
          headers: { origin },
          data: {
            version: artifact.version,
            archiveRevision: artifact.archiveRevision,
            ...(method === 'DELETE' ? { confirmTitle: artifact.title } : {}),
          },
        },
      );
      expect(result.status(), await result.text()).toBe(403);
    }
    await modal
      .getByRole('button', {
        name: 'Open archived Acceptance evidence to retain',
      })
      .click();
    await expect(
      page.getByRole('dialog', { name: 'Archived artifacts' }),
    ).toHaveCount(0);
    await expect(page.locator('.tiptap')).toHaveAttribute(
      'contenteditable',
      'false',
    );
    expect(faults).toEqual([]);
  } finally {
    await context.close();
  }
});
