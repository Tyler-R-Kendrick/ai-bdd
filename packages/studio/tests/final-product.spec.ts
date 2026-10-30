import { ownedFreeGatewayMetadata } from './free-gateway-fixture.ts';
import {
  test,
  expect,
  type Page,
  type BrowserContext,
} from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, signInBrowser } from './browser-fixture.ts';
import type { Settings } from '../server/auth.ts';
import type { InvestigationResult } from '../shared/investigations.ts';
import { decisionProfileSchema } from '../shared/decision-profile.ts';
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
    animations: name.includes('highlight') ? 'allow' : 'disabled',
    fullPage: true,
  });
}
async function fixture(cards: boolean, model = false) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-product-browser-'));
  const modelRequests: any[] = [],
    decisionRequests: any[] = [],
    searchRequests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const input = body ? JSON.parse(body) : null;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/native/decisions') {
      decisionRequests.push(input);
      res.end(
        JSON.stringify({
          model: input.model,
          usage: { input_tokens: 14, output_tokens: 7, total_tokens: 21 },
          answers: input.questions.map((question: any) =>
            question.type === 'score'
              ? {
                  name: question.name,
                  type: 'score',
                  score: 1.8,
                  confidence: 0.9,
                  probabilities: question.levels.map(
                    (level: any, i: number) => ({
                      value: i,
                      label: level.label,
                      probability: [0.05, 0.1, 0.85][i],
                    }),
                  ),
                }
              : question.type === 'choice'
                ? {
                    name: question.name,
                    type: 'choice',
                    choice: question.choices[0].value,
                    confidence: 0.9,
                    probabilities: question.choices.map(
                      (choice: any, i: number) => ({
                        value: choice.value,
                        probability:
                          i === 0 ? 0.9 : 0.1 / (question.choices.length - 1),
                      }),
                    ),
                  }
                : {
                    name: question.name,
                    type: 'predicate',
                    probability: question.name.endsWith('.evidence')
                      ? 0.5
                      : 0.95,
                  },
          ),
        }),
      );
      return;
    }
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
            gatewayMetadataFetch: ownedFreeGatewayMetadata(),
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
      decisionSettings: {
        production: false,
        timeoutMs: 10000,
        defaultProfile: decisionProfileSchema.parse({
          provider: 'openai-decisions',
          model: 'gpt-6-luna',
          minimumConfidence: 0.7,
        }),
        openai: {
          baseUrl: `http://127.0.0.1:${(server.address() as any).port}/native`,
          apiKey: 'synthetic-native-browser-fixture-key',
          models: ['gpt-6-luna', 'fixture-review-model'],
        },
      },
    });
  } finally {
    if (priorFlag === undefined) delete process.env.STUDIO_CONVERSATION_CARDS;
    else process.env.STUDIO_CONVERSATION_CARDS = priorFlag;
  }
  const user = await instance.store.createUser(
    'owner@product-browser.test',
    'Evidence owner',
    null,
  );
  const address = await instance.app.listen({ host: '127.0.0.1', port: 0 });
  settings.origin = address;
  async function login(page: Page, email = user.email) {
    await signInBrowser(page, address, email);
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
    decisionRequests,
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
        await f.call(
          page,
          `/artifacts/${researchId}/integrations/jobs`,
          'GET',
        )
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
          return result.jobs.find((j: any) => j.intent === 'research')
            ?.status;
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
      questionnaire.getByRole('button', {
        name: 'Accepted ADR',
        exact: true,
      }),
    ).toBeVisible();
    await page.reload();
    await expect(
      questionnaire.getByRole('button', {
        name: 'Accepted ADR',
        exact: true,
      }),
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
      panel.getByRole('button', {
        name: 'Open published report',
        exact: true,
      }),
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
        'The selected contract observation is 24 ms; retain its exact result and selection revision.',
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
    const published = await f.call(
      page,
      '/investigations/' + record.id,
      'GET',
    );
    expect(
      published.selections['latency-comparison'].selection.rowIds,
    ).toEqual(['contract']);
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
    expect(invitation).not.toHaveProperty('temporaryPassword');
    viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    await f.login(
      viewer,
      'reader@product-browser.test',
    );
    await viewer.goto(
      `${f.address}/?project=${project.id}&artifact=${completed.childArtifactId}`,
    );
    const view = viewer
      .locator('.document-investigation')
      .getByRole('region', { name: 'Measured preview latency', exact: true });
    await expect(
      view.getByRole('checkbox', {
        name: 'Select row contract',
        exact: true,
      }),
    ).toBeChecked();
    await expect(
      view.getByRole('checkbox', {
        name: 'Select row contract',
        exact: true,
      }),
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

test('independent decision selection and semantic review preserve uncertainty, anchored discussion and stale provenance in the full app', async ({
  page,
}) => {
  test.setTimeout(120000);
  const f = await fixture(false, true),
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (
      response.url().startsWith(f.address + '/api/') &&
      response.status() >= 500
    )
      errors.push(`${response.status()} ${response.url()}`);
  });
  try {
    await f.login(page);
    const project = await f.call(page, '/projects', 'POST', {
        title: 'Source-linked design advice',
        description: 'Actual native HTTP protocol fixture.',
        repository: '',
      }),
      id = project.mainArtifactId,
      initial = await f.instance.store.artifact(id, f.user.id),
      passage =
        'Persist the shopping cart after explicit save and show the item count after reload.',
      unselected =
        'Private unselected implementation notes must stay out of this assessment.';
    await f.instance.store.updateArtifact(f.user, id, initial.version, {
      doc: {
        type: 'doc',
        content: [passage, unselected].map((text) => ({
          type: 'paragraph',
          content: [{ type: 'text', text }],
        })),
      },
    });
    await page.goto(`${f.address}/?project=${project.id}&artifact=${id}`);
    await page.getByRole('tab', { name: 'Connections', exact: true }).click();
    const decisions = page.getByRole('region', {
        name: 'Decision models',
        exact: true,
      }),
      agent = page.getByRole('region', {
        name: 'Agent runtime',
        exact: true,
      });
    await expect(
      agent.getByRole('combobox', { name: 'Agent harness' }),
    ).toHaveValue('t3-code');
    await decisions
      .getByRole('combobox', { name: 'Decision provider' })
      .selectOption('jev');
    await expect(
      decisions.getByRole('combobox', { name: 'Decision model' }),
    ).toHaveValue('jev-latest');
    await decisions
      .getByRole('button', { name: 'Save decision model', exact: true })
      .click();
    await expect(
      decisions.getByText('Decision model saved.', { exact: true }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole('tab', { name: 'Connections', exact: true }).click();
    await expect(
      decisions.getByRole('combobox', { name: 'Decision provider' }),
    ).toHaveValue('jev');
    await expect(
      decisions.getByText('Offline', { exact: true }),
    ).toBeVisible();
    await expect(
      agent.getByRole('combobox', { name: 'Agent harness' }),
    ).toHaveValue('t3-code');
    await decisions
      .getByRole('combobox', { name: 'Decision provider' })
      .selectOption('openai-decisions');
    await decisions
      .getByRole('combobox', { name: 'Decision model' })
      .selectOption('fixture-review-model');
    await decisions
      .getByRole('spinbutton', { name: 'Minimum decision confidence' })
      .fill('0.8');
    await decisions
      .getByRole('button', { name: 'Save decision model', exact: true })
      .click();
    await expect(
      decisions.getByText('Decision model saved.', { exact: true }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole('tab', { name: 'Connections', exact: true }).click();
    await expect(
      decisions.getByRole('combobox', { name: 'Decision model' }),
    ).toHaveValue('fixture-review-model');
    await expect(
      decisions.getByRole('spinbutton', {
        name: 'Minimum decision confidence',
      }),
    ).toHaveValue('0.8');
    const chatProfile = await f.call(
        page,
        `/artifacts/${id}/agent/profile`,
        'GET',
      ),
      decisionProfile = await f.call(
        page,
        `/artifacts/${id}/decision/profile`,
        'GET',
      );
    expect(chatProfile.profile).toMatchObject({
      harness: 't3-code',
      provider: 'project-default',
      model: 'project-default',
    });
    expect(decisionProfile.profile).toMatchObject({
      provider: 'openai-decisions',
      model: 'fixture-review-model',
      minimumConfidence: 0.8,
    });
    await decisions.scrollIntoViewIfNeeded();
    await capture(page, 'decision-profile-independent-desktop.png');
    await page
      .getByRole('button', { name: 'Review design', exact: true })
      .click();
    const modal = page.getByRole('dialog', {
      name: 'Design review',
      exact: true,
    });
    await expect(
      modal.getByRole('checkbox', { name: passage, exact: true }),
    ).toBeChecked();
    await modal
      .getByRole('checkbox', { name: unselected, exact: true })
      .uncheck();
    await modal
      .getByRole('button', { name: 'Assess selected passages', exact: true })
      .click();
    const assessment = modal.getByRole('region', {
      name: 'Design assessment',
    });
    await expect(
      assessment.getByText('Assessment complete', { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect(
      assessment.getByText('Uncertain — abstained', { exact: true }),
    ).toBeVisible();
    await expect(
      assessment.getByText('1.80 / 2', { exact: true }),
    ).toBeVisible();
    await expect(
      assessment.getByText('Native probability of “yes”: 50.0%.', {
        exact: false,
      }),
    ).toBeVisible();
    await assessment
      .getByText('Assessment provenance', { exact: true })
      .click();
    await expect(
      assessment.getByText('openai-decisions / fixture-review-model', {
        exact: true,
      }),
    ).toBeVisible();
    expect(f.modelRequests).toHaveLength(0);
    expect(f.decisionRequests).toHaveLength(1);
    expect(JSON.stringify(f.decisionRequests[0])).toContain(passage);
    expect(JSON.stringify(f.decisionRequests[0])).not.toContain(unselected);
    const history = await f.call(
      page,
      `/artifacts/${id}/decision-review`,
      'GET',
    );
    expect(history.jobs[0].result.coverage).toMatchObject({
      selected: 1,
      available: 2,
    });
    expect(history.jobs[0].result.evaluation.provenance).toMatchObject({
      provider: 'openai-decisions',
      model: 'fixture-review-model',
      minimumConfidence: 0.8,
    });
    await assessment.scrollIntoViewIfNeeded();
    await capture(page, 'design-review-native-desktop.png');
    await assessment
      .getByRole('button', { name: 'Discuss this passage', exact: true })
      .first()
      .click();
    await page
      .getByRole('textbox', { name: 'Comment text', exact: true })
      .fill(
        'Confirm the saved cart count with a reload test before implementation.',
      );
    await page
      .getByRole('button', { name: 'Post comment', exact: true })
      .click();
    await expect(
      page.getByText(
        'Confirm the saved cart count with a reload test before implementation.',
        { exact: true },
      ),
    ).toBeVisible();
    await page.reload();
    const bundle = await f.call(page, `/artifacts/${id}`, 'GET'),
      anchored = bundle.threads.find(
        (thread: any) => thread.quote === passage,
      );
    expect(anchored?.anchor).toBeTruthy();
    const thread = await f.call(
      page,
      `/artifacts/${id}/messages?threadId=${anchored.id}`,
      'GET',
    );
    expect(
      thread.messages.some(
        (message: any) =>
          message.body ===
          'Confirm the saved cart count with a reload test before implementation.',
      ),
    ).toBe(true);
    await page
      .getByRole('button', { name: 'Review design', exact: true })
      .click();
    await expect(
      assessment.getByText('Assessment complete', { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await assessment.scrollIntoViewIfNeeded();
    await capture(page, 'design-review-native-mobile.png');
    await page.keyboard.press('Escape');
    const editor = page.getByLabel('Document editor', { exact: true });
    await editor.click();
    await editor.press('Control+End');
    await editor.press('Enter');
    await editor.pressSequentially('Add a required manual reload check.');
    await expect
      .poll(async () =>
        JSON.stringify(
          (await f.call(page, `/artifacts/${id}`, 'GET')).artifact.content,
        ),
      )
      .toContain('Add a required manual reload check.');
    await page
      .getByRole('button', { name: 'Review design', exact: true })
      .click();
    await expect(
      assessment.getByText('Source changed', { exact: true }),
    ).toBeVisible();
    await expect(
      assessment
        .getByRole('button', { name: 'Discuss this passage' })
        .first(),
    ).toBeDisabled();
    await assessment.scrollIntoViewIfNeeded();
    await capture(page, 'design-review-stale-mobile.png');
    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test('passage slash commands place exact research and investigation cards inline and keep run controls owner scoped', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const f = await fixture(false, true),
    errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let viewerContext: BrowserContext | undefined;
  try {
    await f.login(page);
    const project = await f.call(page, '/projects', 'POST', {
        title: 'Passage-native planning',
        repository: '',
      }),
      id = project.mainArtifactId;
    const original = await f.instance.store.artifact(id, f.user.id);
    await f.instance.store.updateArtifact(f.user, id, original.version, {
      doc: {
        type: 'doc',
        content: [
          'Selected requirement',
          'Following requirement',
          'Closing requirement',
        ].map((text) => ({
          type: 'paragraph',
          content: [{ type: 'text', text }],
        })),
      },
    });
    await page.goto(`${f.address}/?project=${project.id}&artifact=${id}`);
    await f.selectFx(page);
    const editor = page.locator('[aria-label="Document editor"]');
    const caretState = () => editor.evaluate((element) => {
      // Read the real mounted editor, provider and native caret. A detached
      // range measures native text offset; it is never applied to selection.
      const mounted = (element as HTMLElement & {
        editor?: import('@tiptap/core').Editor;
      }).editor;
      if (!mounted || mounted.isDestroyed) return null;
      const selection = mounted.state.selection;
      const native = element.ownerDocument.getSelection();
      const anchor = native?.anchorNode;
      const paragraph = (
        anchor?.nodeType === Node.TEXT_NODE
          ? anchor.parentElement
          : anchor as Element | null
      )?.closest?.('p');
      let nativeOffset: number | null = null;
      if (paragraph && native && anchor && paragraph.contains(anchor)) {
        const prefix = element.ownerDocument.createRange();
        prefix.selectNodeContents(paragraph);
        prefix.setEnd(anchor, native.anchorOffset);
        nativeOffset = prefix.toString().length;
      }
      const provider = mounted.extensionManager.extensions.find(
        (extension) => extension.name === 'collaborationCaret',
      )?.options.provider;
      return {
        initialized: mounted.isInitialized,
        synced: provider?.synced === true,
        focused: mounted.view.hasFocus(),
        editorFocused: mounted.isFocused,
        editable: mounted.isEditable,
        empty: selection.empty,
        text: selection.$from.parent.textContent,
        offset: selection.$from.parentOffset,
        native: {
          anchorText: anchor?.textContent,
          anchorOffset: native?.anchorOffset,
          focusText: native?.focusNode?.textContent,
          focusOffset: native?.focusOffset,
          paragraph: paragraph?.textContent,
          textOffset: nativeOffset,
          collapsed: native?.isCollapsed,
        },
        agrees: native?.isCollapsed === selection.empty &&
          paragraph?.textContent === selection.$from.parent.textContent &&
          nativeOffset === selection.$from.parentOffset,
      };
    });
    const focusBlockStart = async (text: string) => {
      const diagnostic: Record<string, unknown> = {initial: await caretState()};
      try {
        await expect.poll(caretState).toMatchObject({
          initialized: true, synced: true, editable: true,
        });
        await editor.getByText(text, { exact: true }).click();
        await expect.poll(caretState).toMatchObject({
          initialized: true, synced: true, focused: true, editorFocused: true,
          editable: true, empty: true, text, agrees: true,
        });
        diagnostic.beforeHome = await caretState();
        await editor.press('Home');
        diagnostic.afterHome = await caretState();
        await expect.poll(caretState).toMatchObject({
          initialized: true, synced: true, focused: true, editorFocused: true,
          editable: true, empty: true, text, offset: 0, agrees: true,
        });
      } finally {
        diagnostic.settled = await caretState();
        await test.info().attach('slash-caret-' + text, {
          body: JSON.stringify(diagnostic), contentType: 'application/json',
        });
      }
    };
    // Cancelling a slash command preserves literal path text rather than swallowing it.
    await focusBlockStart('Closing requirement');
    await page.keyboard.type('/');
    await page.getByRole('textbox', { name: 'Document command', exact: true }).fill('usr/local');
    await page.keyboard.press('Escape');
    await expect(editor).toContainText('/usr/localClosing requirement');
    await expect.poll(async () => JSON.stringify((await f.instance.store.artifact(id, f.user.id)).content)).toContain('/usr/localClosing requirement');
    await page.reload();
    await focusBlockStart('Selected requirement');
    await page.keyboard.type('/');
    const menu = page.getByRole('dialog', {
      name: 'Document commands',
      exact: true,
    });
    await expect(menu).toBeVisible();
    await menu
      .getByRole('textbox', { name: 'Document command', exact: true })
      .fill('research');
    await menu
      .getByRole('menuitem', { name: 'Research · /research', exact: true })
      .click();
    const research = page.getByRole('dialog', {
      name: 'Research this passage',
      exact: true,
    });
    await research
      .getByRole('textbox', { name: 'Research brief', exact: true })
      .fill(
        'Compare the declared Pact boundary for this exact selected requirement.',
      );
    await capture(page, 'passage-research-brief-desktop.png');
    await research
      .getByRole('button', { name: 'Start research', exact: true })
      .click();
    await expect(research).not.toBeVisible();
    await expect(editor.locator('.document-research')).toContainText(
      'Compare the declared Pact boundary',
    );
    await expect(
      editor
        .locator('.document-research')
        .getByRole('link', {
          name: 'Open published research document',
          exact: true,
        }),
    ).toBeVisible({ timeout: 30000 });
    await expect.poll(() => f.searchRequests.length).toBe(1);
    expect(
      f.searchRequests[0].query ??
        f.searchRequests[0].brief ??
        JSON.stringify(f.searchRequests[0]),
    ).toContain('Compare the declared Pact boundary');
    await expect(editor.locator('[data-agent-change="true"]')).not.toHaveCount(0);
    await capture(page, 'passage-research-highlight-desktop.png');
    const afterResearch = await f.instance.store.artifact(id, f.user.id);
    expect(
      afterResearch.content.doc.content.map((node: any) => node.type),
    ).toEqual(['paragraph', 'researchBlock', 'paragraph', 'paragraph']);
    // Research uses its explicit local source gateway; only the subsequent investigation
    // is bound to the registered synthetic repository/workstation protocol.
    await f.call(page, `/projects/${project.id}`, 'PATCH', {
      title: 'Passage-native planning',
      description: 'Synthetic local protocol acceptance',
      repository: 'https://github.com/example/passage-planning',
    });
    const pairing = await f.call(
      page,
      `/projects/${project.id}/machines/pairing`,
      'POST',
      { label: 'Passage investigation workstation' },
    );
    const machine = await f.call(page, '/machines/pair', 'POST', {
      code: pairing.code,
    });
    await f.call(
      page,
      `/machines/${machine.id}/investigations/checkout`,
      'POST',
      {
        repository: 'https://github.com/example/passage-planning',
        sourceCommit: '2'.repeat(40),
        branch: 'main',
      },
      machine.token,
    );
    await focusBlockStart('Following requirement');
    await page.keyboard.type('/');
    await expect(menu).toBeVisible();
    await menu
      .getByRole('menuitem', {
        name: 'Investigate · /investigate',
        exact: true,
      })
      .click();
    const panel = page.locator('.investigation-panel');
    await expect(
      panel.getByText(/Insert after selected passage/),
    ).toBeVisible();
    await panel
      .getByRole('textbox', { name: 'Brief', exact: true })
      .fill(
        'Measure the selected following requirement on the pinned checkout.',
      );
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
    const card = editor.locator('.document-investigation');
    await expect(
      card.getByRole('button', { name: 'Run on my machine', exact: true }),
    ).toBeVisible();
    const placed = await f.instance.store.artifact(id, f.user.id);
    expect(placed.content.doc.content.map((node: any) => node.type)).toEqual([
      'paragraph',
      'researchBlock',
      'paragraph',
      'investigationCard',
      'paragraph',
    ]);
    await card.scrollIntoViewIfNeeded();
    await capture(page, 'passage-investigation-ready-desktop.png');
    await card
      .getByRole('button', { name: 'Run on my machine', exact: true })
      .click();
    await expect(card).toContainText('queued');
    await expect(
      card.getByRole('button', { name: 'Stop investigation', exact: true }),
    ).toBeVisible();
    await capture(page, 'passage-investigation-queued-desktop.png');
    const viewer = await f.instance.store.createUser(
      'passage-viewer@test.invalid',
      'Passage viewer',
      null,
    );
    await f.instance.store.exec(
      'INSERT INTO memberships VALUES(?,?,?)',
      project.id,
      viewer.id,
      'viewer',
    );
    viewerContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const mobile = await viewerContext.newPage();
    await signInBrowser(mobile, f.address, viewer.email);
    await mobile.goto(`${f.address}/?project=${project.id}&artifact=${id}`);
    const mobileCard = mobile.locator('.document-investigation');
    await mobileCard.scrollIntoViewIfNeeded();
    await expect(mobileCard).toContainText('queued');
    await expect(
      mobileCard.getByRole('button', {
        name: 'Stop investigation',
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      mobile.getByRole('button', {
        name: 'Investigate this passage',
        exact: true,
      }),
    ).toBeDisabled();
    await capture(mobile, 'passage-investigation-viewer-mobile.png');
    expect(errors).toEqual([]);
  } finally {
    await viewerContext?.close();
    await f.close();
  }
});
