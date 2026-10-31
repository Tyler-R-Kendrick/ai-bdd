import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp, signInBrowser } from './browser-fixture.ts';
import { testSettings } from './helpers.ts';
test('pages artifact-thread history without losing loaded messages or the reading position', async ({
  page,
}) => {
  const settings = testSettings('/tmp/studio-history-browser');
  const instance = await createApp(settings, {
    db: ':memory:',
    clientDir: resolve(import.meta.dirname, '../dist/client'),
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const address=await instance.app.listen({host:'127.0.0.1',port:0});
    settings.origin=address;
    const user=await signInBrowser(page,address,'history@example.test');
    const project = await instance.store.createProject(
        user,
        'Conversation history',
        'A thread with more messages than the initial page.',
      ),
      artifactId = project.mainArtifactId;
    const main = (await instance.store.threads(artifactId))[0];
    await instance.store.tx(async () => {
      for (let index = 0; index < 305; index++)
        await instance.store.message(
          user,
          artifactId,
          main.id,
          `Thread message ${index}`,
        );
    });
    const commentId = randomUUID();
    await instance.store.exec(
      'INSERT INTO threads(id,artifact_id,anchor,quote,created_at) VALUES(?,?,?,?,?)',
      commentId,
      artifactId,
      'paragraph-history',
      'A separate paragraph discussion',
      new Date().toISOString(),
    );
    await instance.store.message(
      user,
      artifactId,
      commentId,
      'This belongs only to the paragraph thread.',
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${address}/?project=${project.id}&artifact=${artifactId}`);
    await expect(
      page.getByText('Thread message 304', { exact: true }),
    ).toBeVisible();
    await expect(page.locator('.chat-message')).toHaveCount(100);
    await expect(
      page.getByText('Thread message 204', { exact: true }),
    ).toHaveCount(0);
    const conversation = page.getByLabel('Discussion messages', {
      exact: true,
    });
    await conversation.evaluate((element) => {
      element.scrollTop = 0;
    });
    const firstVisible = page.getByText('Thread message 205', { exact: true });
    const before = (await firstVisible.boundingBox())!.y;
    await page
      .getByRole('button', { name: 'Load earlier messages', exact: true })
      .click();
    await expect(page.locator('.chat-message')).toHaveCount(200);
    await expect(
      page.getByText('Thread message 105', { exact: true }),
    ).toHaveCount(1);
    await expect
      .poll(async () =>
        Math.abs((await firstVisible.boundingBox())!.y - before),
      )
      .toBeLessThan(4);
    await page
      .getByText('Thread message 150', { exact: true })
      .scrollIntoViewIfNeeded();
    const readingTop = await conversation.evaluate(
      (element) => element.scrollTop,
    );
    await instance.store.message(
      user,
      artifactId,
      main.id,
      'Thread message 305',
    );
    await instance.collab.notify(project.id, artifactId);
    await expect(
      page.getByText('Thread message 305', { exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByText('Thread message 105', { exact: true }),
    ).toHaveCount(1);
    await expect
      .poll(async () =>
        Math.abs(
          (await conversation.evaluate((element) => element.scrollTop)) -
            readingTop,
        ),
      )
      .toBeLessThan(4);
    await page
      .getByRole('button')
      .filter({ hasText: 'A separate paragraph discussion' })
      .click();
    await expect(
      page.getByText('This belongs only to the paragraph thread.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText('Thread message 105', { exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'All chat', exact: true }).click();
    await expect(
      page.getByText('Thread message 305', { exact: true }),
    ).toBeVisible();
    await expect(page.locator('.chat-message')).toHaveCount(100);
    await expect(
      page.getByText('Thread message 105', { exact: true }),
    ).toHaveCount(0);
    await conversation.evaluate((element) => {
      element.scrollTop = 0;
    });
    const review = resolve(import.meta.dirname, '../../../work/review');
    await mkdir(review, { recursive: true });
    await page.screenshot({
      path: resolve(review, 'studio-chat-history.png'),
      fullPage: true,
      animations: 'disabled',
    });
    expect(errors, 'Uncaught browser errors').toEqual([]);
  } finally {
    await page.goto('about:blank');
    await instance.app.close();
  }
});
