import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { initialContent, type ArtifactKind } from '../shared/domain.ts';
import { signInAcceptanceActor } from './browser-auth.ts';

async function openArtifact(
  page: Page,
  kind: ArtifactKind,
  content?: Record<string, unknown>,
) {
  const origin = 'http://127.0.0.1:8877';
  await signInAcceptanceActor(page);
  const projectResponse = await page.request.post('/api/projects', {
    headers: { origin },
    data: {
      title: `Visual acceptance ${crypto.randomUUID().slice(0, 8)}`,
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
      data: {
        kind,
        title: 'Visual acceptance artifact',
        ...(content ? { content } : {}),
      },
    },
  );
  expect(response.ok()).toBe(true);
  const artifact = await response.json();
  await page.goto(`/?project=${project.id}&artifact=${artifact.id}`);
  await expect(
    page.getByRole('button', { name: 'Add text', exact: true }),
  ).toBeVisible();
  return artifact;
}

test('image layers and uploaded typography persist and export as self-contained vector and raster assets', async ({
  page,
}) => {
  const artifact = await openArtifact(
    page,
    'brand',
    initialContent('brand', 'Build with intent.'),
  );
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 80;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#6b73d1';
    ctx.fillRect(0, 0, 120, 80);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  await page.getByLabel('Upload image file').setInputFiles({
    name: 'brand-image.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image, 'base64'),
  });
  await expect(page.locator('.visual-artboard image')).toBeVisible();
  await page.getByRole('spinbutton', { name: 'X', exact: true }).fill('1050');
  await page.getByRole('spinbutton', { name: 'X', exact: true }).press('Tab');
  await page.getByRole('spinbutton', { name: 'Y', exact: true }).fill('70');
  await page.getByRole('spinbutton', { name: 'Y', exact: true }).press('Tab');
  await page.getByRole('button', { name: 'Add text', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Layer text', exact: true })
    .fill('Crafted together');
  await page.getByRole('spinbutton', { name: 'X', exact: true }).fill('100');
  await page.getByRole('spinbutton', { name: 'X', exact: true }).press('Tab');
  await page.getByRole('spinbutton', { name: 'Y', exact: true }).fill('500');
  await page.getByRole('spinbutton', { name: 'Y', exact: true }).press('Tab');
  await page
    .getByRole('spinbutton', { name: 'Font size', exact: true })
    .fill('32');
  await page
    .getByRole('spinbutton', { name: 'Font size', exact: true })
    .press('Tab');
  const font = await readFile(
    resolve(
      import.meta.dirname,
      '../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
    ),
  );
  await page.getByLabel('Upload WOFF2 font').setInputFiles({
    name: 'inter.woff2',
    mimeType: 'font/woff2',
    buffer: font,
  });
  await expect(
    page.getByRole('combobox', { name: 'Typeface', exact: true }),
  ).toHaveValue('Custom');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  const stored = await (
    await page.request.get(`/api/artifacts/${artifact.id}`)
  ).json();
  expect(
    stored.artifact.content.layers.some(
      (layer: any) =>
        layer.type === 'image' && layer.src.startsWith('/api/files/'),
    ),
  ).toBe(true);
  expect(
    stored.artifact.content.layers.some(
      (layer: any) =>
        layer.text === 'Crafted together' &&
        layer.fontFamily === 'Custom' &&
        layer.fontUrl.startsWith('/api/files/'),
    ),
  ).toBe(true);
  const svgDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'SVG', exact: true }).click();
  const svg = await readFile((await (await svgDownload).path())!, 'utf8');
  expect(svg).toContain('data:image/png;base64,');
  expect(svg).toContain('data:font/woff2;base64,');
  expect(svg).not.toContain('href="/api/files/');
  const pngDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PNG', exact: true }).click();
  const png = await readFile((await (await pngDownload).path())!);
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  await page.reload();
  await expect(page.locator('.visual-artboard image')).toBeVisible();
  await expect(
    page
      .getByRole('complementary', { name: 'Composition layers' })
      .getByRole('button', { name: 'Crafted together', exact: true }),
  ).toBeVisible();
  await mkdir(resolve(import.meta.dirname, '../../../work/review'), {
    recursive: true,
  });
  await page.screenshot({
    path: resolve(import.meta.dirname, '../../../work/review/studio-brand.png'),
    fullPage: true,
  });
  const imageResponse = await page.request.post(
    `/api/projects/${artifact.projectId}/artifacts`,
    {
      headers: { origin: 'http://127.0.0.1:8877' },
      data: {
        kind: 'image',
        title: 'Editable campaign artwork',
        content: stored.artifact.content,
      },
    },
  );
  expect(imageResponse.ok()).toBe(true);
  const imageArtifact = await imageResponse.json();
  await page.goto(
    `/?project=${artifact.projectId}&artifact=${imageArtifact.id}`,
  );
  await expect(page.locator('.visual-artboard image')).toBeVisible();
  await page.screenshot({
    path: resolve(import.meta.dirname, '../../../work/review/studio-image.png'),
    fullPage: true,
  });
});

test('video canvas exports an actual encoded WebM from the timeline', async ({
  page,
}) => {
  const content = initialContent('video', 'A one-second composition');
  content.width = 640;
  content.height = 360;
  content.duration = 1;
  content.layers = content.layers.map((layer: any) => ({
    ...layer,
    x: 30,
    y: 120,
    width: 580,
    height: 140,
    fontSize: 40,
    duration: 1,
  }));
  await openArtifact(page, 'video', content);
  const download = page.waitForEvent('download', { timeout: 15000 });
  await page.getByRole('button', { name: 'WebM', exact: true }).click();
  const videoPath = test.info().outputPath('timeline.webm');
  await (await download).saveAs(videoPath);
  const bytes = await readFile(videoPath);
  expect(bytes.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
  expect(bytes.length).toBeGreaterThan(1000);
  await expect(
    page.getByRole('button', { name: 'WebM', exact: true }),
  ).toBeEnabled();
  await mkdir(resolve(import.meta.dirname, '../../../work/review'), {
    recursive: true,
  });
  await page.screenshot({
    path: resolve(import.meta.dirname, '../../../work/review/studio-video.png'),
    fullPage: true,
  });
});
