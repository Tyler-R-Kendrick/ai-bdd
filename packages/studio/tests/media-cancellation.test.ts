import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const helper = new URL('../verification/observe-completion.mjs', import.meta.url).href;
describe('media subprocess cancellation observation', () => {
  it('retains a rejected attach outcome across delayed kill handling without an unhandled rejection', async () => {
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {setTimeout as delay} from 'node:timers/promises';
      import {observeCompletion} from ${JSON.stringify(helper)};
      const error=Object.assign(new Error('synthetic docker attach killed'),{code:137});
      let unhandled=0;
      process.on('unhandledRejection',()=>unhandled++);
      const completion=observeCompletion(Promise.reject(error));
      await delay(25);
      const result=await completion;
      assert.equal(unhandled,0);
      assert.equal(result.ok,false);
      assert.equal(result.error,error);
      assert.equal(result.error.code,137);
      console.log('observed expected cancellation');
    `]);
    expect(stdout.trim()).toBe('observed expected cancellation');
  });
  it('keeps early successful completion distinct from cancellation', async () => {
    const modulePath = fileURLToPath(new URL('../verification/observe-completion.mjs', import.meta.url));
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {pathToFileURL} from 'node:url';
      import {setTimeout as delay} from 'node:timers/promises';
      const {observeCompletion}=await import(pathToFileURL(${JSON.stringify(modulePath)}));
      const completion=observeCompletion(Promise.resolve({code:0}));
      await delay(10);
      const result=await completion;
      assert.equal(result.ok,true);
      assert.equal(result.value.code,0);
      console.log('retained early success');
    `]);
    expect(stdout.trim()).toBe('retained early success');
  });
});
