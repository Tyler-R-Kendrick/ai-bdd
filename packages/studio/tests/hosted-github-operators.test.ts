import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
describe('explicit hosted operators reject legacy authentication before usage', () => {
  it.each([
    ['hosted-local-ai-live.mjs', 'STUDIO_HOSTED_LOCAL_AI'],
    ['hosted-local-ai-ui-live.mjs', 'STUDIO_HOSTED_LOCAL_AI'],
    ['hosted-audio-live.mjs', 'STUDIO_HOSTED_AUDIO'],
    ['hosted-audio-ui-live.mjs', 'STUDIO_HOSTED_AUDIO'],
    ['hosted-audio-import-live.mjs', 'STUDIO_HOSTED_AUDIO'],
    ['hosted-video-live.mjs', 'STUDIO_HOSTED_VIDEO'],
  ])('%s refuses a password reference without opening it or entering acceptance', async (name, family) => {
    const result = await execute(process.execPath, [
      fileURLToPath(new URL('../verification/' + name, import.meta.url)),
    ], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        [family + '_PASSWORD_FILE']: '/unread-legacy-fixture-reference-must-not-leak',
      },
      timeout: 15000,
      maxBuffer: 128 * 1024,
    }).then(() => { throw new Error('Hosted operator accepted a password configuration'); }, error => error);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Password authentication is disabled; use GitHub session exports');
    expect(result.stderr).not.toContain('/unread-legacy-fixture-reference-must-not-leak');
    expect(result.stderr).not.toContain('ENOENT');
  });
});
