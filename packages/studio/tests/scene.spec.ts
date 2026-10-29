import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { signInAcceptanceActor } from './browser-auth.ts';

const origin = 'http://127.0.0.1:8877';
const review = resolve(import.meta.dirname, '../../../work/review');
test.use({
  launchOptions: {
    ...(process.env.STUDIO_CHROMIUM_PATH
      ? { executablePath: process.env.STUDIO_CHROMIUM_PATH }
      : existsSync('/usr/bin/chromium')
        ? { executablePath: '/usr/bin/chromium' }
        : {}),
    args: [
      '--no-sandbox',
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
    ],
  },
});
const errors = new WeakMap<Page, string[]>();
async function post(request: APIRequestContext, path: string, data?: unknown) {
  const response = await request.post('/api' + path, {
    headers: { origin },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function project(request: APIRequestContext, title: string) {
  return post(request, '/projects', {
    title: `${title} ${Date.now()}`,
    description:
      'Illustrative content used for the real Studio acceptance suite.',
    repository: '',
  });
}
async function open(page: Page, p: any, id: string) {
  await page.goto(`/?project=${p.id}&artifact=${id}`);
  await expect(page.locator('.artifact-title')).toBeVisible();
}
async function screenshot(page: Page, name: string) {
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await expect(page.getByText('Route not found', { exact: true })).toHaveCount(
    0,
  );
  await mkdir(review, { recursive: true });
  await page.screenshot({
    path: resolve(review, name),
    fullPage: true,
    animations: 'disabled',
  });
}
async function artifact(page: Page, id: string) {
  const response = await page.request.get('/api/artifacts/' + id);
  expect(response.ok()).toBe(true);
  return (await response.json()).artifact;
}
test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on('pageerror', (error) => list.push(error.message));
  await signInAcceptanceActor(page);
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page) ?? [], 'Uncaught application errors').toEqual([]);
});

