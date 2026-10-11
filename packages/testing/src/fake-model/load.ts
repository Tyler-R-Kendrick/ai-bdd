import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import { validateFakeRuleFile } from './schema.ts';
import type { FakeRuleFile } from './types.ts';

/** Load and validate every `*.json` file of `dir`, in file-name order (plain code-unit order, locale independent). */
export function loadRuleFiles(dir: string): FakeRuleFile[] {
  let names: string[];
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (cause) {
    throw new AiBddError('CONFIG_INVALID', `Fake model rules directory not readable: ${dir}`, { cause, details: { dir } });
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.map((name) => {
    const file = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (cause) {
      throw new AiBddError('CONFIG_INVALID', `Fake model rule file ${file} is not valid JSON: ${(cause as Error).message}`, {
        cause,
        details: { file },
      });
    }
    return validateFakeRuleFile(parsed, file);
  });
}
