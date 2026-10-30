import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { signInAcceptanceActor } from './browser-auth.ts';
import { unzipSync, strFromU8 } from 'fflate';
import { documentBlockDefaults } from '../shared/document-blocks.ts';
const p = (text: string, id?: string) => ({
  type: 'paragraph',
  ...(id ? { attrs: { id } } : {}),
  content: [{ type: 'text', text }],
});
async function fixture(page: Page, content?: any[]) {
  const origin = String(
    test.info().project.use.baseURL ?? 'http://127.0.0.1:8877',
  );
  const call = async (path: string, method = 'POST', data?: unknown) => {
    const response = await page.request.fetch('/api' + path, {
      method,
      headers: { origin },
      ...(data === undefined ? {} : { data }),
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await signInAcceptanceActor(page);
  const user = await call('/me', 'GET'),
    project = await call('/projects', 'POST', {
      title: 'Document review ' + randomUUID().slice(0, 8),
      description: 'Synthetic acceptance review content',
      repository: '',
    }),
    bundle = await call(`/artifacts/${project.mainArtifactId}`, 'GET');
  const doc = content ?? [
    {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'A plan the team can review' }],
    },
    p('The interface preserves every decision.', 'intent'),
    {
      type: 'calloutBlock',
      attrs: {
        id: 'note',
        data: {
          ...documentBlockDefaults.calloutBlock,
          title: 'Context before implementation',
          body: 'Discuss the tradeoffs, retain each answer, and verify the behavior against its evidence.',
        },
      },
    },
    {
      type: 'questionnaireBlock',
      attrs: {
        id: 'questionnaire',
        data: documentBlockDefaults.questionnaireBlock,
      },
    },
    {
      type: 'evidenceBlock',
      attrs: { id: 'evidence', data: documentBlockDefaults.evidenceBlock },
    },
  ];
  await call(`/artifacts/${project.mainArtifactId}`, 'PATCH', {
    version: bundle.artifact.version,
    content: { doc: { type: 'doc', content: doc } },
  });
  await page.goto(
    `/?project=${project.id}&artifact=${project.mainArtifactId}`,
  );
  await expect(
    page.getByLabel('Document editor', { exact: true }),
  ).toBeVisible();
  return { call, project, user, origin };
}
test('collaborators answer inline questions, accept an attributed ADR, and review a text suggestion before it changes the document', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { project, user, call } = await fixture(page);
  const questionnaire = page.locator(
    '[data-component-kind="questionnaireBlock"]',
  );
  await questionnaire.getByRole('radio', { name: 'Approach B' }).check();
  await questionnaire
    .getByRole('textbox', {
      name: 'Reason for Which approach should we take?',
    })
    .fill(
      'The second approach keeps the integration boundary independently testable.',
    );
  await questionnaire
    .getByRole('button', { name: 'Save your answer' })
    .click();
  await expect(questionnaire.locator('.document-answers strong')).toHaveText(
    user.name,
  );
  await questionnaire
    .getByRole('button', { name: 'Accept as decision' })
    .click();
  await expect(
    questionnaire.getByRole('button', { name: 'Accepted ADR' }),
  ).toBeVisible();
  await questionnaire.getByRole('button', { name: 'Accepted ADR' }).click();
  await expect(
    page.getByRole('heading', { name: 'Architecture decisions' }),
  ).toBeVisible();
  await page.locator('.document-scroll').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.evaluate(() => {
    const element = document.querySelector(
        '.document-page [data-id="intent"]',
      )!,
      child = element.firstChild!,
      start = child.textContent!.indexOf('preserves'),
      range = document.createRange();
    range.setStart(child, start);
    range.setEnd(child, start + 'preserves'.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page
    .getByRole('button', { name: 'Suggest edit', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Suggest a text change' }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Proposed replacement' })
    .fill('protects');
  await page
    .getByRole('textbox', { name: 'Reason for the change' })
    .fill('Make the guarantee explicit.');
  await page.getByRole('button', { name: 'Save suggestion' }).click();
  const review = page.getByRole('complementary', { name: 'Document review' });
  await expect(review).toBeVisible();
  await expect(page.locator('.document-page [data-id="intent"]')).toHaveText(
    'The interface preserves every decision.',
  );
  await review.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.locator('.document-page [data-id="intent"]')).toHaveText(
    'The interface protects every decision.',
  );
  await review.getByLabel('Review status filter').selectOption('all');
  await expect(review.locator('.document-suggestion .badge')).toHaveText(
    'accepted',
  );
  const bundle = await call(`/artifacts/${project.mainArtifactId}`, 'GET');
  expect(
    bundle.decisions.some(
      (decision: any) =>
        decision.status === 'accepted' &&
        decision.decision.includes('Approach B'),
    ),
  ).toBe(true);
  await page.reload();
  await expect(page.locator('.document-page [data-id="intent"]')).toHaveText(
    'The interface protects every decision.',
  );
  await expect(
    questionnaire.getByRole('button', { name: 'Accepted ADR' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await review.getByLabel('Review status filter').selectOption('all');
  const output = resolve('../../work/review');
  await mkdir(output, { recursive: true });
  await page.screenshot({
    path: resolve(output, 'documents-review-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page
        .locator('.studio')
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(' ').length,
        ),
    )
    .toBe(1);
  await expect
    .poll(async () => (await review.boundingBox())?.x ?? -1)
    .toBeGreaterThanOrEqual(0);
  await page.screenshot({
    path: resolve(output, 'documents-review-mobile.png'),
  });
  expect(errors).toEqual([]);
});
test('Word and restricted MDX interchange are actual downloads and confirmed imports, with script markup kept inert', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await fixture(page);
  const source =
    '# Imported design\n\n**Evidence remains reviewable.**\n\n<script>globalThis.untrustedDocumentRan = true</script>\n\n```studio:columnsBlock\n' +
    JSON.stringify(documentBlockDefaults.columnsBlock) +
    '\n```\n';
  await page.getByLabel('Choose document to import').setInputFiles({
    name: 'Design.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(source),
  });
  await expect(
    page.getByRole('dialog', { name: 'Review document import' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Replace document', exact: true })
    .click();
  await expect(page.locator('.document-page h1')).toHaveText(
    'Imported design',
  );
  await expect(
    page.locator('[data-component-kind="columnsBlock"]'),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (globalThis as any).untrustedDocumentRan),
  ).toBeUndefined();
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#27664f';
    context.fillRect(0, 0, 2, 1);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  const picker = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: 'Insert image', exact: true })
    .click();
  await (
    await picker
  ).setFiles({
    name: 'Evidence.png',
    mimeType: 'image/png',
    buffer: Buffer.from(imageData, 'base64'),
  });
  await expect(page.locator('.document-page img')).toBeVisible();
  const htmlDownload = page.waitForEvent('download');
  await page
    .getByLabel('Export document', { exact: true })
    .selectOption('html');
  const html = await htmlDownload;
  expect(await readFile((await html.path())!, 'utf8')).toContain(
    'src="data:image/png;base64,',
  );
  const wordDownload = page.waitForEvent('download');
  await page
    .getByLabel('Export document', { exact: true })
    .selectOption('docx');
  const word = await wordDownload,
    bytes = await readFile((await word.path())!);
  expect(word.suggestedFilename()).toMatch(/\.docx$/);
  const files = unzipSync(bytes);
  expect(strFromU8(files['word/document.xml']!)).toContain(
    'Evidence remains reviewable.',
  );
  expect(Object.keys(files)).toContain('word/media/image1.png');
  await page.getByLabel('Choose document to import').setInputFiles({
    name: 'Roundtrip.docx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: bytes,
  });
  await expect(
    page.getByRole('dialog', { name: 'Review document import' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Replace document', exact: true })
    .click();
  await expect(page.locator('.document-page h1')).toHaveText(
    'Imported design',
  );
  await expect(
    page
      .locator('.document-page strong')
      .filter({ hasText: /^Evidence remains reviewable\.$/ }),
  ).toHaveText('Evidence remains reviewable.');
  await expect(page.locator('.document-page img')).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('.document-page img')
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(2);
  const mdxDownload = page.waitForEvent('download');
  await page
    .getByLabel('Export document', { exact: true })
    .selectOption('mdx');
  const mdx = await mdxDownload;
  expect(await readFile((await mdx.path())!, 'utf8')).toContain(
    '**Evidence remains reviewable.**',
  );
  expect(errors).toEqual([]);
});
test('long documents produce multiple printable PDF pages instead of clipping the application viewport', async ({
  page,
}) => {
  const body = [
    {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'A complete printable design' }],
    },
    ...Array.from({ length: 60 }, (_, index) =>
      p(
        `Section ${index + 1}. ` +
          'The team records intent, decisions, tests, and evidence in a shared living document. '.repeat(
            12,
          ),
      ),
    ),
  ];
  await fixture(page, body);
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({ format: 'A4' });
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? [])
    .length;
  expect(pages).toBeGreaterThanOrEqual(3);
});

test('find and replace edits real document text, the outline navigates headings, and table controls change its grid', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  const search = page.getByRole('search', {
    name: 'Find and replace in document',
  });
  await search
    .getByLabel('Find in document', { exact: true })
    .fill('preserves');
  await expect(search.getByRole('status')).toHaveText('1 / 1');
  await search.getByLabel('Replace with').fill('retains');
  await search.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(page.locator('.document-page [data-id="intent"]')).toHaveText(
    'The interface retains every decision.',
  );
  await search.getByRole('button', { name: 'Close document search' }).click();
  await page
    .getByLabel('Document outline')
    .selectOption({ label: 'A plan the team can review' });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!window.getSelection()?.anchorNode?.parentElement?.closest('h1'),
      ),
    )
    .toBe(true);
  await page.locator('.document-page [data-id="intent"]').click();
  await page
    .getByRole('button', { name: 'Insert table', exact: true })
    .click();
  const table = page.locator('.document-page table');
  await expect(table.locator('tr')).toHaveCount(3);
  await table.locator('td,th').first().click();
  await page.getByLabel('Table actions').selectOption('rowAfter');
  await expect(table.locator('tr')).toHaveCount(4);
  await page.getByLabel('Table actions').selectOption('columnAfter');
  await expect(table.locator('tr').first().locator('td,th')).toHaveCount(4);
  await page.getByLabel('Table actions').selectOption('deleteTable');
  await expect(table).toHaveCount(0);
});

test('a fresh viewer can read document review and search without editing questionnaires, suggestions, imports, or text', async ({
  page,
  browser,
}) => {
  const { call, project, origin } = await fixture(page),
    email = `document-viewer-${randomUUID()}@example.test`,
    invitation = await call(`/projects/${project.id}/members`, 'POST', {
      email,
      name: 'Document viewer',
      role: 'viewer',
    }),
    viewerContext = await browser.newContext({ baseURL: origin });
  try {
    const viewer = await viewerContext.newPage(),
      login = await viewer.request.post('/api/auth/login', {
        headers: { origin },
        data: { email, password: invitation.temporaryPassword },
      });
    expect(login.ok()).toBe(true);
    await viewer.goto(
      `/?project=${project.id}&artifact=${project.mainArtifactId}`,
    );
    await expect(
      viewer.getByLabel('Document editor', { exact: true }),
    ).toHaveAttribute('contenteditable', 'false');
    await expect(
      viewer.getByRole('button', { name: 'Suggest edit', exact: true }),
    ).toBeDisabled();
    await expect(
      viewer.getByRole('button', { name: 'Import', exact: true }),
    ).toBeDisabled();
    await expect(
      viewer.getByLabel('Insert planning component'),
    ).toBeDisabled();
    await expect(
      viewer.locator('[data-component-kind="questionnaireBlock"] input'),
    ).toHaveCount(0);
    await expect(viewer.locator('.document-component-tools')).toHaveCount(0);
    await viewer.getByRole('button', { name: 'Find', exact: true }).click();
    await viewer
      .getByLabel('Find in document', { exact: true })
      .fill('preserves');
    await expect(viewer.getByRole('search').getByRole('status')).toHaveText(
      '1 / 1',
    );
    await expect(
      viewer.getByRole('button', { name: 'Replace all', exact: true }),
    ).toBeDisabled();
  } finally {
    await viewerContext.close();
  }
});

test('an imported restricted-MDX questionnaire has a durable anchor and accepts an answer and ADR without another edit', async ({
  page,
}) => {
  const { call, project } = await fixture(page),
    source =
      '# Imported team decision\n\n<Questionnaire data={' +
      JSON.stringify(documentBlockDefaults.questionnaireBlock) +
      '} />\n';
  await page.getByLabel('Choose document to import').setInputFiles({
    name: 'Decision.mdx',
    mimeType: 'text/markdown',
    buffer: Buffer.from(source),
  });
  await expect(
    page.getByRole('dialog', { name: 'Review document import' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Replace document', exact: true })
    .click();
  const questionnaire = page.locator(
    '[data-component-kind="questionnaireBlock"]',
  );
  await questionnaire.getByRole('radio', { name: 'Approach A' }).check();
  await questionnaire
    .getByRole('textbox', {
      name: 'Reason for Which approach should we take?',
    })
    .fill('The exact imported question is now anchored.');
  await questionnaire
    .getByRole('button', { name: 'Save your answer' })
    .click();
  await questionnaire
    .getByRole('button', { name: 'Accept as decision' })
    .click();
  await expect(
    questionnaire.getByRole('button', { name: 'Accepted ADR' }),
  ).toBeVisible();
  const bundle = await call(`/artifacts/${project.mainArtifactId}`, 'GET'),
    block = bundle.artifact.content.doc.content.find(
      (node: any) => node.type === 'questionnaireBlock',
    );
  expect(typeof block.attrs.id).toBe('string');
  expect(
    bundle.decisions.some(
      (decision: any) =>
        decision.status === 'accepted' &&
        decision.decision.includes('Approach A'),
    ),
  ).toBe(true);
  await page.reload();
  await expect(
    page
      .locator('[data-component-kind="questionnaireBlock"]')
      .getByRole('button', { name: 'Accepted ADR' }),
  ).toBeVisible();
});
