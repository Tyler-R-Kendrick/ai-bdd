import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, signInBrowser } from './browser-fixture.ts';
import { implementationPointer } from '../shared/implementation.ts';
import { paragraph } from '../shared/domain.ts';
const origin = 'http://127.0.0.1:8895',
  email = 'rebuild-owner@example.test',
  viewerEmail = 'rebuild-viewer@example.test';
const runtime = {
  adapter: 'acp' as const,
  executableName: 'explicit-browser-protocol-fixture',
  executableSha256: 'a'.repeat(64),
  argumentsSha256: 'b'.repeat(64),
  argumentFileSha256: null,
  model: null,
  provenance: 'connector-reported' as const,
};
let studio: Awaited<ReturnType<typeof createApp>>,
  dir: string,
  id: string,
  principal: any,
  owner: any,
  head = 'b'.repeat(40),
  repository = 'https://github.com/example/living-browser',
  branch: string;
const faults: string[] = [];
async function login(page: Page, user = email) {
  page.on('pageerror', (error) => faults.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 500)
      faults.push(response.url() + ':' + response.status());
  });
  await page.goto(origin);
  await signInBrowser(page, origin, user);
  await page.goto(origin);
  await expect(
    page.getByRole('button', { name: 'Build plan', exact: true }),
  ).toBeVisible();
}
async function panel(page: Page) {
  await page.getByRole('button', { name: 'Build plan', exact: true }).click();
  const region = page.getByRole('region', {
    name: 'Living document rebuild',
    exact: true,
  });
  await expect(region).toBeVisible();
  return region;
}
async function capture(page: Page, name: string) {
  const directory = process.env.STUDIO_CAPTURE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: resolve(directory, name + '.png'),
    animations: 'disabled',
    fullPage: true,
  });
}
test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-rebuild-ui-'));
  studio = await createApp(
    {
      origin,
      dataDir: dir,
      production: false,
      demo: false,
      adminEmail: email,
    },
    {
      db: ':memory:',
      clientDir: resolve(import.meta.dirname, '../dist/client'),
    },
  );
  owner = await studio.store.userByEmail(email);
  const project = (await studio.store.createProject(
    owner,
    'Living billing plan',
    'Existing-PR rebuild acceptance',
    repository,
  ))!;
  id = project.mainArtifactId;
  const initial = await studio.store.artifact(id, owner.id);
  const artifact = await studio.store.updateArtifact(
    owner,
    id,
    initial.version,
    {
      ...initial.content,
      doc: {
        type: 'doc',
        content: [
          paragraph(
            'Billing summaries show the current invoice total. Changes to this design rebuild its existing pull request.',
          ),
        ],
      },
    },
  );
  const machines = studio.integrations.machines,
    paired = await machines.pair(
      (await machines.pairing(owner, project.id, 'My billing workstation'))
        .code,
    );
  principal = await studio.store.one(
    'SELECT * FROM studio_machines WHERE id=?',
    paired.id,
  );
  await studio.investigations.registerCheckout(principal, {
    repository,
    sourceCommit: 'a'.repeat(40),
    branch: 'main',
  });
  const graph = await studio.graphs.edit({ user: owner, kind: 'human' }, id, {
    expected: null,
    planRevision: artifact.version,
    definition: {
      tasks: [
        {
          id: 'summary',
          title: 'Implement billing summary',
          description:
            'Keep the billing summary aligned with the approved living plan.',
          acceptanceCriteria: [
            'The summary reflects the current reviewed design.',
          ],
        },
      ],
      edges: [],
    },
  });
  const queued = await studio.implementationMachines.queue(owner, id, {
      expected: implementationPointer(graph),
    }),
    claimed = await studio.implementationMachines.claim(principal),
    lease = {
      leaseToken: claimed.leaseToken!,
      generation: claimed.work!.generation,
    };
  branch = claimed.work!.branch;
  const run = await studio.implementationMachines.start(principal, queued.id, {
    ...lease,
    checkout: {
      expected: claimed.work!.expected,
      repository,
      branch,
      commit: 'a'.repeat(40),
    },
  });
  for (const [key, command] of [
    ['start', { kind: 'start_task', taskId: 'summary' }],
    [
      'pr',
      {
        kind: 'report_pr',
        taskId: 'summary',
        pullRequest: { url: repository + '/pull/7', state: 'open' },
      },
    ],
    [
      'done',
      {
        kind: 'complete_task',
        taskId: 'summary',
        summary: 'Explicit initial-build protocol fixture',
      },
    ],
  ] as const)
    await studio.implementationMachines.report(principal, queued.id, {
      ...lease,
      report: { runId: run.id, idempotencyKey: key, command },
    });
  const verifier = await studio.implementationMachines.verifier(
    principal,
    queued.id,
    lease,
  );
  await studio.implementationMachines.report(principal, queued.id, {
    ...lease,
    verifierToken: verifier.verifierToken,
    report: {
      runId: run.id,
      idempotencyKey: 'independent-fixture',
      command: {
        kind: 'report_verification',
        verification: {
          summary:
            'Explicit independently scoped protocol completion, not a live GitHub build',
          tasks: [
            {
              taskId: 'summary',
              criteria: [
                {
                  index: 0,
                  passed: true,
                  evidence:
                    'Synthetic fixture supplies a complete initial lifecycle',
                },
              ],
            },
          ],
        },
      },
    },
  });
  studio.rebuilds.dependencies.resolvePullRequest = async (
    _user,
    repo,
    url,
  ) => ({ url, repository: repo, state: 'open', branch, commit: head });
  await studio.rebuilds.snapshot(owner, id);
  const viewer = await studio.store.createUser(
    viewerEmail,
    'Read-only reviewer',
    null,
  );
  await studio.store.exec(
    'INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?)',
    project.id,
    viewer.id,
    'viewer',
  );
  await studio.app.listen({ host: '127.0.0.1', port: 8895 });
});
test.afterAll(async () => {
  await studio?.app.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
test('living document rebuild preserves baseline, uses own machine, persists explicit automatic consent, and stays read-only for a fresh mobile viewer', async ({
  page,
  browser,
}) => {
  await login(page);
  const editor = page.locator('.tiptap[contenteditable="true"]');
  await expect(editor).toBeVisible();
  await editor.click();
  await editor.press('Control+End');
  await editor.press('Enter');
  await editor.type('Also show the tax amount alongside the invoice total.');
  await expect
    .poll(async () =>
      JSON.stringify((await studio.store.artifact(id, owner.id)).content),
    )
    .toContain('Also show the tax amount alongside the invoice total.');
  await expect
    .poll(async () => (await studio.rebuilds.snapshot(owner, id)).changes)
    .toBeGreaterThan(0);
  let view = await panel(page);
  await expect(
    view.getByRole('combobox', { name: 'Rebuild machine' }),
  ).toHaveValue(principal.id);
  await expect(
    view.getByRole('button', { name: 'Build changes', exact: true }),
  ).toBeEnabled();
  await view.scrollIntoViewIfNeeded();
  await capture(page, 'living-document-changes-desktop');
  await view
    .getByRole('button', { name: 'Build changes', exact: true })
    .click();
  await expect(
    view.getByText('Building changes', { exact: true }),
  ).toBeVisible();
  const claim = await studio.rebuilds.claim(principal),
    work = claim.work!,
    lease = { leaseToken: claim.leaseToken!, generation: work.generation };
  expect(work.pullRequests).toEqual([
    { url: repository + '/pull/7', branch, commit: head },
  ]);
  await studio.rebuilds.start(principal, work.id, {
    ...lease,
    pullRequests: work.pullRequests,
    runtime,
  });
  head = 'c'.repeat(40);
  const report = {
    idempotencyKey: 'explicit-protocol-implementation',
    sourceSha256: work.sourceSha256,
    summary:
      'Local protocol fixture updates the original PR branch; actual Git/ACP execution is tested separately',
    pullRequests: [
      {
        url: repository + '/pull/7',
        branch,
        commit: head,
        evidence:
          'Typed fixture supplies the original URL/branch and new exact head',
      },
    ],
    criteria: [
      {
        taskId: 'summary',
        index: 0,
        passed: true,
        evidence: 'Explicit synthetic evidence for UI lifecycle acceptance',
      },
    ],
  };
  await studio.rebuilds.report(principal, work.id, { ...lease, report });
  const verifier = await studio.rebuilds.verifier(principal, work.id, lease);
  await studio.rebuilds.report(principal, work.id, {
    ...lease,
    verifierToken: verifier.verifierToken,
    report: {
      ...report,
      idempotencyKey: 'independent-protocol-verification',
      summary:
        'A separately scoped verifier fixture completes this exact source/PR receipt',
    },
  });
  await expect(view.getByText('Built', { exact: true })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await studio.rebuilds.snapshot(owner, id)).baseline?.revision,
    )
    .toBe(2);
  await view.scrollIntoViewIfNeeded();
  await capture(page, 'living-document-verified-desktop');
  const consent = view.getByRole('checkbox');
  await consent.check();
  await expect
    .poll(
      async () => (await studio.rebuilds.snapshot(owner, id)).automaticEnabled,
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await editor.click();
  await editor.press('Control+End');
  await editor.press('Enter');
  await editor.type('Use a compact label for the tax amount.');
  await expect
    .poll(
      async () => {
        await studio.maintenance();
        return (await studio.rebuilds.snapshot(owner, id)).runs.find(
          (run) => run.status === 'queued',
        )?.automatic;
      },
      { timeout: 15000 },
    )
    .toBe(1);
  view = await panel(page);
  await expect(
    view.getByText('Building changes', { exact: true }),
  ).toBeVisible();
  await expect(view.getByRole('checkbox')).toBeChecked();
  await view.scrollIntoViewIfNeeded();
  await capture(page, 'living-document-automatic-desktop');
  await view.getByRole('button', { name: 'Stop rebuild', exact: true }).click();
  await view.getByRole('checkbox').uncheck();
  await expect
    .poll(
      async () => (await studio.rebuilds.snapshot(owner, id)).automaticEnabled,
    )
    .toBe(false);
  await page.reload();
  view = await panel(page);
  await expect(view.getByRole('checkbox')).not.toBeChecked();
  await expect(
    view.getByRole('button', { name: 'Retry changes', exact: true }),
  ).toBeEnabled();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    const viewer = await context.newPage();
    await login(viewer, viewerEmail);
    const readonly = await panel(viewer);
    await expect(
      readonly.getByRole('button', {
        name: /Build changes|Retry changes|Stop rebuild/,
      }),
    ).toHaveCount(0);
    await expect(readonly.getByRole('checkbox')).toHaveCount(0);
    const denied = await viewer.request.post(
      origin + `/api/artifacts/${id}/implementation/rebuild`,
      {
        headers: { origin },
        data: {
          expectedSourceSha256: (await studio.rebuilds.snapshot(owner, id))
            .currentSourceSha256,
        },
      },
    );
    expect(denied.status()).toBe(403);
    await readonly.scrollIntoViewIfNeeded();
    expect(
      await viewer.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await capture(viewer, 'living-document-viewer-mobile');
  } finally {
    await context.close();
  }
  expect(faults).toEqual([]);
});
