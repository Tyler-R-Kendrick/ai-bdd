import { signInAcceptanceActor } from './browser-auth.ts';
import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { exportCodeZip, importCodeZip } from '../shared/code-archive.ts';

const origin = process.env.STUDIO_TEST_ORIGIN ?? 'http://127.0.0.1:8877';
async function project(page: Page, content?: unknown) {
  await signInAcceptanceActor(page);
  let response;
  response = await page.request.post('/api/projects', {
    headers: { origin },
    data: {
      title: 'Typed application review ' + Date.now(),
      description: 'Synthetic acceptance fixture.',
      repository: '',
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const parent = await response.json();
  response = await page.request.post(`/api/projects/${parent.id}/artifacts`, {
    headers: { origin },
    data: {
      kind: 'code',
      title: 'React code workspace',
      ...(content ? { content } : {}),
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const artifact = await response.json();
  await page.goto(`/?project=${parent.id}&artifact=${artifact.id}`);
  await expect(page.locator('.code-editor')).toBeVisible();
  return { parent, artifact };
}
async function capture(page: Page, name: string) {
  if (!process.env.STUDIO_CAPTURE_DIR) return;
  await mkdir(process.env.STUDIO_CAPTURE_DIR, { recursive: true });
  await page.screenshot({
    path: resolve(process.env.STUDIO_CAPTURE_DIR, name),
    fullPage: true,
    animations: 'disabled',
  });
}

test('authors, renames, imports and exports a persistent real React/TypeScript project', async ({
  page,
}) => {
  const { artifact } = await project(page);
  await page
    .getByRole('button', { name: 'Start React project', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Use React starter', exact: true })
    .click();
  let preview = page.frameLocator('iframe[title="Live artifact preview"]');
  await expect(
    preview.getByRole('heading', { name: 'Make something useful.' }),
  ).toBeVisible();
  await preview.getByRole('button', { name: 'Increase', exact: true }).click();
  await expect(preview.locator('output')).toHaveText('1');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page
    .getByRole('button', { name: 'Rename selected file', exact: true })
    .click();
  await page.getByLabel('File path', { exact: true }).fill('src/Counter.tsx');
  await page.getByRole('button', { name: 'Rename file', exact: true }).click();
  await expect(page.locator('.source-heading')).toContainText(
    'src/Counter.tsx',
  );
  await page
    .getByRole('button', { name: 'Duplicate selected file', exact: true })
    .click();
  await page
    .getByLabel('File path', { exact: true })
    .fill('src/Alternative.tsx');
  await page
    .getByRole('button', { name: 'Duplicate file', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  const downloaded = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download code project ZIP', exact: true })
    .click();
  const archive = await downloaded,
    archivePath = await archive.path();
  expect(archive.suggestedFilename()).toMatch(/\.zip$/);
  const exported = await importCodeZip(
    new Uint8Array(await readFile(archivePath!)),
  );
  expect(exported.entry).toBe('src/Counter.tsx');
  expect(exported.files['src/Alternative.tsx']).toContain('useState');
  await page.reload();
  await page
    .getByRole('button', { name: 'Installed packages', exact: true })
    .click();
  await expect(
    page
      .getByRole('region', { name: 'Installed browser packages' })
      .getByText('react', { exact: false })
      .first(),
  ).toBeVisible();
  preview = page.frameLocator('iframe[title="Live artifact preview"]');
  await expect(
    preview.getByRole('heading', { name: 'Make something useful.' }),
  ).toBeVisible();
  await expect(page.locator('.editor-statusbar')).toContainText(
    'Preview ready',
  );
  // The initial draft debounce must not clear a loaded iframe without replacing it.
  await page.waitForTimeout(600);
  await expect(page.locator('.editor-statusbar')).toContainText('Preview ready');
  await capture(page, '17-react-typescript-project.png');
  await page
    .getByRole('button', { name: 'Installed packages', exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.sidebar')).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(async () => {
    const bounds = await page.locator('.sidebar').boundingBox();
    return bounds ? bounds.x + bounds.width : 0;
  }).toBeLessThanOrEqual(1);
  await preview.getByRole('button', { name: 'Increase', exact: true }).click();
  await expect(preview.locator('output')).toHaveText('1');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await capture(page, '20-react-typescript-mobile.png');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole('button', { name: 'Import code project', exact: true })
    .click();
  const imported = {
    entry: 'src/Imported.tsx',
    files: {
      'src/Imported.tsx':
        'export default function Imported(){return <h1>Imported component</h1>}',
    },
  };
  await page.getByLabel('Project ZIP or JSON', { exact: true }).setInputFiles({
    name: 'import.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(exportCodeZip(imported)),
  });
  await expect(
    page.getByText('1 file ready to import', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Import files', exact: true }).click();
  await expect(
    page
      .frameLocator('iframe[title="Live artifact preview"]')
      .getByRole('heading'),
  ).toHaveText('Imported component');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get('/api/artifacts/' + artifact.id)).json())
          .artifact.content.entry,
    )
    .toBe('src/Imported.tsx');
});

test('switches persisted Pact provider-state examples without modifying the saved artifact', async ({
  page,
}) => {
  const content = {
    entry: 'index.html',
    files: {
      'index.html':
        '<h1>Ready</h1><p>Exercise a declared service boundary without a live integration.</p><button id="load">Load cart</button>',
      'style.css':
        'body{font:15px system-ui,sans-serif;color:#24292e;padding:40px;line-height:1.7}h1{font-size:28px;letter-spacing:-.025em}p{color:#626f56;max-width:52ch}button{font:inherit;border:1px solid #d8ded2;border-radius:6px;background:#f6f8f3;color:#24292e;padding:9px 16px;margin-top:14px;cursor:pointer}button:focus-visible{outline:3px solid #6b73d1;outline-offset:3px}',
      'main.js':
        "document.querySelector('#load').onclick=()=>fetch('/api/cart').then(response=>response.json()).then(value=>document.querySelector('h1').textContent=value.title)",
      'contracts.json': JSON.stringify({
        consumer: { name: 'cart-preview' },
        provider: { name: 'cart-api' },
        metadata: {
          pactSpecification: { version: '3.0.0' },
          'pact-js': { version: '17.1.4' },
        },
        interactions: [
          {
            description: 'An empty cart',
            providerStates: [{ name: 'Empty cart' }],
            request: { method: 'GET', path: '/api/cart' },
            response: { status: 200, body: { title: 'The cart is empty' } },
          },
          {
            description: 'A populated cart',
            providerStates: [{ name: 'Cart contains items' }],
            request: { method: 'GET', path: '/api/cart' },
            response: {
              status: 200,
              body: { title: 'The cart contains two items' },
            },
          },
        ],
      }),
    },
  };
  const { artifact } = await project(page, content);
  const preview = page.frameLocator('iframe[title="Live artifact preview"]');
  await preview.getByRole('button', { name: 'Load cart' }).click();
  await expect(preview.getByRole('heading')).toHaveText('The cart is empty');
  await page
    .getByRole('combobox', { name: 'Preview provider state', exact: true })
    .selectOption('Cart contains items');
  await expect(preview.getByRole('heading')).toHaveText('Ready');
  await preview.getByRole('button', { name: 'Load cart' }).click();
  await expect(preview.getByRole('heading')).toHaveText(
    'The cart contains two items',
  );
  await capture(page, '18-pact-provider-state-preview.png');
  const saved = (
    await (await page.request.get('/api/artifacts/' + artifact.id)).json()
  ).artifact;
  expect(saved.content).toEqual(content);
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
});

test('surfaces a compiler location and recovers through the actual source editor', async ({
  page,
}) => {
  await project(page, {
    entry: 'src/App.tsx',
    files: { 'src/App.tsx': 'export default function App(){return <h1>}' },
  });
  await expect(
    page.getByText('Preview needs attention', { exact: true }),
  ).toBeVisible();
  const location = page
    .locator('.code-diagnostic')
    .filter({ hasText: 'src/App.tsx:1' })
    .first();
  await expect(location).toBeVisible();
  await capture(page, '19-source-compiler-diagnostic.png');
  await location.click();
  const editor = page.locator('.monaco-editor');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(
    'export default function App(){return <h1>Recovered typed preview</h1>}',
  );
  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(
    page
      .frameLocator('iframe[title="Live artifact preview"]')
      .getByRole('heading'),
  ).toHaveText('Recovered typed preview');
});
