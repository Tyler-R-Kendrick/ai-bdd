import { describe, expect, it } from 'vitest';
import { makeReport, runCli } from './helpers.ts';

const SECRET = 'Zq7-uniq/Secret+Value!99';
const FORMS = [SECRET, encodeURIComponent(SECRET), Buffer.from(SECRET).toString('base64'), Buffer.from(SECRET).toString('base64').replace(/=+$/, ''), JSON.stringify(SECRET).slice(1, -1)];

describe('secrets are scrubbed in every form the SDK redactor knows (R-SE1)', () => {
  it('a message that carries the URL-encoded, base64 or JSON-escaped value never reaches stdout or stderr', async () => {
    const message = `typed ${FORMS.join(' | ')} into the field`;
    const report = makeReport({
      exitCode: 3,
      scenarios: [{
        scenarioId: 's', featureId: 'f', docUri: 'd', title: 't', driver: 'web', status: 'error', mode: 'replay', review: 'accepted',
        steps: [], recording: 'none', usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0 }, durationMs: 1,
        error: { code: 'DRIVER_ERROR', message, retryable: false },
      }],
    });
    const h = await runCli(['run'], {
      env: { ADMIN_PASSWORD: SECRET },
      config: { secrets: { adminPassword: { env: 'ADMIN_PASSWORD' } } },
      engine: { run: async () => report },
    });
    for (const form of FORMS) expect(h.stdout, `form ${form}`).not.toContain(form);
    expect(h.stdout).toContain('typed [redacted] | [redacted] | [redacted] | [redacted] | [redacted] into the field');
  });

  it('a failing engine.close() warning is scrubbed in every form as well', async () => {
    const h = await runCli(['status'], {
      env: { ADMIN_PASSWORD: SECRET },
      config: { secrets: { adminPassword: { env: 'ADMIN_PASSWORD' } } },
      engine: { close: async () => Promise.reject(new Error(`dispose failed for ${encodeURIComponent(SECRET)}`)) },
    });
    expect(h.stderr).toContain('engine close failed: dispose failed for [redacted]');
    for (const form of FORMS) expect(h.stderr).not.toContain(form);
  });

  it('forms are replaced longest first, so one that contains another leaves no remainder', async () => {
    const h = await runCli(['run'], {
      env: { ADMIN_PASSWORD: 'abcd' },
      config: { secrets: { adminPassword: { env: 'ADMIN_PASSWORD' } } },
      engine: {
        run: async () =>
          makeReport({
            exitCode: 3,
            scenarios: [{
              scenarioId: 's', featureId: 'f', docUri: 'd', title: 't', driver: 'web', status: 'error', mode: 'replay', review: 'accepted',
              steps: [], recording: 'none', usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0 }, durationMs: 1,
              error: { code: 'DRIVER_ERROR', message: `raw abcd and base64 ${Buffer.from('abcd').toString('base64')}`, retryable: false },
            }],
          }),
      },
    });
    expect(h.stdout).toContain('raw [redacted] and base64 [redacted]');
  });
});
