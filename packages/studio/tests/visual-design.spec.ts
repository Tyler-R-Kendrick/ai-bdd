import { expect, test, type Page } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { initialContent } from '../shared/domain.ts';
import { signInAcceptanceActor } from './browser-auth.ts';

async function open(page: Page, kind: 'brand' | 'image') {
  const origin = new URL(test.info().project.use.baseURL!).origin;
  await signInAcceptanceActor(page);
  const projectResponse = await page.request.post('/api/projects', {
    headers: { origin },
    data: {
      title: `Visual authoring ${crypto.randomUUID().slice(0, 6)}`,
      description: '',
      repository: '',
    },
  });
  expect(projectResponse.ok()).toBe(true);
  const project = await projectResponse.json();
  const response = await page.request.post(
    `/api/projects/${project.id}/artifacts`,
    {
      headers: { origin },
      data: { kind, title: 'STUDIO', content: initialContent(kind, 'STUDIO') },
    },
  );
  expect(response.ok()).toBe(true);
  const artifact = await response.json();
  await page.goto(`/?project=${project.id}&artifact=${artifact.id}`);
  await expect(
    page.getByRole('button', { name: 'Add text', exact: true }),
  ).toBeVisible();
  return { artifact, project, origin };
}
async function capture(page: Page, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [
        ...document.querySelectorAll<SVGImageElement>('.visual-artboard image'),
      ].map(async (node) => {
        const image = new Image();
        image.src = node.href.baseVal;
        await image.decode();
      }),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await mkdir(resolve(import.meta.dirname, '../../../work/review'), {
    recursive: true,
  });
  await page.screenshot({
    path: resolve(import.meta.dirname, `../../../work/review/${name}.png`),
    fullPage: true,
  });
}

test('authored glyphs export a browser-valid typeface and portable vector brand project', async ({
  page,
}) => {
  test.setTimeout(90000);
  const { artifact, project, origin } = await open(page, 'brand');
  await page
    .getByRole('complementary', { name: 'Composition layers' })
    .getByRole('button', { name: 'STUDIO', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Design typeface', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Typeface designer' }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Designed font family', exact: true })
    .fill('Studio Authored');
  await page
    .getByRole('spinbutton', { name: 'Glyph advance width', exact: true })
    .fill('720');
  await page.locator('.design-outline-point').nth(1).click();
  await page
    .getByRole('spinbutton', { name: 'Outline point X', exact: true })
    .fill('155');
  await page
    .getByRole('textbox', { name: 'New glyph character', exact: true })
    .fill('@');
  await page.getByRole('button', { name: 'Add glyph', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Glyph character', exact: true })
    .selectOption('A');
  const fontDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export TTF', exact: true }).click();
  const bytes = await readFile((await (await fontDownload).path())!);
  const independent = await page.evaluate(
    async (values) => {
      const font = new FontFace(
        'IndependentFontParse',
        new Uint8Array(values).buffer,
      );
      await font.load();
      document.fonts.add(font);
      const canvas = document.createElement('canvas');
      canvas.width = 100;
      canvas.height = 100;
      const ctx = canvas.getContext('2d')!;
      ctx.font = '40px IndependentFontParse';
      ctx.fillText('A', 5, 60);
      return {
        loaded: font.status,
        width: ctx.measureText('A').width,
        pixels: [...ctx.getImageData(0, 0, 100, 100).data].filter(
          (n, i) => i % 4 === 3 && n > 0,
        ).length,
      };
    },
    [...bytes],
  );
  expect(independent.loaded).toBe('loaded');
  expect(independent.width).toBeCloseTo(28.8, 1);
  expect(independent.pixels).toBeGreaterThan(100);
  await capture(page, 'studio-authored-typeface');
  await page
    .getByRole('button', { name: 'Use in selected text', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Add vector path', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Vector outline', exact: true }),
  ).toBeVisible();
  await page.locator('.design-outline-point').first().click();
  await page
    .getByRole('spinbutton', { name: 'Outline point X', exact: true })
    .fill('42');
  await page
    .getByRole('button', { name: 'Back to canvas', exact: true })
    .click();
  await page
    .getByRole('spinbutton', { name: 'Opacity · percent', exact: true })
    .fill('65');
  await page
    .getByRole('spinbutton', { name: 'Opacity · percent', exact: true })
    .press('Tab');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  const svgDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'SVG', exact: true }).click();
  const svg = await readFile((await (await svgDownload).path())!, 'utf8');
  expect(svg).toContain('data:font/ttf;base64,');
  expect(svg).toContain('opacity="0.65"');
  const projectDownload = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export visual project', exact: true })
    .click();
  const projectBytes = await readFile((await (await projectDownload).path())!);
  const pack = JSON.parse(projectBytes.toString());
  expect(
    pack.content.fontDesign.glyphs.some((g: any) => g.character === '@'),
  ).toBe(true);
  const response = await page.request.post(
    `/api/projects/${project.id}/artifacts`,
    {
      headers: { origin },
      data: { kind: 'brand', title: 'Restored visual project' },
    },
  );
  expect(response.ok()).toBe(true);
  const restored = await response.json();
  await page.goto(`/?project=${project.id}&artifact=${restored.id}`);
  await page.getByLabel('Import visual project file').setInputFiles({
    name: 'design.studio-design.json',
    mimeType: 'application/json',
    buffer: projectBytes,
  });
  await expect(page.locator('.visual-artboard path').first()).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  const saved = await (
    await page.request.get(`/api/artifacts/${restored.id}`)
  ).json();
  expect(saved.artifact.content.fontDesign.family).toBe('Studio Authored');
  expect(
    saved.artifact.content.layers.some(
      (l: any) => l.type === 'path' && l.path.contours[0][0].x === 42,
    ),
  ).toBe(true);
  await page.reload();
  await expect(page.locator('.visual-artboard path').first()).toBeVisible();
  await capture(page, 'studio-authored-vector-brand');
});

