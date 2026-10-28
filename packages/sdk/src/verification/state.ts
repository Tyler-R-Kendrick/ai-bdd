import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AiBddError, type FeatureResult, type JsonValue, type ResolvedConfig } from '../contracts/index.ts';
import { FeatureResultSchema } from '../report/schema.ts';
import { assertInsideRealRoot, atomicWriteFile, stableJson } from '../util/index.ts';

export function featureStatePath(config: ResolvedConfig): string {
  return join(dirname(config.runsDir), 'state', 'features.json');
}

export async function loadFeatureResults(config: ResolvedConfig): Promise<FeatureResult[]> {
  const file = featureStatePath(config);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new AiBddError('EVIDENCE_CORRUPT', `cannot read feature test state: ${file}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AiBddError('EVIDENCE_CORRUPT', `feature test state is not valid JSON: ${file}`, { cause: error });
  }
  const list = (raw as { features?: unknown } | null)?.features;
  if (!Array.isArray(list)) throw new AiBddError('EVIDENCE_CORRUPT', `feature test state has no features array: ${file}`);
  const out: FeatureResult[] = [];
  for (const value of list) {
    const parsed = FeatureResultSchema.safeParse(value);
    if (!parsed.success) throw new AiBddError('EVIDENCE_CORRUPT', `feature test state contains an invalid feature result: ${file}`);
    out.push(parsed.data);
  }
  return out;
}

/** Replace selected features, retain the last state of unselected ones, and drop deleted PDD features. */
export async function saveFeatureResults(config: ResolvedConfig, current: readonly FeatureResult[]): Promise<void> {
  const file = featureStatePath(config);
  await assertInsideRealRoot(dirname(file));
  const body = { schemaVersion: 1, features: current };
  await atomicWriteFile(file, stableJson(body as unknown as JsonValue));
}
