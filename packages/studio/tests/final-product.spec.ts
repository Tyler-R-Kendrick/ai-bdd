import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.ts';
import { passwordHash, type Settings } from '../server/auth.ts';
import type { InvestigationResult } from '../shared/investigations.ts';
const password = 'fixture-only-browser-password-123';
const generated = (text: string) => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  },
  warnings: [],
});
const captureDirectory = process.env.STUDIO_CAPTURE_DIR;
async function capture(page: Page, name: string) {
  if (!captureDirectory) return;
  await mkdir(captureDirectory, { recursive: true });
  await page.screenshot({
    path: resolve(captureDirectory, name),
    animations: 'disabled',
    fullPage: true,
  });
}
async function fixture(cards: boolean, model = false) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-product-browser-'));
  const modelRequests: any[] = [],
    searchRequests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const input = body ? JSON.parse(body) : null;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/sources') {
      searchRequests.push(input);
      res.end(
        JSON.stringify({
          sources: [
            {
              title: 'Contract preview fixture',
              url: 'https://docs.pact.io/',
              excerpt:
                'Pact verifies consumer/provider contracts across a declared integration boundary.',
            },
          ],
        }),
      );
      return;
    }
    modelRequests.push(input);
    const prompt = JSON.stringify(input);
    if (prompt.includes('Extract at most four useful')) {
      const messages = input.prompt as any[];
      let snapshot: any;
      for (const message of messages ?? []) {
        if (message.role !== 'user') continue;
        for (const content of Array.isArray(message.content)
          ? message.content
          : [{ text: message.content }]) {
          try {
            const parsed = JSON.parse(content.text);
            if (parsed.messages) snapshot = parsed;
          } catch {}
        }
      }
      if (!snapshot) {
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            error:
              'The real gateway request omitted its immutable conversation snapshot',
          }),
        );
        return;
      }
      const source = snapshot.messages.at(-1),
        research = source.body.includes(
          'Research the preview boundary options.',
        );
      const offer = {
        kind: research ? 'research' : 'decision',
        title: research
          ? 'Investigate preview boundaries'
          : 'Choose the preview boundary',
        rationale:
          'This discussion requests a reviewable integration boundary.',
        question: 'Which preview boundary should the team use?',
        options: ['Contract fixture', 'Direct integration'],
        brief:
          'Compare contract fixtures and direct integrations for live previews.',
        evidenceMessageIds: [source.id],
        sourceQuote: research
          ? 'Research the preview boundary options.'
          : 'Decide the preview boundary.',
      };
      res.end(JSON.stringify(generated(JSON.stringify({ offers: [offer] }))));
      return;
    }
    if (prompt.includes('Return one concise artifact title')) {
      res.end(JSON.stringify(generated('Preview boundary findings')));
      return;
    }
    res.end(
      JSON.stringify(
        generated(
          'The retrieved Pact source describes consumer and provider contract verification [1]. A contract fixture can exercise this boundary independently. This synthetic gateway response does not measure a production integration.',
        ),
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const priorFlag = process.env.STUDIO_CONVERSATION_CARDS,
    priorKey = process.env.AI_GATEWAY_API_KEY;
  process.env.STUDIO_CONVERSATION_CARDS = cards ? '1' : '0';
  process.env.AI_GATEWAY_API_KEY = 'fixture-only-browser-gateway-key';
  const settings: Settings = {
    production: false,
    origin: 'http://127.0.0.1:8878',
    dataDir: directory,
    demo: false,
    ...(model
      ? {
          model: 'fixture/model',
          integrations: {
            gatewayBaseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
            searchUrl: `http://127.0.0.1:${(server.address() as any).port}/sources`,
          },
        }
      : {}),
  };
  let instance: Awaited<ReturnType<typeof createApp>>;
  try {
    instance = await createApp(settings, {
      db: ':memory:',
      clientDir: resolve(import.meta.dirname, '../dist/client'),
    });
  } finally {
    if (priorFlag === undefined) delete process.env.STUDIO_CONVERSATION_CARDS;
    else process.env.STUDIO_CONVERSATION_CARDS = priorFlag;
  }
  const user = await instance.store.createUser(
    'owner@product-browser.test',
    'Evidence owner',
    await passwordHash(password),
  );
  const address = await instance.app.listen({ host: '127.0.0.1', port: 0 });
  settings.origin = address;
  async function login(page: Page, email = user.email, credential = password) {
    await page.goto(address);
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(credential);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'New project', exact: true }).first(),
    ).toBeVisible();
  }
  async function selectFx(page: Page) {
    await page.getByRole('tab', { name: 'Connections', exact: true }).click();
    const profile = page.getByRole('region', {
      name: 'Agent runtime',
      exact: true,
    });
    await expect(
      profile.getByRole('combobox', { name: 'Agent harness', exact: true }),
    ).toHaveValue('t3-code');
    await expect(profile.getByText('Offline', { exact: true })).toBeVisible();
    await capture(page, 'agent-profile-default-t3-offline.png');
    await profile
      .getByRole('combobox', { name: 'Agent harness', exact: true })
      .selectOption('vercel-fx');
    await expect(
      profile.getByRole('combobox', { name: 'Model provider', exact: true }),
    ).toHaveValue('ai-gateway');
    await expect(
      profile.getByRole('combobox', { name: 'Agent model', exact: true }),
    ).toHaveValue('fixture/model');
    await profile
      .getByRole('button', { name: 'Save agent runtime', exact: true })
      .click();
    await expect(
      profile.getByText('Agent runtime saved.', { exact: true }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole('tab', { name: 'Connections', exact: true }).click();
    await expect(
      profile.getByRole('combobox', { name: 'Agent harness', exact: true }),
    ).toHaveValue('vercel-fx');
    await expect(
      profile.getByRole('combobox', { name: 'Agent model', exact: true }),
    ).toHaveValue('fixture/model');
    await capture(page, 'agent-profile-explicit-fx.png');
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  }
  const call = async (
    page: Page,
    path: string,
    method = 'POST',
    data?: unknown,
    token?: string,
  ) => {
    const response = await page.request.fetch(address + '/api' + path, {
      method,
      headers: {
        origin: address,
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      ...(data === undefined ? {} : { data }),
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const close = async () => {
    await instance.app.close();
    await new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
    await rm(directory, { recursive: true, force: true });
    if (priorKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = priorKey;
  };
  return {
    instance,
    selectFx,
    address,
    user,
    login,
    call,
    close,
    modelRequests,
    searchRequests,
  };
}
test('operator-disabled conversation suggestions stay absent in the full application', async ({
  page,
}) => {
  const f = await fixture(false);
  try {
    await f.login(page);
    const project = await f.call(page, '/projects', 'POST', {
      title: 'Default capability boundary',
      description: '',
      repository: '',
    });
    await page.goto(
      `${f.address}/?project=${project.id}&artifact=${project.mainArtifactId}`,
    );
    await expect(
      page.getByLabel('Document editor', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Conversation suggestions' }),
    ).toHaveCount(0);
    const bundle = await f.call(
        page,
        '/artifacts/' + project.mainArtifactId,
        'GET',
      ),
      capability = await f.call(
        page,
        `/artifacts/${project.mainArtifactId}/conversation?threadId=${bundle.threads[0].id}`,
        'GET',
      );
    expect(capability.enabled).toBe(false);
    expect(f.modelRequests).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test('actual model offers publish a reviewable questionnaire and start only the exact explicitly edited research brief', async ({
  page,
}) => {
  test.setTimeout(120000);
  const f = await fixture(true, true),
    errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await f.login(page);
    const project = await f.call(page, '/projects', 'POST', {
        title: 'Conversation-derived planning',
        description: 'Synthetic local gateway acceptance.',
        repository: '',
      }),
      researchId = project.mainArtifactId;
    await page.goto(
      `${f.address}/?project=${project.id}&artifact=${researchId}`,
    );
    await expect(
      page.getByLabel('Document editor', { exact: true }),
    ).toBeVisible();
    const initial = await f.call(page, '/artifacts/' + researchId, 'GET');
    const unavailable = await page.request.post(
      f.address + '/api/artifacts/' + researchId + '/agent',
      {
        headers: { origin: f.address },
        data: { intent: 'chat', threadId: initial.threads[0].id },
      },
    );
    expect(unavailable.status(), await unavailable.text()).toBe(503);
    expect((await unavailable.json()).error).toContain('T3 Code');
    expect(f.modelRequests).toHaveLength(0);
    await f.selectFx(page);
    await page
      .getByLabel('Message this artifact', { exact: true })
      .fill(
        'Research the preview boundary options. Keep the exact approved brief.',
      );
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    const offers = page.getByRole('region', {
      name: 'Conversation suggestions',
    });
    await expect(
      offers.getByText('Investigate preview boundaries', { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    expect(f.searchRequests).toHaveLength(0);
    expect(
      (
        await f.call(page, `/artifacts/${researchId}/integrations/jobs`, 'GET')
      ).jobs.filter((j: any) => j.intent === 'research'),
    ).toHaveLength(0);
    const brief =
      'Compare Pact consumer verification and provider states for this exact live preview boundary.';
    await offers
      .getByRole('textbox', { name: 'Exact research brief', exact: true })
      .fill(brief);
    await offers
      .getByRole('button', { name: 'Start research', exact: true })
      .click();
    await expect(
      offers.getByRole('button', { name: 'Research started', exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await expect
      .poll(
        async () => {
          const result = await f.call(
            page,
            `/artifacts/${researchId}/integrations/jobs`,
            'GET',
          );
          return result.jobs.find((j: any) => j.intent === 'research')?.status;
        },
        { timeout: 30000 },
      )
      .toBe('completed');
    expect(f.searchRequests).toEqual([{ query: brief, limit: 8 }]);
    const jobs = await f.call(
        page,
        `/artifacts/${researchId}/integrations/jobs`,
        'GET',
      ),
      job = jobs.jobs.find((j: any) => j.intent === 'research');
    expect(job.brief).toBe(brief);
    expect(job.childArtifactId).toBeTruthy();
    const child = await f.call(
      page,
      '/artifacts/' + job.childArtifactId,
      'GET',
    );
    expect(JSON.stringify(child.artifact.content)).toContain(
      'https://docs.pact.io/',
    );
    await page.locator('.document-research').scrollIntoViewIfNeeded();
    await capture(page, 'conversation-research-desktop.png');
    const doc = await f.call(
      page,
      `/projects/${project.id}/artifacts`,
      'POST',
      { kind: 'document', title: 'Boundary decision review' },
    );
    await page.goto(`${f.address}/?project=${project.id}&artifact=${doc.id}`);
    await f.selectFx(page);
    await page
      .getByLabel('Message this artifact', { exact: true })
      .fill(
        'Decide the preview boundary. Capture both alternatives for team review.',
      );
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    const decisions = page.getByRole('region', {
      name: 'Conversation suggestions',
    });
    await expect(
      decisions.getByText('Choose the preview boundary', { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await decisions
      .getByRole('button', { name: 'Publish for review', exact: true })
      .click();
    const questionnaire = page.locator(
      '[data-component-kind="questionnaireBlock"]',
    );
    await expect(questionnaire).toContainText(
      'Which preview boundary should the team use?',
    );
    expect(
      (await f.call(page, '/artifacts/' + doc.id, 'GET')).decisions.every(
        (d: any) => d.status === 'proposed',
      ),
    ).toBe(true);
    await questionnaire
      .getByRole('radio', { name: 'Contract fixture', exact: true })
      .check();
    await questionnaire
      .getByRole('textbox', {
        name: 'Reason for Which preview boundary should the team use?',
        exact: true,
      })
      .fill(
        'The declared contract keeps live preview independent of provider availability.',
      );
    await questionnaire
      .getByRole('button', { name: 'Save your answer', exact: true })
      .click();
    await questionnaire
      .getByRole('button', { name: 'Accept as decision', exact: true })
      .click();
    await expect(
      questionnaire.getByRole('button', { name: 'Accepted ADR', exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      questionnaire.getByRole('button', { name: 'Accepted ADR', exact: true }),
    ).toBeVisible();
    await capture(page, 'conversation-questionnaire-desktop.png');
    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
});
test('a real owner-approved investigation publishes inline native evidence, shared selections and an attributed decision across reload and viewer access', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const f = await fixture(false),
    errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let viewerContext: BrowserContext | undefined;
  try {
    await f.login(page);
    const project = await f.call(page, '/projects', 'POST', {
        title: 'Measured preview boundary',
        description: 'Synthetic local machine protocol acceptance.',
        repository: 'https://github.com/example/preview-boundary',
      }),
      artifactId = project.mainArtifactId;
    const pairing = await f.call(
        page,
        `/projects/${project.id}/machines/pairing`,
        'POST',
        { label: 'Evidence workstation' },
      ),
      machine = await f.call(page, '/machines/pair', 'POST', {
        code: pairing.code,
      });
    await f.call(
      page,
      `/machines/${machine.id}/investigations/checkout`,
      'POST',
      {
        repository: 'https://github.com/example/preview-boundary',
        sourceCommit: '1'.repeat(40),
        branch: 'main',
      },
      machine.token,
    );
    await page.goto(
      `${f.address}/?project=${project.id}&artifact=${artifactId}`,
    );
    await page
      .getByRole('button', { name: 'Investigations', exact: true })
      .click();
    const panel = page.locator('.investigation-panel');
    await panel
      .locator('summary')
      .filter({ hasText: /^Propose investigation$/ })
      .click();
    await panel
      .getByRole('textbox', { name: 'Brief', exact: true })
      .fill(
        'Measure contract fixture and direct integration latency on the pinned checkout.',
      );
    await panel
      .getByRole('textbox', { name: 'Checkout commit', exact: true })
      .fill('1'.repeat(40));
    await panel
      .getByRole('button', { name: 'Propose investigation', exact: true })
      .click();
    await expect(
      panel.getByText('Ready to run', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('dialog', { name: 'Local investigations', exact: true })
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
    await expect(page.locator('.document-investigation')).toContainText(
      'Measure contract fixture and direct integration latency',
    );
    await page.locator('.document-investigation').scrollIntoViewIfNeeded();
    await capture(page, 'investigation-request-desktop.png');
    await page
      .locator('.document-investigation')
      .getByRole('button', { name: 'Open investigation', exact: true })
      .click();
    const records = await f.call(
        page,
        `/artifacts/${artifactId}/investigations`,
        'GET',
      ),
      record = records.records[0];
    await panel
      .getByRole('button', { name: 'Run on my machine', exact: true })
      .click();
    await expect(panel.getByText('queued', { exact: true })).toBeVisible();
    const claimed = await f.call(
      page,
      `/machines/${machine.id}/investigations/claim`,
      'POST',
      undefined,
      machine.token,
    );
    expect(claimed.work.investigationId).toBe(record.id);
    expect(claimed.work.sourceCommit).toBe('1'.repeat(40));
    const result: InvestigationResult = {
      title: 'Preview boundary measurements',
      report:
        'The contract fixture was faster in this synthetic protocol dataset.',
      method:
        'Two explicitly supplied measurements from the pinned checkout fixture.',
      limitations:
        'Synthetic test measurements; not a benchmark or a live integration acceptance claim.',
      datasets: [
        {
          id: 'latency',
          title: 'Boundary observations',
          columns: [
            { id: 'boundary', label: 'Boundary', type: 'string' },
            { id: 'latency', label: 'Latency', type: 'number', unit: 'ms' },
          ],
          rows: [
            {
              id: 'contract',
              values: { boundary: 'Contract fixture', latency: 24 },
            },
            {
              id: 'direct',
              values: { boundary: 'Direct integration', latency: 170 },
            },
          ],
        },
      ],
      views: [
        {
          id: 'latency-comparison',
          title: 'Measured preview latency',
          datasetId: 'latency',
          type: 'bar',
          columns: ['boundary', 'latency'],
          x: 'boundary',
          y: 'latency',
        },
      ],
      evidence: [
        {
          name: 'Method note',
          text: 'The fixture submits an explicit typed result through the authenticated production machine completion endpoint.',
        },
      ],
      images: [],
    };
    const completed = await f.call(
      page,
      `/machines/${machine.id}/investigations/${record.id}/complete`,
      'POST',
      {
        generation: claimed.work.generation,
        leaseToken: claimed.leaseToken,
        result,
      },
      machine.token,
    );
    await expect(
      panel.getByRole('button', { name: 'Open published report', exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await panel
      .getByRole('button', { name: 'Open published report', exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`artifact=${completed.childArtifactId}`),
    );
    const inline = page
      .locator('.document-investigation')
      .getByRole('region', { name: 'Measured preview latency', exact: true });
    await expect(inline.getByRole('table')).toContainText('Contract fixture');
    await inline
      .getByRole('checkbox', { name: 'Select row contract', exact: true })
      .check();
    await inline
      .getByRole('button', { name: 'Share selections', exact: true })
      .click();
    await expect(inline).toContainText('selection r2');
    await inline
      .getByText('Record a decision against this evidence', { exact: true })
      .click();
    await inline
      .getByRole('textbox', { name: 'Conclusion', exact: true })
      .fill('Use a contract fixture for the live preview.');
    await inline
      .getByRole('textbox', { name: 'Rationale', exact: true })
      .fill(
        'The selected contract observation is24 ms; retain its exact result and selection revision.',
      );
    await inline
      .getByRole('button', {
        name: 'Record decision · selection r2',
        exact: true,
      })
      .click();
    await expect(
      inline.getByText('Use a contract fixture for the live preview.', {
        exact: true,
      }),
    ).toBeVisible();
    const published = await f.call(page, '/investigations/' + record.id, 'GET');
    expect(published.selections['latency-comparison'].selection.rowIds).toEqual(
      ['contract'],
    );
    expect(published.decisions[0].selectionRevision).toBe(2);
    expect(published.decisions[0].resultHash).toBe(published.resultHash);
    expect(published.decisions[0].authorName).toBe(f.user.name);
    await page.reload();
    await expect(
      inline.getByRole('checkbox', {
        name: 'Select row contract',
        exact: true,
      }),
    ).toBeChecked();
    await expect(
      inline.getByText('Use a contract fixture for the live preview.', {
        exact: true,
      }),
    ).toBeVisible();
    await inline.scrollIntoViewIfNeeded();
    await capture(page, 'investigation-inline-desktop.png');
    const invitation = await f.call(
      page,
      `/projects/${project.id}/members`,
      'POST',
      {
        email: 'reader@product-browser.test',
        name: 'Evidence reader',
        role: 'viewer',
      },
    );
    viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    await f.login(
      viewer,
      'reader@product-browser.test',
      invitation.temporaryPassword,
    );
    await viewer.goto(
      `${f.address}/?project=${project.id}&artifact=${completed.childArtifactId}`,
    );
    const view = viewer
      .locator('.document-investigation')
      .getByRole('region', { name: 'Measured preview latency', exact: true });
    await expect(
      view.getByRole('checkbox', { name: 'Select row contract', exact: true }),
    ).toBeChecked();
    await expect(
      view.getByRole('checkbox', { name: 'Select row contract', exact: true }),
    ).toBeDisabled();
    await expect(
      view.getByRole('button', { name: 'Share selections', exact: true }),
    ).toHaveCount(0);
    await expect(
      view.getByText('Use a contract fixture for the live preview.', {
        exact: true,
      }),
    ).toBeVisible();
    await viewer.setViewportSize({ width: 390, height: 844 });
    const hide = viewer.getByRole('button', {
      name: 'Hide artifact panel',
      exact: true,
    });
    if (await hide.isVisible()) await hide.click();
    await expect(view).toBeVisible();
    expect(
      await viewer.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await view.getByRole('table').scrollIntoViewIfNeeded();
    await capture(viewer, 'investigation-inline-mobile-viewer.png');
    await view.locator('.inv-decisions').scrollIntoViewIfNeeded();
    await capture(viewer, 'investigation-decision-mobile-viewer.png');
    expect(errors).toEqual([]);
  } finally {
    await viewerContext?.close();
    await f.close();
  }
});
