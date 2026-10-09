import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createRedactor, secretVariants } from '@ai-bdd/evidence';

/** Attack 2: leak a secret into any artifact, log, lockfile, report or prompt. */
describe('attack 2: secret leakage', () => {
  it('redacts the value, its URL encoding and its base64 form at any offset', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9!@#]{8,24}$/u),
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 20 }),
        (secret, before, after) => {
          const redactor = createRedactor({ token: { value: secret } });
          for (const variant of secretVariants(secret)) {
            const text = `${before}${variant}${after}`;
            const redacted = redactor.redact(text);
            expect(redacted).not.toContain(variant);
            expect(redacted).toContain('<secret:token>');
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('redacts nested JSON values and keys', () => {
    const redactor = createRedactor({ token: { value: 'super-secret-value' } });
    const payload = { log: ['filled super-secret-value', { nested: 'super-secret-value' }], url: 'http://x/?t=super-secret-value' };
    const redacted = redactor.redactJson(payload);
    expect(JSON.stringify(redacted)).not.toContain('super-secret-value');
  });

  it('rejects a secret so short that redaction would blank unrelated text', () => {
    const redactor = createRedactor({ pin: { value: '123' } });
    // A 3-character value is ignored, which is why config load rejects it too.
    expect(redactor.names()).toEqual([]);
  });

  it('never writes a secret into an evidence artifact', async () => {
    const { EvidenceStore, verifyEvidence } = await import('@ai-bdd/evidence');
    const { mkdtempSync, readFileSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const runDir = mkdtempSync(join(tmpdir(), 'aibdd-adv-secret-'));
    const store = new EvidenceStore(runDir, { redactor: createRedactor({ token: { value: 'leak-me-please' } }) });
    const record = await store.write({ kind: 'log', data: 'the driver typed leak-me-please into the field', ext: 'txt' });
    await store.finalize();
    expect(readFileSync(join(runDir, record.artifact.path), 'utf8')).not.toContain('leak-me-please');
    const manifest = readFileSync(join(runDir, 'manifest.jsonl'), 'utf8');
    expect(manifest).not.toContain('leak-me-please');
    expect((await verifyEvidence(runDir)).ok).toBe(true);
    expect(readdirSync(join(runDir, 'artifacts')).length).toBe(1);
  });
});
