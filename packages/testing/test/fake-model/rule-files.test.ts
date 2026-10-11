import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import { createFakeModels, FAKE_RULE_FILE_JSON_SCHEMA, loadRuleFiles, validateFakeRuleFile } from '@ai-bdd/testing';
import { req } from './helpers.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-model-rules-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rule = (id: string, who: string) => ({ rules: [{ id, purpose: 'extract', respond: { object: { who } } }] });

describe('fake-model rule files', () => {
  it('rulesDir: files load in file-name order; first match wins across files', async () => {
    writeFileSync(join(dir, '20-second.json'), JSON.stringify(rule('b', 'second')));
    writeFileSync(join(dir, '10-first.json'), JSON.stringify(rule('a', 'first')));
    writeFileSync(join(dir, '05-ignored.txt'), 'not json');
    const m = createFakeModels({ rulesDir: dir });
    expect((await m.extract.generate(req('extract', {}))).object).toEqual({ who: 'first' });
    expect(loadRuleFiles(dir).map((f) => f.rules[0]?.id)).toEqual(['a', 'b']);
  });

  it('opts.rules are consulted before rulesDir', async () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(rule('dir', 'dir')));
    const m = createFakeModels({ rules: [rule('mem', 'mem') as never], rulesDir: dir });
    expect((await m.extract.generate(req('extract', {}))).object).toEqual({ who: 'mem' });
  });

  it('invalid JSON names the file and throws CONFIG_INVALID', () => {
    writeFileSync(join(dir, 'bad.json'), '{ nope');
    expect(() => loadRuleFiles(dir)).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID', message: expect.stringContaining('bad.json') }));
  });

  it('a missing rulesDir throws CONFIG_INVALID', () => {
    expect(() => createFakeModels({ rulesDir: join(dir, 'nope') })).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    mkdirSync(join(dir, 'empty'));
    expect(loadRuleFiles(join(dir, 'empty'))).toEqual([]);
  });

  const invalid: [string, unknown, string][] = [
    ['not an object', [], 'must be an object'],
    ['rules missing', {}, '$.rules'],
    ['unknown top-level key', { rules: [], extra: 1 }, 'unknown key'],
    ['rule without id', { rules: [{ purpose: 'act', respond: { text: 't' } }] }, '.id'],
    ['bad purpose', { rules: [{ id: 'x', purpose: 'plan', respond: { text: 't' } }] }, 'extract, act, checkgen, judge'],
    ['missing respond', { rules: [{ id: 'x', purpose: 'act' }] }, 'respond'],
    ['respond with two kinds', { rules: [{ id: 'x', purpose: 'act', respond: { text: 't', object: {} } }] }, 'exactly one of'],
    ['respond with no known kind', { rules: [{ id: 'x', purpose: 'act', respond: { nope: 1 } }] }, 'exactly one of'],
    ['text not a string', { rules: [{ id: 'x', purpose: 'act', respond: { text: 1 } }] }, 'text'],
    ['empty samples', { rules: [{ id: 'x', purpose: 'judge', respond: { samples: [] } }] }, 'samples'],
    ['empty byAttempt', { rules: [{ id: 'x', purpose: 'judge', respond: { byAttempt: [] } }] }, 'byAttempt'],
    ['bad nested byAttempt entry', { rules: [{ id: 'x', purpose: 'judge', respond: { byAttempt: [{ nope: 1 }] } }] }, 'byAttempt[0]'],
    ['script step without tool', { rules: [{ id: 'x', purpose: 'act', respond: { script: [{ args: {} }] } }] }, 'script[0].tool'],
    ['target without role', { rules: [{ id: 'x', purpose: 'act', respond: { script: [{ tool: 'click', args: { target: { name: 'a' } } }] } }] }, 'target.role'],
    ['unknown target key', { rules: [{ id: 'x', purpose: 'act', respond: { script: [{ tool: 'click', args: { target: { role: 'a', nth: 2 } } }] } }] }, 'unknown target key'],
    ['bad matcher', { rules: [{ id: 'x', purpose: 'act', when: { a: 5 }, respond: { text: 't' } }] }, 'matcher'],
    ['matcher with two operators', { rules: [{ id: 'x', purpose: 'act', when: { a: { contains: 'a', in: [] } }, respond: { text: 't' } }] }, 'matcher'],
    ['in with non-strings', { rules: [{ id: 'x', purpose: 'act', when: { a: { in: [1] } }, respond: { text: 't' } }] }, '"in"'],
    ['unknown rule key', { rules: [{ id: 'x', purpose: 'act', respond: { text: 't' }, wehn: {} }] }, 'unknown rule key'],
  ];
  it.each(invalid)('validator rejects: %s (CONFIG_INVALID with a helpful message)', (_n, value, fragment) => {
    let err: unknown;
    try {
      validateFakeRuleFile(value, 'test.json');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AiBddError);
    expect((err as AiBddError).code).toBe('CONFIG_INVALID');
    expect((err as AiBddError).message).toContain('test.json');
    expect((err as AiBddError).message).toContain(fragment);
  });

  it('validator reports every problem, not just the first', () => {
    const e = (() => {
      try {
        validateFakeRuleFile({ rules: [{ purpose: 'x', respond: 1 }] });
      } catch (err) {
        return err as AiBddError;
      }
      throw new Error('should throw');
    })();
    expect((e.details as { problems: string[] }).problems.length).toBeGreaterThanOrEqual(3);
  });

  it('createFakeModels validates programmatic rules too', () => {
    expect(() => createFakeModels({ rules: [{ rules: [{ id: 'x', purpose: 'act' }] }] as never })).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('accepts every documented respond kind and matcher', () => {
    const ok = validateFakeRuleFile({
      $schema: './schema.json',
      rules: [
        { id: '1', purpose: 'extract', description: 'd', when: { a: 'x', b: { contains: 'y' }, c: { notContains: 'z' }, d: { in: ['p', 'q'] } }, respond: { object: { k: [1, null, 'v'] } } },
        { id: '2', purpose: 'act', respond: { script: [{ tool: 'click', args: { target: { role: 'button', name: 'n', within: 'w' } } }, { tool: 'back' }] } },
        { id: '3', purpose: 'judge', respond: { samples: [{ probability: 1 }] } },
        { id: '4', purpose: 'checkgen', respond: { byAttempt: [{ text: 't' }, { object: {} }] } },
      ],
    });
    expect(ok.rules).toHaveLength(4);
  });

  it('exports a JSON Schema describing the format', () => {
    expect(FAKE_RULE_FILE_JSON_SCHEMA['required']).toEqual(['rules']);
    expect(() => JSON.stringify(FAKE_RULE_FILE_JSON_SCHEMA)).not.toThrow();
  });
});
