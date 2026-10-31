import { signInBrowser } from './browser-fixture.ts';
import { signInAcceptanceActor } from './browser-auth.ts';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const errors = new WeakMap<Page, string[]>();
const originFor = (info: TestInfo) =>
  String(info.project.use.baseURL ?? 'http://127.0.0.1:8877');
async function post(page: Page, origin: string, path: string, data?: unknown) {
  const response = await page.request.post('/api' + path, {
    headers: { origin },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function create(
  page: Page,
  origin: string,
  kind: 'scene' | 'cad',
  title: string,
  content?: unknown,
) {
  const project = await post(page, origin, '/projects', {
    title,
    description: 'Synthetic browser acceptance fixture.',
    repository: '',
  });
  const artifact = await post(
    page,
    origin,
    `/projects/${project.id}/artifacts`,
    { title, kind, ...(content ? { content } : {}) },
  );
  return { project, artifact };
}
async function open(page: Page, project: any, artifact: any) {
  await page.goto(`/?project=${project.id}&artifact=${artifact.id}`);
  await expect(
    page.getByRole('region', {
      name: artifact.kind === 'cad' ? 'CAD editor' : '3D scene editor',
      exact: true,
    }),
  ).toBeVisible();
}
async function capture(page: Page, filename: string) {
  const folder = resolve(import.meta.dirname, '../../../work/review');
  await mkdir(folder, { recursive: true });
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await page.screenshot({
    path: resolve(folder, filename),
    fullPage: true,
    animations: 'disabled',
  });
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
}
test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on('pageerror', (error) => list.push(error.message));
  await signInAcceptanceActor(page);
});
test.afterEach(async ({ page }) => expect(errors.get(page) ?? []).toEqual([]));

test('rebuilds dimensional sketch history, exports analytic STEP, and roundtrips the solid through an authenticated import', async ({
  page,
}, info) => {
  const origin = originFor(info);
  const { project, artifact } = await create(
    page,
    origin,
    'cad',
    'Dimensioned mounting plate',
    { solids: [], unit: 'mm', grid: true },
  );
  await open(page, project, artifact);
  await page
    .getByRole('button', {
      name: 'Add rectangle sketch extrusion',
      exact: true,
    })
    .click();
  await page
    .getByRole('textbox', { name: 'Feature name', exact: true })
    .fill('Plate profile');
  await page
    .getByRole('spinbutton', { name: 'Feature width', exact: true })
    .fill('30');
  await page
    .getByRole('spinbutton', { name: 'Feature height', exact: true })
    .fill('20');
  await page
    .getByRole('spinbutton', { name: 'Feature depth', exact: true })
    .fill('10');
  await page
    .getByRole('button', { name: 'Add circular sketch extrusion', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Feature name', exact: true })
    .fill('Mounting hole');
  await page
    .getByRole('spinbutton', { name: 'Feature radius', exact: true })
    .fill('3');
  await page
    .getByRole('combobox', { name: 'Feature operation', exact: true })
    .selectOption('subtract');
  await expect(page.locator('.scene-statusbar')).toContainText(
    '5,717.257 mm³',
    { timeout: 30000 },
  );
  await expect(page.locator('.cad-feature-row')).toHaveCount(2);
  await page
    .getByRole('checkbox', { name: 'Enable feature', exact: true })
    .uncheck();
  await expect(page.locator('.scene-statusbar')).toContainText('6,000 mm³', {
    timeout: 30000,
  });
  await page
    .getByRole('checkbox', { name: 'Enable feature', exact: true })
    .check();
  await expect(page.locator('.scene-statusbar')).toContainText(
    '5,717.257 mm³',
    { timeout: 30000 },
  );
  await save(page);
  await page.reload();
  await expect(page.locator('.cad-feature-row')).toHaveCount(2);
  await expect(page.locator('.scene-statusbar')).toContainText(
    '5,717.257 mm³',
    { timeout: 30000 },
  );
  const downloadWait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'STEP', exact: true }).click();
  const download = await downloadWait;
  const path = info.outputPath('mounting-plate.step');
  await download.saveAs(path);
  const step = await readFile(path, 'utf8');
  expect(step).toContain('ISO-10303-21;');
  expect(step).toContain('CYLINDRICAL_SURFACE');
  expect(step).toMatch(
    /MANIFOLD_SOLID_BREP|ADVANCED_BREP_SHAPE_REPRESENTATION/,
  );
  await page
    .getByRole('button', { name: 'Mounting hole subtract', exact: false })
    .click();
  await capture(page, 'studio-cad-exact.png');
  const imported = await post(
    page,
    origin,
    `/projects/${project.id}/artifacts`,
    {
      title: 'Imported exact plate',
      kind: 'cad',
      content: { solids: [], unit: 'mm', grid: true },
    },
  );
  await open(page, project, imported);
  await page.getByLabel('STEP file', { exact: true }).setInputFiles(path);
  await expect(
    page.locator('.scene-import-list .scene-solid-item'),
  ).toHaveCount(1);
  await expect(page.locator('.scene-statusbar')).toContainText(
    '5,717.257 mm³',
    { timeout: 30000 },
  );
  await save(page);
  await page.reload();
  await expect(page.locator('.scene-statusbar')).toContainText(
    '5,717.257 mm³',
    { timeout: 30000 },
  );
  await page
    .getByRole('button', { name: 'Add circular sketch extrusion', exact: true })
    .click();
  await page
    .getByRole('spinbutton', { name: 'Feature radius', exact: true })
    .fill('2');
  await page
    .getByRole('spinbutton', { name: 'Sketch center U', exact: true })
    .fill('8');
  await page
    .getByRole('combobox', { name: 'Feature operation', exact: true })
    .selectOption('subtract');
  await expect(page.locator('.scene-statusbar')).toContainText(
    '5,591.593 mm³',
    { timeout: 30000 },
  );
  await save(page);
});

test('preserves scene materials, lighting, and embedded GLB hierarchy across uploads, save/reload, and export', async ({
  page,
}, info) => {
  const origin = originFor(info);
  const { project, artifact } = await create(
    page,
    origin,
    'scene',
    'Product scene with materials',
  );
  await open(page, project, artifact);
  await page
    .getByRole('textbox', { name: 'Object name', exact: true })
    .fill('Product housing');
  await page
    .getByRole('slider', { name: 'Material metalness', exact: true })
    .fill('0.7');
  await page
    .getByRole('slider', { name: 'Material roughness', exact: true })
    .fill('0.25');
  await page
    .getByRole('slider', { name: 'Ambient light', exact: true })
    .fill('1.6');
  await save(page);
  await page.reload();
  await expect(
    page.getByRole('textbox', { name: 'Object name', exact: true }),
  ).toHaveValue('Product housing');
  await expect(
    page.getByRole('slider', { name: 'Material metalness', exact: true }),
  ).toHaveValue('0.7');
  const downloadWait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'GLB', exact: true }).click();
  const download = await downloadWait;
  const path = info.outputPath('product.glb');
  await download.saveAs(path);
  const bytes = await readFile(path);
  expect(bytes.toString('ascii', 0, 4)).toBe('glTF');
  const json = JSON.parse(
    bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)),
  );
  expect(json.nodes.some((node: any) => node.name === 'Product housing')).toBe(
    true,
  );
  expect(json.materials[0].pbrMetallicRoughness.metallicFactor).toBe(0.7);
  const imported = await post(
    page,
    origin,
    `/projects/${project.id}/artifacts`,
    {
      title: 'Imported product assembly',
      kind: 'scene',
      content: { solids: [], unit: 'm', grid: true },
    },
  );
  await open(page, project, imported);
  await page.getByLabel('GLB or STL file', { exact: true }).setInputFiles(path);
  await expect(
    page.locator('.scene-import-list .scene-solid-item'),
  ).toHaveCount(1);
  await save(page);
  await page.reload();
  await expect(
    page.locator('.scene-import-list .scene-solid-item'),
  ).toHaveCount(1);
  await expect(page.locator('.scene-viewport canvas')).toBeVisible();
  const secondWait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'GLB', exact: true }).click();
  const second = await secondWait;
  const secondPath = info.outputPath('assembly.glb');
  await second.saveAs(secondPath);
  const result = await readFile(secondPath);
  const resultJson = JSON.parse(
    result.toString('utf8', 20, 20 + result.readUInt32LE(12)),
  );
  expect(
    resultJson.nodes.some((node: any) => node.name === 'Product housing'),
  ).toBe(true);
  await capture(page, 'studio-scene-import.png');
});

test('keeps exact CAD and import tools read-only for a project viewer', async ({
  page,
  browser,
}, info) => {
  const origin = originFor(info);
  const { project, artifact } = await create(
    page,
    origin,
    'cad',
    'Viewer CAD permissions',
  );
  const email = `cad-viewer-${crypto.randomUUID()}@example.test`;
  const context = await browser.newContext({ baseURL: origin });
  const viewer = await context.newPage();
  const actor=await signInBrowser(viewer,origin,email);
  const invitation = await post(
    page,
    origin,
    `/projects/${project.id}/members`,
    { userId:actor.id, role: 'viewer' },
  );
  expect(invitation).not.toHaveProperty('temporaryPassword');
  await open(viewer, project, artifact);
  await expect(
    viewer.getByRole('button', {
      name: 'Add rectangle sketch extrusion',
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    viewer.getByRole('button', { name: 'Import STEP solid', exact: true }),
  ).toBeDisabled();
  await expect(
    viewer.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  const write = await context.request.patch(`/api/artifacts/${artifact.id}`, {
    headers: { origin },
    data: {
      version: artifact.version,
      content: { solids: [], unit: 'mm', grid: true },
    },
  });
  expect(write.status()).toBe(403);
  await context.close();
});
