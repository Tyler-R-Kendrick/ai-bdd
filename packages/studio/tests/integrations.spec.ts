import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { signInAcceptanceActor } from './browser-auth.ts';

const origin = 'http://127.0.0.1:8877';
test('keeps machine work approved, reviewable, scoped, and separate from test evidence', async ({
  page,
}) => {
  await signInAcceptanceActor(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const call = async (
    path: string,
    method = 'POST',
    data?: unknown,
    token?: string,
  ) => {
    const response = await page.request.fetch('/api' + path, {
      method,
      headers: {
        origin,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(data === undefined ? {} : { data }),
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const project = await call('/projects', 'POST', {
    title: 'Connected artifact collaboration',
    description: 'Synthetic review project for approved local-machine work.',
    repository: '',
  });
  const artifact = await call(`/projects/${project.id}/artifacts`, 'POST', {
    kind: 'code',
    title: 'Reviewed prototype',
  });
  await page.goto(`/?project=${project.id}&artifact=${artifact.id}`);
  await page.getByRole('tab', { name: 'Connections', exact: true }).click();
  const panel = page.getByLabel('Artifact connections', { exact: true });
  await expect(
    panel.getByText('No machines are paired with this project.'),
  ).toBeVisible();
  await panel.getByRole('button', { name: 'Pause agent', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: 'Resume agent', exact: true }),
  ).toBeVisible();
  const policy = await call(
    `/artifacts/${artifact.id}/integrations/policy`,
    'GET',
  );
  expect(policy.paused).toBe(true);
  await panel
    .getByLabel('Machine name', { exact: true })
    .fill('Review workstation');
  await panel
    .getByRole('button', { name: 'Pair a machine', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Pair your machine' });
  const code = await dialog
    .getByLabel('One-time pairing code', { exact: true })
    .inputValue();
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const machine = await call('/machines/pair', 'POST', { code });
  await dialog
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await panel
    .getByRole('button', {
      name: 'Refresh artifact connections',
      exact: true,
    })
    .click();
  await expect(
    panel.getByText('Review workstation', { exact: true }),
  ).toBeVisible();
  await panel
    .getByLabel('Approved brief', { exact: true })
    .fill(
      'Propose a clearer prototype heading. Keep the result for team review.',
    );
  await panel
    .getByRole('button', { name: 'Approve machine work', exact: true })
    .click();
  await expect(panel.getByText('Queued', { exact: true })).toBeVisible();
  const claimed = await call(
    `/machines/${machine.id}/claim`,
    'POST',
    undefined,
    machine.token,
  );
  expect(claimed.work.artifact.id).toBe(artifact.id);
  const content = {
    ...claimed.work.artifact.content,
    files: {
      ...claimed.work.artifact.content.files,
      'index.html': '<h1>Reviewed connected result</h1>',
    },
  };
  await call(
    `/machines/${machine.id}/work/${claimed.work.id}/complete`,
    'POST',
    {
      leaseToken: claimed.leaseToken,
      summary: 'A proposed heading from the connected review workstation.',
      content,
    },
    machine.token,
  );
  await panel
    .getByRole('button', {
      name: 'Refresh artifact connections',
      exact: true,
    })
    .click();
  await expect(
    panel.getByText('Awaiting review', { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Apply proposal', exact: true }),
  ).toBeDisabled();
  const unchanged = await call(`/artifacts/${artifact.id}`, 'GET');
  expect(unchanged.artifact.version).toBe(artifact.version);
  expect(unchanged.runs).toHaveLength(0);
  const [proposalDownload] = await Promise.all([
    page.waitForEvent('download'),
    panel
      .getByRole('button', { name: 'Download full proposal', exact: true })
      .click(),
  ]);
  expect(proposalDownload.suggestedFilename()).toBe(
    'machine-proposal-code.json',
  );
  await panel.getByLabel('I reviewed this result.', { exact: true }).check();
  await panel
    .getByRole('button', { name: 'Apply proposal', exact: true })
    .click();
  await expect(panel.getByText('Accepted', { exact: true })).toBeVisible();
  const accepted = await call(`/artifacts/${artifact.id}`, 'GET');
  expect(accepted.artifact.content.files['index.html']).toContain(
    'Reviewed connected result',
  );
  expect(accepted.runs).toHaveLength(0);
  await expect(
    panel.getByText('Not connected', { exact: true }).first(),
  ).toBeVisible(); // Open Design is honestly unconfigured in this fixture.
  await mkdir(resolve('../../work/review'), { recursive: true });
  await page.screenshot({
    path: resolve('../../work/review/studio-connections.png'),
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
});

test('shows shared connections to a fresh viewer without exposing write or pairing controls', async ({
  page,
  browser,
}) => {
  await signInAcceptanceActor(page);
  const call = async (path: string, method = 'POST', data?: unknown) => {
    const response = await page.request.fetch('/api' + path, {
      method,
      headers: { origin },
      ...(data === undefined ? {} : { data }),
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const project = await call('/projects', 'POST', {
    title: 'Shared research context',
    description: 'Synthetic read-only collaboration review.',
    repository: '',
  });
  await call(
    `/artifacts/${project.mainArtifactId}/integrations/policy`,
    'PUT',
    { mode: 'manual', paused: true },
  );
  const email = `connections-viewer-${Date.now()}@example.test`;
  const invitation = await call(`/projects/${project.id}/members`, 'POST', {
    email,
    name: 'Read-only teammate',
    role: 'viewer',
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    const response = await context.request.post(origin + '/api/auth/login', {
      headers: { origin },
      data: { email, password: invitation.temporaryPassword },
    });
    expect(response.ok()).toBe(true);
    const viewer = await context.newPage();
    await viewer.goto(
      `${origin}/?project=${project.id}&artifact=${project.mainArtifactId}`,
    );
    await viewer
      .getByRole('button', { name: 'Show artifact panel', exact: true })
      .click();
    await viewer.getByRole('tab', { name: 'Connections', exact: true }).click();
    const panel = viewer.getByLabel('Artifact connections', { exact: true });
    await expect(panel.getByText('Paused', { exact: true })).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Resume agent', exact: true }),
    ).toBeDisabled();
    await expect(
      panel.getByRole('combobox', { name: 'Participation mode', exact: true }),
    ).toBeDisabled();
    await expect(
      panel.getByRole('button', { name: 'Pair a machine', exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByRole('button', {
        name: 'Approve machine work',
        exact: true,
      }),
    ).toHaveCount(0);
    const denied = await context.request.put(
      origin + `/api/artifacts/${project.mainArtifactId}/integrations/policy`,
      { headers: { origin }, data: { mode: 'automatic', paused: false } },
    );
    expect(denied.status()).toBe(403);
    await mkdir(resolve('../../work/review'), { recursive: true });
    await viewer.screenshot({
      path: resolve('../../work/review/studio-connections-viewer-mobile.png'),
      animations: 'disabled',
    });
  } finally {
    await context.close();
  }
});
