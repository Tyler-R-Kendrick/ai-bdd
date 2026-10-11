import { readFileSync, readdirSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  AiBddError,
  type CreatePlanStore,
  type DocPlan,
  type JsonValue,
  type LoadPlansSync,
  type PlanStore,
} from '../contracts/index.ts';
import { assertInsideRealRoot, atomicWriteFile, idTooLong, stableJson, toPosix } from '../util/index.ts';
import { parseDocPlan } from './schema.ts';

const SUFFIX = '.plan.json';

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Rejects absolute paths, empty or dots-and-blanks-only path segments (`..`, `.`, `....`, `.. `; a name such as `a..b.md` is fine), backslashes, NUL, empty uris and uris too long to be file names (R-PL4). Returns the absolute plan file path. */
export function planPathFor(dir: string, docUri: string): string {
  if (
    docUri.length === 0 ||
    idTooLong(docUri) ||
    docUri.includes('\\') ||
    docUri.includes('\0') ||
    docUri.split('/').some((seg) => seg === '' || /^[.\s]+$/.test(seg)) ||
    docUri.startsWith('/') ||
    /^[A-Za-z]:/.test(docUri) ||
    isAbsolute(docUri)
  ) {
    throw new AiBddError('POLICY_DENIED', `unsafe docUri for plan path: ${JSON.stringify(docUri)}`, { details: { docUri } });
  }
  const root = resolve(dir);
  const full = resolve(root, `${docUri}${SUFFIX}`);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new AiBddError('POLICY_DENIED', `docUri escapes the plan directory: ${JSON.stringify(docUri)}`, { details: { docUri } });
  }
  return full;
}

function parsePlanText(text: string, file: string): DocPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new AiBddError('PLAN_CORRUPT', `plan file is not valid JSON: ${file}`, { cause, details: { file } });
  }
  if (raw !== null && typeof raw === 'object' && 'schemaVersion' in raw && (raw as { schemaVersion: unknown }).schemaVersion !== 1) {
    throw new AiBddError(
      'PLAN_SCHEMA_UNSUPPORTED',
      `unsupported plan schemaVersion ${JSON.stringify((raw as { schemaVersion: unknown }).schemaVersion)} in ${file}`,
      { details: { file } },
    );
  }
  const r = parseDocPlan(raw);
  if (!r.ok) throw new AiBddError('PLAN_CORRUPT', `${r.message} (${file})`, { details: { file } });
  return r.plan;
}

function checkUri(plan: DocPlan, expectedUri: string, file: string): DocPlan {
  if (plan.docUri !== expectedUri) {
    throw new AiBddError('PLAN_CORRUPT', `plan docUri ${JSON.stringify(plan.docUri)} does not match its path (${file})`, {
      details: { file },
    });
  }
  return plan;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 'ENOENT';
}

function relUri(dir: string, file: string): string {
  return toPosix(relative(resolve(dir), file)).slice(0, -SUFFIX.length);
}

/** Plans are listed in docUri order (code units), not file name order: `a` sorts before `a-b` although `a-b.plan.json` sorts before `a.plan.json`. */
function sortByDocUri(dir: string, files: string[]): string[] {
  return files.map((file) => ({ file, uri: relUri(dir, file) })).sort((a, b) => cmp(a.uri, b.uri)).map((e) => e.file);
}

function listSync(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(SUFFIX)) out.push(p);
    }
  };
  walk(resolve(dir));
  return sortByDocUri(dir, out);
}

async function listAsync(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith(SUFFIX)) out.push(p);
    }
  };
  await walk(resolve(dir));
  return sortByDocUri(dir, out);
}

/** Synchronous plan loading for collection-time registration (R-SDK1). Never touches models, drivers or the network. */
export const loadPlansSync: LoadPlansSync = (dir) =>
  listSync(dir).map((file) => checkUri(parsePlanText(readFileSync(file, 'utf8'), file), relUri(dir, file), file));

export const createPlanStore: CreatePlanStore = ({ dir, readOnly }) => {
  const denyWrite = (what: string): never => {
    throw new AiBddError('POLICY_DENIED', `plan store is read-only; cannot ${what}`);
  };
  const store: PlanStore = {
    dir,
    async load(docUri) {
      const file = planPathFor(dir, docUri);
      await assertInsideRealRoot(file, resolve(dir));
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
      return checkUri(parsePlanText(text, file), docUri, file);
    },
    async loadAll() {
      const files = await listAsync(dir);
      const plans: DocPlan[] = [];
      for (const file of files) plans.push(checkUri(parsePlanText(await readFile(file, 'utf8'), file), relUri(dir, file), file));
      return plans;
    },
    loadAllSync() {
      return loadPlansSync(dir);
    },
    async save(plan) {
      if (readOnly) denyWrite('save');
      const file = planPathFor(dir, plan.docUri);
      const parsed = parseDocPlan(plan);
      if (!parsed.ok) throw new AiBddError('PLAN_CORRUPT', `refusing to write ${parsed.message}`, { details: { docUri: plan.docUri } });
      await assertInsideRealRoot(dirname(file)); // a plans directory that is itself a symlink out of the project must not receive plans
      await atomicWriteFile(file, stableJson(parsed.plan as unknown as JsonValue), { root: resolve(dir), sweep: true });
    },
    async remove(docUri) {
      if (readOnly) denyWrite('remove');
      const file = planPathFor(dir, docUri);
      await assertInsideRealRoot(dirname(file), resolve(dir));
      await rm(file, { force: true });
    },
  };
  return store;
};
