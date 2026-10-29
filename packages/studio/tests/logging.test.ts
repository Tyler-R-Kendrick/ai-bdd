import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
describe('Production request logging', () => {
  it('keeps request diagnostics without logging authorization query values or cookies', async () => {
    const marker = 'test-only-authorization-value-123456',
      cookie = 'test-only-cookie-value-abcdef';
    const script = `import {createApp} from './server/app.ts';const {app}=await createApp({production:false,origin:'http://127.0.0.1:8787',dataDir:'/tmp/studio-log-test',demo:false},{db:':memory:',logger:true});await app.inject({method:'GET',url:'/api/auth/status?code=${marker}',headers:{cookie:'studio_session=${cookie}',authorization:'Bearer ${marker}'}});await app.close();`;
    const { stdout } = await run(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        timeout: 20000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      },
    );
    expect(stdout).toContain('request completed');
    expect(stdout).not.toContain(marker);
    expect(stdout).not.toContain(cookie);
    expect(stdout).toContain('[Redacted]');
  });
});