test('raster masks, adjustments and edge matte persist and re-import their own uploaded assets', async ({
  page,
}) => {
  test.setTimeout(90000);
  const { artifact, project, origin } = await open(page, 'image');
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 100, 100);
    ctx.fillStyle = '#6b73d1';
    ctx.fillRect(20, 20, 60, 60);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  await page.getByLabel('Upload image file').setInputFiles({
    name: 'matte-fixture.png',
    mimeType: 'image/png',
    buffer: Buffer.from(encoded, 'base64'),
  });
  await expect(page.locator('.visual-artboard image')).toBeVisible();
  for (const [name, value] of [
    ['X', '280'],
    ['Y', '60'],
    ['Width', '700'],
    ['Height', '600'],
  ]) {
    await page.getByRole('spinbutton', { name, exact: true }).fill(value!);
    await page.getByRole('spinbutton', { name, exact: true }).press('Tab');
  }
  await page
    .getByRole('button', { name: 'Remove edge color', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Remove edge color', exact: true }),
  ).toBeEnabled();
  const afterMatte = page.locator('.visual-artboard image');
  const url = await afterMatte.getAttribute('href');
  const pixels = await page.evaluate(async (url) => {
    const image = new Image();
    image.src = url!;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    return {
      corner: ctx.getImageData(0, 0, 1, 1).data[3],
      center: ctx.getImageData(50, 50, 1, 1).data[3],
    };
  }, url);
  expect(pixels).toEqual({ corner: 0, center: 255 });
  await page
    .getByRole('spinbutton', { name: 'Crop width · percent', exact: true })
    .fill('70');
  await page
    .getByRole('spinbutton', { name: 'Crop width · percent', exact: true })
    .press('Tab');
  await page
    .getByRole('combobox', { name: 'Image mask', exact: true })
    .selectOption('path');
  await page
    .getByRole('button', { name: 'Edit mask outline', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Image mask outline', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Back to canvas', exact: true })
    .click();
  await page
    .getByRole('spinbutton', { name: 'Saturation', exact: true })
    .fill('0.5');
  await page
    .getByRole('spinbutton', { name: 'Saturation', exact: true })
    .press('Tab');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  const stored = await (
    await page.request.get(`/api/artifacts/${artifact.id}`)
  ).json();
  const raster = stored.artifact.content.layers.find(
    (l: any) => l.type === 'image',
  );
  expect(raster.crop.width).toBe(0.7);
  expect(raster.mask).toBe('path');
  expect(raster.filters.saturation).toBe(0.5);
  const projectDownload = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export visual project', exact: true })
    .click();
  const projectBytes = await readFile((await (await projectDownload).path())!);
  const pack = JSON.parse(projectBytes.toString());
  expect(pack.assets).toHaveLength(1);
  expect(pack.assets[0].data.startsWith('data:image/png;base64,')).toBe(true);
  const response = await page.request.post(
    `/api/projects/${project.id}/artifacts`,
    { headers: { origin }, data: { kind: 'image', title: 'Portable raster' } },
  );
  const restored = await response.json();
  await page.goto(`/?project=${project.id}&artifact=${restored.id}`);
  await page.getByLabel('Import visual project file').setInputFiles({
    name: 'raster.studio-design.json',
    mimeType: 'application/json',
    buffer: projectBytes,
  });
  await expect(page.locator('.visual-artboard image')).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  const restoredBundle = await (
    await page.request.get(`/api/artifacts/${restored.id}`)
  ).json();
  expect(
    restoredBundle.artifact.content.layers.find((l: any) => l.type === 'image')
      .src,
  ).not.toBe(raster.src);
  await page
    .getByRole('complementary', { name: 'Composition layers' })
    .getByRole('button', { name: 'matte-fixture.png', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Crop and mask', exact: true })
    .scrollIntoViewIfNeeded();
  const board = await page.locator('.visual-artboard').boundingBox();
  const screenshot = await page.screenshot();
  const painted = await page.evaluate(
    async ({ encoded, x, y }) => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + encoded;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      return [...ctx.getImageData(x, y, 1, 1).data];
    },
    {
      encoded: screenshot.toString('base64'),
      x: Math.round(board!.x + (620 / 1280) * board!.width),
      y: Math.round(board!.y + (350 / 720) * board!.height),
    },
  );
  // Inspect actual compositor pixels: SVG element visibility alone misses filtered-image repaint failures.
  expect(painted[2]! - painted[0]!).toBeGreaterThan(20);
  await capture(page, 'studio-raster-design-tools');
});
