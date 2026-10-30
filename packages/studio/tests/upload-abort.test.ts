import { afterEach, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { createApp } from '../server/app.ts';
import { setup, testSettings, origin } from './helpers.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('passes actual multipart client disconnects to the media probe and publishes no file', async () => {
  let entered!: () => void,
    aborted = false;
  const probing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const studio = await createApp(testSettings('/tmp/studio-upload-abort'), {
    db: ':memory:',
    audioSourceProbe: async (_bytes, options) => {
      const signal = options?.signal;
      if (!signal)
        throw new Error('The upload probe needs a caller abort signal');
      entered();
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  });
  cleanup.push(() => studio.app.close());
  const { user, cookie } = await setup(studio.app),
    project = await studio.store.createProject(user, 'Owned audio upload', '');
  await studio.app.listen({ host: '127.0.0.1', port: 0 });
  const bytes = Buffer.alloc(100);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(92, 4);
  bytes.write('WAVE', 8);
  const boundary = 'studio-synthetic-upload-abort',
    payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
  const pending = request(
    studio.app.listeningOrigin +
      `/api/artifacts/${project.mainArtifactId}/files`,
    {
      method: 'POST',
      headers: {
        origin,
        cookie: 'studio_session=' + cookie,
        'content-type': 'multipart/form-data; boundary=' + boundary,
        'content-length': String(payload.length),
      },
    },
  );
  pending.on('error', () => {});
  pending.end(payload);
  await probing;
  pending.destroy();
  await vi.waitFor(() => expect(aborted).toBe(true));
  expect(
    await studio.store.all(
      'SELECT id FROM files WHERE artifact_id=?',
      project.mainArtifactId,
    ),
  ).toHaveLength(0);
});