test('edits a 3D scene parametrically, saves it, and reloads the same dimensions', async ({
  page,
}) => {
  const p = await project(page.request, 'Product scene'),
    a = await post(page.request, `/projects/${p.id}/artifacts`, {
      kind: 'scene',
      title: 'Parametric product study',
    });
  await open(page, p, a.id);
  await expect(
    page.getByRole('region', { name: '3D scene editor', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('spinbutton', { name: 'Dimensions X', exact: true })
    .fill('2.4');
  await page
    .getByRole('spinbutton', { name: 'Dimensions Y', exact: true })
    .fill('1.8');
  await page
    .getByRole('spinbutton', { name: 'Position Y', exact: true })
    .fill('0.9');
  await page.getByRole('button', { name: 'Add cylinder', exact: true }).click();
  await page
    .getByRole('spinbutton', { name: 'Position X', exact: true })
    .fill('2.1');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  await expect
    .poll(async () => {
      const saved = await artifact(page, a.id);
      return {
        count: saved.content.solids.length,
        width: saved.content.solids[0].dimensions[0],
        secondX: saved.content.solids[1].position[0],
      };
    })
    .toEqual({ count: 2, width: 2.4, secondX: 2.1 });
  await page.reload();
  await expect(page.locator('.scene-solid-item')).toHaveCount(2);
  await page.locator('.scene-solid-item').first().click();
  await expect(
    page.getByRole('spinbutton', { name: 'Dimensions X', exact: true }),
  ).toHaveValue('2.4');
  await expect(
    page.getByRole('spinbutton', { name: 'Dimensions Y', exact: true }),
  ).toHaveValue('1.8');
  await expect(page.locator('.scene-viewport canvas')).toBeVisible();
  await screenshot(page, 'studio-scene.png');
});

function binaryStlVolume(bytes: Buffer): number {
  const triangles = bytes.readUInt32LE(80);
  expect(bytes.length).toBe(84 + triangles * 50);
  let volume = 0;
  for (let triangle = 0; triangle < triangles; triangle++) {
    const offset = 84 + triangle * 50 + 12,
      a = [
        bytes.readFloatLE(offset),
        bytes.readFloatLE(offset + 4),
        bytes.readFloatLE(offset + 8),
      ],
      b = [
        bytes.readFloatLE(offset + 12),
        bytes.readFloatLE(offset + 16),
        bytes.readFloatLE(offset + 20),
      ],
      c = [
        bytes.readFloatLE(offset + 24),
        bytes.readFloatLE(offset + 28),
        bytes.readFloatLE(offset + 32),
      ];
    volume +=
      (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) +
        a[1]! * (b[2]! * c[0]! - b[0]! * c[2]!) +
        a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) /
      6;
  }
  return Math.abs(volume);
}
test('executes CAD subtraction in the production worker and exports the actual cut solid as STL and GLB', async ({
  page,
}, testInfo) => {
  const p = await project(page.request, 'CAD evidence'),
    ids = [crypto.randomUUID(), crypto.randomUUID()],
    a = await post(page.request, `/projects/${p.id}/artifacts`, {
      kind: 'cad',
      title: 'Machined enclosure',
      content: {
        unit: 'mm',
        grid: true,
        solids: [
          {
            id: ids[0],
            shape: 'box',
            position: [0, 10, 0],
            rotation: [0, 0, 0],
            dimensions: [20, 20, 20],
            color: '#6b73d1',
          },
          {
            id: ids[1],
            shape: 'box',
            position: [8, 10, 0],
            rotation: [0, 0, 0],
            dimensions: [8, 8, 8],
            color: '#b06440',
            operation: 'union',
          },
        ],
      },
    });
  await open(page, p, a.id);
  await page.locator('.scene-solid-item').nth(1).click();
  await page
    .getByRole('combobox', {
      name: 'Operation with previous result',
      exact: true,
    })
    .selectOption('subtract');
  await expect
    .poll(() => page.locator('.scene-statusbar').innerText())
    .toContain('triangles');
  await expect(
    page.getByText('Computing solid operations…', { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.scene-viewport canvas')).toBeVisible();
  const stlWait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'STL', exact: true }).click();
  const stl = await stlWait,
    path = testInfo.outputPath('enclosure.mm.stl');
  await stl.saveAs(path);
  const bytes = await readFile(path);
  expect(stl.suggestedFilename()).toMatch(/\.mm\.stl$/);
  expect(bytes.readUInt32LE(80)).toBeGreaterThan(12);
  // 20³ cuboid minus its 6×8×8 overlap with the cutter: this proves a real boolean result was exported.
  expect(binaryStlVolume(bytes)).toBeCloseTo(7616, 1);
  const glbWait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'GLB', exact: true }).click();
  const glb = await glbWait,
    glbPath = testInfo.outputPath('enclosure.glb');
  await glb.saveAs(glbPath);
  const binary = await readFile(glbPath);
  expect(binary.toString('ascii', 0, 4)).toBe('glTF');
  expect(binary.readUInt32LE(4)).toBe(2);
  expect(binary.length).toBeGreaterThan(1000);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(async () => {
      const saved = await artifact(page, a.id);
      return saved.content.solids[1].operation;
    })
    .toBe('subtract');
  await page.reload();
  await page.locator('.scene-solid-item').nth(1).click();
  await expect(
    page.getByRole('combobox', {
      name: 'Operation with previous result',
      exact: true,
    }),
  ).toHaveValue('subtract');
  await expect
    .poll(() => page.locator('.scene-statusbar').innerText())
    .toContain('triangles');
  await page.getByLabel('Show editable primitives', { exact: true }).uncheck();
  await screenshot(page, 'studio-cad.png');
});

test('persists interactive charts, diagrams, and tabs in the collaborative main design document', async ({
  page,
}) => {
  const p = await project(page.request, 'Rich living specification'),
    response = await page.request.patch('/api/artifacts/' + p.mainArtifactId, {
      headers: { origin },
      data: {
        version: 1,
        content: {
          doc: {
            type: 'doc',
            content: [
              {
                type: 'heading',
                attrs: { level: 1 },
                content: [{ type: 'text', text: 'Release architecture' }],
              },
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'A shared plan with inspectable visuals and explicit alternatives.',
                  },
                ],
              },
            ],
          },
        },
      },
    });
  expect(response.ok(), await response.text()).toBe(true);
  await open(page, p, p.mainArtifactId);
  const editor = page.getByLabel('Document editor', { exact: true });
  await expect(editor).toBeVisible();
  await expect(
    page.getByText('Live collaboration', { exact: true }),
  ).toBeVisible();
  for (const label of ['Insert chart', 'Insert diagram', 'Insert tabs']) {
    await editor.click();
    await editor.press('Control+End');
    await editor.press('Enter');
    await page.getByRole('button', { name: label, exact: true }).click();
  }
  const chart = page.locator('[data-visual-kind="chartBlock"]'),
    diagram = page.locator('[data-visual-kind="diagramBlock"]'),
    tabs = page.locator('[data-visual-kind="tabsBlock"]');
  await expect(chart).toBeVisible();
  await expect(diagram).toBeVisible();
  await expect(tabs).toBeVisible();
  await chart.getByRole('button', { name: 'Planned: 12', exact: true }).click();
  await expect(chart.locator('.rich-chart-readout')).toContainText('Planned');
  await tabs.getByRole('tab', { name: 'Alternatives', exact: true }).click();
  await expect(tabs.getByRole('tabpanel')).toContainText(
    'Compare viable alternatives',
  );
  await diagram.getByRole('button', { name: 'Artifact', exact: true }).click();
  await expect(diagram.locator('.rich-chart-readout')).toContainText(
    '2 connections',
  );
  await chart.getByRole('button', { name: 'Edit', exact: true }).click();
  const source = page.getByLabel('Visual block JSON', { exact: true });
  const chartData = JSON.parse(await source.inputValue());
  chartData.title = 'Verified release coverage';
  await source.fill(JSON.stringify(chartData));
  await page.getByRole('button', { name: 'Save block', exact: true }).click();
  await expect(chart.locator('.rich-visual-heading strong')).toHaveText(
    'Verified release coverage',
  );
  await expect
    .poll(async () =>
      JSON.stringify((await artifact(page, p.mainArtifactId)).content),
    )
    .toContain('Verified release coverage');
  await page.reload();
  await expect(editor).toBeVisible();
  await expect(chart.locator('.rich-visual-heading strong')).toHaveText(
    'Verified release coverage',
  );
  await expect(diagram).toBeVisible();
  await expect(tabs).toBeVisible();
  const saved = await artifact(page, p.mainArtifactId);
  expect(
    saved.content.doc.content
      .filter((node: any) =>
        ['chartBlock', 'diagramBlock', 'tabsBlock'].includes(node.type),
      )
      .map((node: any) => node.type)
      .sort(),
  ).toEqual(['chartBlock', 'diagramBlock', 'tabsBlock']);
  await chart.scrollIntoViewIfNeeded();
  await screenshot(page, 'studio-rich-doc.png');
});
