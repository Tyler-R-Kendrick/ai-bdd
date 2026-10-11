import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeTestConfig } from '@ai-bdd/testing';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'test-config-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('writeTestConfig', () => {
  it('writes ai-bdd.config.test.mjs that extends the real config and plugs the doubles in through drivers/models', () => {
    const file = writeTestConfig({ projectDir: dir, rulesDir: 'rules', logPath: join(dir, 'calls.jsonl'), flags: ['v2'], overrides: { settle: { quietMs: 10 } } });
    expect(file).toBe(join(dir, 'ai-bdd.config.test.mjs'));
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('import base from "./ai-bdd.config.mjs";');
    expect(text).toContain('...base,');
    expect(text).toContain('drivers: { fake: fakeDriver({ flags: ["v2"] }) }');
    expect(text).toContain("defaultDriver: 'fake'");
    expect(text).toContain(JSON.stringify(resolve(dir, 'rules')));
    expect(text).toContain(JSON.stringify(join(dir, 'calls.jsonl')));
    expect(text).toContain('"settle":{"quietMs":10}');
  });

  it('baseConfig: null starts from an empty config; fileName is honoured; nothing reads the environment', () => {
    const file = writeTestConfig({ projectDir: join(dir, 'nested'), fileName: 'x.mjs', baseConfig: null });
    expect(file).toBe(join(dir, 'nested', 'x.mjs'));
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('import base');
    expect(text).not.toContain('process.env');
  });
});
