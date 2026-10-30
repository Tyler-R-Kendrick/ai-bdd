import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PlannerView } from '../shared/account-planners.ts';
const id = '00000000-0000-4000-8000-000000000001';
const device = '00000000-0000-4000-8000-000000000002';
const busyDevice = '00000000-0000-4000-8000-000000000003';
function initial(): PlannerView {
  return {
    enabled: true,
    blockedByOtherWriter: false,
    assignment: null,
    devices: [
      {
        id: device,
        label: 'My workstation',
        status: 'available',
        reason: null,
        checkoutKey: 'workstation',
      },
      {
        id: busyDevice,
        label: 'My build machine',
        status: 'busy',
        reason: 'Finishing another approved task',
        checkoutKey: 'build',
      },
    ],
  };
}
async function fixture(page: Page, view = initial()) {
  const writes: { path: string; body: any }[] = [];
  const errors: string[] = [];
  let rejectLaunch = false;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 500) errors.push('HTTP ' + response.status());
  });
  await page.route('**/api/artifacts/*/planners**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: view });
    writes.push({
      path: new URL(request.url()).pathname,
      body: request.postDataJSON(),
    });
    if (rejectLaunch)
      return route.fulfill({
        status: 409,
        json: {
          error:
            'The artifact changed. Review its current revision before launching.',
        },
      });
    if (request.url().endsWith('/stop')) view.assignment!.status = 'stopped';
    else
      view.assignment = {
        id: '00000000-0000-4000-8000-000000000004',
        deviceId: request.postDataJSON().deviceId,
        artifactId: new URL(request.url()).pathname.split('/')[3]!,
        projectId: '00000000-0000-4000-8000-000000000005',
        repository: 'https://github.com/example/planner',
        checkoutKey: 'build',
        epoch: 2,
        status: 'queued',
        artifactVersion: request.postDataJSON().artifactVersion,
        sourceHash: 'a'.repeat(64),
        profile: {
          harness: 'remote-planner',
          provider: 'operator',
          model: 'unknown',
        },
        expiresAt: null,
        idleExpiresAt: new Date(Date.now() + 120000).toISOString(),
      };
    return route.fulfill({ json: { ok: true } });
  });
  return {
    view,
    writes,
    errors,
    reject: () => {
      rejectLaunch = true;
    },
  };
}
test('queues on an own busy device, shows actual queued state and stops with its exact epoch', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/tests/fixtures/account-planner.html');
  await page.getByLabel('Your connected device').selectOption(busyDevice);
  await expect(page.getByText('Finishing another approved task')).toBeVisible();
  await page.getByRole('button', { name: 'Queue on device' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Queued for your device',
  );
  expect(f.writes[0]).toEqual({
    path: '/api/artifacts/' + id + '/planners',
    body: { deviceId: busyDevice, artifactVersion: 7 },
  });
  const evidence = resolve('../../work/review/account-planner');
  await mkdir(evidence, { recursive: true });
  await page
    .getByRole('region', { name: 'Planner on your device' })
    .screenshot({ path: resolve(evidence, 'desktop-queued.png') });
  await page.getByRole('button', { name: 'Stop device session' }).click();
  await expect(page.getByRole('status')).toContainText('The session stopped');
  expect(f.writes[1]).toEqual({
    path:
      '/api/artifacts/' +
      id +
      '/planners/00000000-0000-4000-8000-000000000004/stop',
    body: { epoch: 2 },
  });
  await expect(page.getByRole('button', { name: 'Queue again' })).toBeVisible();
  expect(f.errors).toEqual([]);
});
test('preserves own device choice on a source conflict and excludes peer-writer controls', async ({
  page,
}) => {
  const f = await fixture(page);
  f.reject();
  await page.goto('/tests/fixtures/account-planner.html');
  await page.getByLabel('Your connected device').selectOption(busyDevice);
  await page.getByRole('button', { name: 'Queue on device' }).click();
  await expect(page.getByRole('alert')).toContainText('artifact changed');
  await expect(page.getByLabel('Your connected device')).toHaveValue(
    busyDevice,
  );
  f.view.blockedByOtherWriter = true;
  await page.reload();
  await expect(
    page.getByText('Another writer currently owns this Planner.'),
  ).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  expect(f.errors).toEqual([]);
});
test('keeps mobile viewers read-only and never posts a launch or stop', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tests/fixtures/account-planner.html?viewer');
  await expect(page.getByText('You have read-only access.')).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const evidence = resolve('../../work/review/account-planner');
  await mkdir(evidence, { recursive: true });
  await page
    .getByRole('region', { name: 'Planner on your device' })
    .screenshot({ path: resolve(evidence, 'mobile-viewer.png') });
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});
test('uses the current artifact revision after incoming source updates and disables offline devices', async ({
  page,
}) => {
  const f = await fixture(page);
  f.view.devices[0]!.status = 'offline';
  f.view.devices[1]!.status = 'offline';
  await page.goto('/tests/fixtures/account-planner.html');
  await expect(
    page.getByRole('button', { name: 'Launch on device' }),
  ).toBeDisabled();
  f.view.devices[0]!.status = 'available';
  await page.evaluate(() =>
    (window as any).accountPlannerFixture.setArtifact({
      id: '00000000-0000-4000-8000-000000000006',
      version: 8,
    }),
  );
  await expect(
    page.getByRole('button', { name: 'Launch on device' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Launch on device' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Queued for your device',
  );
  expect(f.writes[0]).toEqual({
    path: '/api/artifacts/00000000-0000-4000-8000-000000000006/planners',
    body: { deviceId: device, artifactVersion: 8 },
  });
  expect(f.errors).toEqual([]);
});
