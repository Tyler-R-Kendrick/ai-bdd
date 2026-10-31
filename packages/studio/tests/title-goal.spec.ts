import { ownedFreeGatewayMetadata } from './free-gateway-fixture.ts';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as Y from 'yjs';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { createApp, signInBrowser } from './browser-fixture.ts';
import type { Settings } from '../server/auth.ts';
const title = 'Contract preview intent';
const goal =
  'Keep the preview usable with a consumer contract fixture while the integration is unavailable.';
const captureDirectory = process.env.STUDIO_CAPTURE_DIR;
async function capture(page: Page, name: string) {
  if (!captureDirectory) return;
  await mkdir(captureDirectory, { recursive: true });
  await page.screenshot({
    path: resolve(captureDirectory, name),
    fullPage: true,
    animations: 'allow',
  });
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'studio-title-goal-browser-'));
  const requests: any[] = [];
  let hold = false,
    release: () => void = () => {},
    gate = Promise.resolve();
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const input = JSON.parse(body);
    requests.push({ body: input, headers: req.headers });
    if (hold) await gate;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify({ title, goal }) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 20, text: 20, reasoning: 0 },
        },
        warnings: [],
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const previousKey = process.env.AI_GATEWAY_API_KEY,
    previousCards = process.env.STUDIO_CONVERSATION_CARDS;
  process.env.AI_GATEWAY_API_KEY = 'synthetic-title-goal-browser-key';
  process.env.STUDIO_CONVERSATION_CARDS = '0';
  const settings: Settings = {
    production: false,
    origin: 'http://127.0.0.1:8889',
    dataDir: directory,
    demo: false,
    model: 'fixture/title-goal',
    integrations: {
      gatewayBaseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
      gatewayMetadataFetch: ownedFreeGatewayMetadata(),
    },
  };
  const instance = await createApp(settings, {
    db: ':memory:',
    clientDir: resolve(import.meta.dirname, '../dist/client'),
  });
  const address = await instance.app.listen({ host: '127.0.0.1', port: 0 });
  settings.origin = address;
  const errors: string[] = [];
  function observe(page: Page) {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (
        response.url().startsWith(address + '/api/') &&
        response.status() >= 500
      )
        errors.push(`${response.status()} ${response.url()}`);
    });
  }
  async function login(page: Page, email = 'owner@goal-browser.invalid') {
    observe(page);
    const user=await signInBrowser(page,address,email);
    expect((await page.request.get(address + '/api/projects')).status()).toBe(
      200,
    );
    return user;
  }
  async function api(page: Page, path: string, method = 'GET', data?: unknown) {
    const response = await page.request.fetch(address + '/api' + path, {
      method,
      headers: { origin: address },
      ...(data === undefined ? {} : { data }),
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  async function document(page: Page, body = '', main = false) {
    const project = await api(page, '/projects', 'POST', {
      title: 'Contract preview planning',
      description: 'Synthetic local gateway acceptance',
      repository: '',
    });
    let artifact = await api(
      page,
      `/projects/${project.id}/artifacts`,
      'POST',
      {
        kind: 'document',
        title: 'Untitled planning note',
        content: {
          doc: {
            type: 'doc',
            content: [
              {
                type: 'heading',
                attrs: { id: 'goal-heading', level: 1 },
                content: [{ type: 'text', text: 'Untitled planning note' }],
              },
              {
                type: 'paragraph',
                attrs: { id: 'goal-body' },
                ...(body ? { content: [{ type: 'text', text: body }] } : {}),
              },
            ],
          },
        },
      },
    );
    if (main) {
      const current = (await api(page, `/artifacts/${project.mainArtifactId}`))
        .artifact;
      const content = structuredClone(artifact.content);
      content.doc.content[0].content[0].text = current.title;
      artifact = await api(page, `/artifacts/${current.id}`, 'PATCH', {
        version: current.version,
        content,
      });
      expect(artifact.id).toBe(project.mainArtifactId);
      expect(artifact.kind).toBe('design');
    }
    await page.goto(
      `${address}/?project=${project.id}&artifact=${artifact.id}`,
    );
    await expect(
      page.locator('.document-page [data-id="goal-heading"]'),
    ).toBeVisible();
    return { project, artifact };
  }
  async function fx(page: Page) {
    await page.getByRole('tab', { name: 'Connections', exact: true }).click();
    const region = page.getByRole('region', {
      name: 'Agent runtime',
      exact: true,
    });
    await expect(
      region.getByRole('combobox', { name: 'Agent harness', exact: true }),
    ).toHaveValue('t3-code');
    await expect(region.getByText('Offline', { exact: true })).toBeVisible();
    await region
      .getByRole('combobox', { name: 'Agent harness', exact: true })
      .selectOption('vercel-fx');
    await region
      .getByRole('button', { name: 'Save agent runtime', exact: true })
      .click();
    await expect(
      region.getByText('Agent runtime saved.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  }
  async function automatic(page: Page, seed: boolean, captureConsent = false) {
    await page.getByTitle('Rename artifact', { exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Artifact title',
      exact: true,
    });
    await expect(
      dialog.getByRole('checkbox', {
        name: 'Maintain the title from this discussion',
      }),
    ).not.toBeChecked();
    const option = dialog.getByRole('checkbox', {
      name: /Add a goal from this discussion/,
    });
    await expect(option).not.toBeChecked();
    await expect(option).toBeDisabled();
    await dialog
      .getByRole('checkbox', {
        name: 'Maintain the title from this discussion',
      })
      .check();
    await expect(option).toBeEnabled();
    if (seed) await option.check();
    if (captureConsent)
      await capture(page, 'title-goal-explicit-consent-desktop.png');
    await dialog
      .getByRole('button', { name: 'Save title', exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
  }
  async function message(page: Page) {
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Message this artifact', exact: true })
      .fill(
        'Describe a contract fixture preview that stays useful while its integration is unavailable.',
      );
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
  }
  async function completed(id: string) {
    await expect
      .poll(async () => {
        const row = await instance.store.one(
          "SELECT status FROM studio_durable_jobs WHERE artifact_id=? AND kind='artifact.title' ORDER BY created_at DESC LIMIT 1",
          id,
        );
        return row?.status;
      })
      .toBe('completed');
  }
  return {
    instance,
    address,
    requests,
    errors,
    login,
    api,
    document,
    fx,
    automatic,
    message,
    completed,
    hold: () => {
      hold = true;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      hold = false;
      release();
    },
    close: async () => {
      release();
      await instance.app.close();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await rm(directory, { recursive: true, force: true });
      if (previousKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = previousKey;
      if (previousCards === undefined)
        delete process.env.STUDIO_CONVERSATION_CARDS;
      else process.env.STUDIO_CONVERSATION_CARDS = previousCards;
    },
  };
}
test('explicit title and goal consent seeds the empty main design document once with canonical Yjs and attributed live markers', async ({
  page,
  browser,
}) => {
  const f = await fixture();
  let viewerContext: BrowserContext | undefined;
  try {
    await f.login(page);
    const { project, artifact } = await f.document(page, '', true);
    await f.fx(page);
    await f.automatic(page, true, true);
    const before = (await f.api(page, `/artifacts/${artifact.id}`)).artifact;
    await f.message(page);
    await expect(page.locator('.artifact-title')).toHaveText(title);
    await expect(
      page.locator('.document-page [data-id="goal-body"]'),
    ).toHaveText(goal);
    await f.completed(artifact.id);
    const bundle = await f.api(page, `/artifacts/${artifact.id}`),
      after = bundle.artifact;
    expect(after.version).toBe(before.version + 1);
    expect(after.content.doc.content.map((node: any) => node.attrs.id)).toEqual(
      ['goal-heading', 'goal-body'],
    );
    expect(after.content.doc.content[0].content[0].text).toBe(title);
    expect(
      bundle.decisions.every((decision: any) => decision.status === 'proposed'),
    ).toBe(true);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, (await f.instance.store.state(artifact.id))!);
    expect(
      yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default')),
    ).toEqual(after.content.doc);
    doc.destroy();
    const changes = await f.api(
      page,
      `/artifacts/${artifact.id}/document/agent-changes`,
    );
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          anchor: 'goal-body',
          actor: 'Studio agent',
          source: 'Agent goal seed',
          version: after.version,
        }),
      ]),
    );
    await expect(
      page.locator('.document-page [data-id="goal-body"]'),
    ).toHaveAttribute('data-agent-change', 'true');
    await capture(page, 'title-goal-seeded-desktop.png');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].headers['ai-language-model-id']).toBe(
      'fixture/title-goal',
    );
    expect(JSON.stringify(f.requests[0].body)).toContain(
      'stays useful while its integration is unavailable',
    );
    expect(f.requests[0].body.headers['idempotency-key']).toBeTruthy();
    const input = JSON.parse(
      f.requests[0].body.prompt.find((message: any) => message.role === 'user')
        .content[0].text,
    );
    expect(input.artifact).toEqual({
      id: artifact.id,
      title: before.title,
      kind: 'design',
    });
    const job = await f.instance.store.one(
      "SELECT id,input_json FROM studio_durable_jobs WHERE artifact_id=? AND kind='artifact.title'",
      artifact.id,
    );
    expect(JSON.parse(job.input_json).profile).toEqual({
      harness: 'vercel-fx',
      provider: 'ai-gateway',
      model: 'fixture/title-goal',
    });
    await f.instance.runtime.executeJob(job.id, {
      messageId: crypto.randomUUID(),
      deliveryCount: 2,
    });
    expect(f.requests).toHaveLength(1);
    expect(
      (await f.api(page, `/artifacts/${artifact.id}`)).artifact.version,
    ).toBe(after.version);
    await page.reload();
    await expect(
      page.locator('.document-page [data-id="goal-body"]'),
    ).toHaveText(goal);
    await expect(page.locator('.artifact-title')).toHaveText(title);
    viewerContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const mobile = await viewerContext.newPage();
    const viewer=await f.login(mobile,'viewer@goal-browser.invalid');
    await f.api(page,`/projects/${project.id}/members`,'POST',{userId:viewer.id,role:'viewer'});
    await mobile.goto(
      `${f.address}/?project=${project.id}&artifact=${artifact.id}`,
    );
    await expect(
      mobile.locator('.document-page [data-id="goal-body"]'),
    ).toHaveText(goal);
    await expect(mobile.locator('.artifact-title')).toBeDisabled();
    await expect(
      mobile.getByLabel('Document editor', { exact: true }),
    ).toHaveAttribute('contenteditable', 'false');
    expect(
      await mobile.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await capture(mobile, 'title-goal-viewer-mobile.png');
    expect(f.errors).toEqual([]);
  } finally {
    await viewerContext?.close();
    await f.close();
  }
});
test('automatic titles preserve source without goal consent and preserve an already authored body despite goal opt-in', async ({
  page,
}) => {
  const f = await fixture();
  try {
    await f.login(page);
    for (const [body, seed] of [
      ['', false],
      ['The owner has already written this integration constraint.', true],
    ] as const) {
      const { artifact } = await f.document(page, body);
      await f.fx(page);
      await f.automatic(page, seed);
      const before = (await f.api(page, `/artifacts/${artifact.id}`)).artifact;
      await f.message(page);
      await f.completed(artifact.id);
      await expect(page.locator('.artifact-title')).toHaveText(title);
      const after = (await f.api(page, `/artifacts/${artifact.id}`)).artifact;
      expect(after.version).toBe(before.version);
      expect(after.content).toEqual(before.content);
      await expect(
        page.locator('.document-page [data-id="goal-body"]'),
      ).toHaveText(body);
      expect(await page.locator('.document-page').textContent()).not.toContain(
        goal,
      );
    }
    expect(f.requests).toHaveLength(2);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
test('manual document edits and a claimed human title win over an in-flight structured goal request', async ({
  page,
}) => {
  const f = await fixture();
  try {
    await f.login(page);
    const { artifact } = await f.document(page);
    await f.fx(page);
    await f.automatic(page, true);
    f.hold();
    await f.message(page);
    await expect.poll(() => f.requests.length).toBe(1);
    await page.locator('.document-page [data-id="goal-body"]').click();
    await page.keyboard.insertText('Keep this manual integration constraint.');
    await expect
      .poll(async () => {
        const value = (await f.api(page, `/artifacts/${artifact.id}`)).artifact;
        return JSON.stringify(value.content.doc);
      })
      .toContain('Keep this manual integration constraint.');
    await page.getByTitle('Rename artifact', { exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Artifact title',
      exact: true,
    });
    await dialog
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('My manually chosen intent');
    await dialog
      .getByRole('button', { name: 'Save title', exact: true })
      .click();
    const preserved = (await f.api(page, `/artifacts/${artifact.id}`)).artifact;
    f.release();
    await f.completed(artifact.id);
    await expect(page.locator('.artifact-title')).toHaveText(
      'My manually chosen intent',
    );
    await expect(
      page.locator('.document-page [data-id="goal-body"]'),
    ).toHaveText('Keep this manual integration constraint.');
    const after = (await f.api(page, `/artifacts/${artifact.id}`)).artifact;
    expect(after.version).toBe(preserved.version);
    expect(after.content).toEqual(preserved.content);
    expect(JSON.stringify(after.content)).not.toContain(goal);
    await page.reload();
    await expect(page.locator('.artifact-title')).toHaveText(
      'My manually chosen intent',
    );
    await expect(
      page.locator('.document-page [data-id="goal-body"]'),
    ).toHaveText('Keep this manual integration constraint.');
    await capture(page, 'title-goal-manual-source-preserved-desktop.png');
    expect(f.errors).toEqual([]);
  } finally {
    f.release();
    await f.close();
  }
});
