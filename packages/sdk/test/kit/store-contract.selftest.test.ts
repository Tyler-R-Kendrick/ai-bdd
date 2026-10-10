import { mkdir, open, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DocPlan, EvidenceStore, JsonValue, PlanStore, RecordingStore, ScenarioRecording } from '../../src/contracts/index.ts';
import { createEvidenceStore, verifyRun } from '../../src/evidence/index.ts';
import { createPlanStore, planPathFor } from '../../src/plan/index.ts';
import { createRecordingStore, recordingPath } from '../../src/recording/index.ts';
import { stableJson } from '../../src/util/index.ts';
import {
  evidenceStoreContractCases,
  planStoreContractCases,
  recordingStoreContractCases,
  type MakeEvidenceStore,
  type MakePlanStore,
  type MakeRecordingStore,
  type StoreCase,
} from './store-contract.ts';

/**
 * The store kits are only worth something if they fail for broken stores. Each mutant below wraps the real
 * filesystem store and breaks exactly one promise of the contract; the test names the kit cases that must catch it.
 * (The real stores run the kits in store.contract.test.ts next to each implementation.)
 */

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Writes in place, in two halves with the event loop turning in between: what a non-atomic write looks like to a reader. */
async function tornWrite(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const fh = await open(file, 'w');
  try {
    const half = Math.floor(text.length / 2);
    await fh.write(text.slice(0, half));
    for (let i = 0; i < 8; i += 1) await turn();
    await fh.write(text.slice(half));
  } finally {
    await fh.close();
  }
}

async function failing(cases: StoreCase[]): Promise<string[]> {
  const failed: string[] = [];
  for (const c of cases) {
    try {
      await c.run();
    } catch {
      failed.push(c.name);
    }
  }
  return failed;
}

function expectCaught(mutation: string, failed: string[], expected: RegExp): void {
  // Only the cases that are supposed to guard the property were run: at least one of them must fail.
  expect(failed.length, `${mutation} slipped through every case matching ${String(expected)}`).toBeGreaterThan(0);
}

// ───────────────────────── plan store

type PlanMutation =
  | 'none'
  | 'torn-write'
  | 'not-canonical'
  | 'unsorted-list'
  | 'file-name-order'
  | 'remove-throws-when-missing'
  | 'ignores-read-only'
  | 'no-id-checks'
  | 'follows-symlinks'
  | 'shares-objects'
  | 'case-folding'
  | 'corrupt-as-null'
  | 'writes-invalid-plans'
  | 'leaves-temp-files'
  | 'creates-dir-on-read';

function planMutant(mutation: PlanMutation): MakePlanStore {
  return (dir, { readOnly }) => {
    const real = createPlanStore({ dir, readOnly: mutation === 'ignores-read-only' ? false : readOnly });
    const cache = new Map<string, DocPlan>();
    const store: PlanStore = { ...real };
    switch (mutation) {
      case 'torn-write':
        store.save = async (plan) => {
          if (readOnly) return real.save(plan);
          await tornWrite(planPathFor(dir, plan.docUri), stableJson(plan as unknown as JsonValue));
        };
        break;
      case 'not-canonical':
        store.save = async (plan) => {
          const file = planPathFor(dir, plan.docUri);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, JSON.stringify(plan));
        };
        break;
      case 'unsorted-list':
        store.loadAll = async () => (await real.loadAll()).reverse();
        store.loadAllSync = () => real.loadAllSync().reverse();
        break;
      case 'file-name-order':
        store.loadAll = async () => {
          const all = await real.loadAll();
          return all.sort((a, b) => (`${a.docUri}.plan.json` < `${b.docUri}.plan.json` ? -1 : 1));
        };
        break;
      case 'remove-throws-when-missing':
        store.remove = async (docUri) => {
          if (readOnly) return real.remove(docUri);
          await unlink(planPathFor(dir, docUri));
        };
        break;
      case 'no-id-checks':
        store.save = async (plan) => {
          const file = join(resolve(dir), `${plan.docUri}.plan.json`);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, stableJson(plan as unknown as JsonValue));
        };
        store.load = async (docUri) => {
          try {
            return JSON.parse(await readFile(join(resolve(dir), `${docUri}.plan.json`), 'utf8')) as DocPlan;
          } catch {
            return null;
          }
        };
        store.remove = async (docUri) => {
          await rm(join(resolve(dir), `${docUri}.plan.json`), { force: true });
        };
        break;
      case 'follows-symlinks':
        store.save = async (plan) => {
          if (readOnly) return real.save(plan);
          const file = planPathFor(dir, plan.docUri);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, stableJson(plan as unknown as JsonValue));
        };
        store.load = async (docUri) => {
          try {
            return JSON.parse(await readFile(planPathFor(dir, docUri), 'utf8')) as DocPlan;
          } catch {
            return null;
          }
        };
        store.remove = async (docUri) => {
          if (readOnly) return real.remove(docUri);
          await rm(planPathFor(dir, docUri), { force: true });
        };
        break;
      case 'shares-objects':
        store.save = async (plan) => {
          await real.save(plan);
          cache.set(plan.docUri, plan);
        };
        store.load = async (docUri) => cache.get(docUri) ?? real.load(docUri);
        break;
      case 'case-folding':
        store.save = (plan) => real.save({ ...plan, docUri: plan.docUri.toLowerCase() });
        store.load = (docUri) => real.load(docUri.toLowerCase());
        break;
      case 'corrupt-as-null':
        store.load = async (docUri) => real.load(docUri).catch(() => null);
        break;
      case 'writes-invalid-plans':
        store.save = async (plan) => {
          if (readOnly) return real.save(plan);
          const file = planPathFor(dir, plan.docUri);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, stableJson(plan as unknown as JsonValue));
        };
        break;
      case 'leaves-temp-files':
        store.save = async (plan) => {
          await real.save(plan);
          if (!readOnly) await writeFile(`${planPathFor(dir, plan.docUri)}.tmp`, 'leftover');
        };
        break;
      case 'creates-dir-on-read':
        store.load = async (docUri) => {
          await mkdir(dir, { recursive: true });
          return real.load(docUri);
        };
        break;
      case 'none':
        break;
    }
    return store;
  };
}

describe('fault injection against the plan store (what each contract case guards)', () => {
  it('the real store passes every case', async () => {
    expect(await failing(planStoreContractCases(planMutant('none')))).toEqual([]);
  }, 120_000);

  const mutants: Array<[PlanMutation, RegExp]> = [
    ['torn-write', /overwrite is atomic/],
    ['not-canonical', /canonical JSON/],
    ['unsorted-list', /sorted by docUri/],
    ['file-name-order', /sorted by docUri/],
    ['remove-throws-when-missing', /remove is idempotent/],
    ['ignores-read-only', /read-only store/],
    ['no-id-checks', /would leave the store directory/],
    ['follows-symlinks', /symlink/],
    ['shares-objects', /fresh objects/],
    ['case-folding', /differ only by case/],
    ['corrupt-as-null', /damaged files/],
    ['writes-invalid-plans', /fails validation/],
    ['leaves-temp-files', /single file|exactly one file|hold exactly one file|atomic/],
    ['creates-dir-on-read', /reading creates nothing/],
  ];
  it.each(mutants)('%s is caught', async (mutation, expected) => {
    expectCaught(mutation, await failing(planStoreContractCases(planMutant(mutation)).filter((c) => expected.test(c.name))), expected);
  }, 60_000);

  it('the read-only code is a parameter of the kit', async () => {
    const failed = await failing(planStoreContractCases(planMutant('none'), { readOnlyCode: 'RECORDING_READ_ONLY' }).filter((c) => /read-only/.test(c.name)));
    expect(failed).toEqual(['a read-only store reads, refuses every write with the documented code, and leaves every byte as it was']);
  });
});

// ───────────────────────── recording store

type RecordingMutation =
  | 'none'
  | 'torn-write'
  | 'always-created'
  | 'always-rewrites'
  | 'unsorted-list'
  | 'ignores-read-only'
  | 'off-serves'
  | 'follows-symlinks'
  | 'remove-throws-when-missing'
  | 'writes-invalid-recordings'
  | 'shares-objects'
  | 'corrupt-as-null';

function recordingMutant(mutation: RecordingMutation): MakeRecordingStore {
  return (dir, { mode }) => {
    const real = createRecordingStore({ dir, mode: mutation === 'ignores-read-only' ? 'read-write' : mode });
    const cache = new Map<string, ScenarioRecording>();
    const store: RecordingStore = { ...real, mode };
    const pathOf = (rec: ScenarioRecording): string => recordingPath(dir, rec.driver.id, rec.scenarioId);
    switch (mutation) {
      case 'torn-write':
        store.save = async (rec) => {
          if (mode !== 'read-write') return real.save(rec);
          const existed = (await real.load(rec.driver.id, rec.scenarioId)) !== null;
          await tornWrite(pathOf(rec), stableJson(rec as unknown as JsonValue));
          return existed ? 'updated' : 'created';
        };
        break;
      case 'always-created':
        store.save = async (rec) => {
          await real.save(rec);
          return 'created';
        };
        break;
      case 'always-rewrites':
        store.save = async (rec) => {
          const verdict = await real.save(rec);
          if (verdict === 'unchanged') await writeFile(pathOf(rec), stableJson(rec as unknown as JsonValue));
          return verdict;
        };
        break;
      case 'unsorted-list':
        store.list = async () => (await real.list()).reverse();
        break;
      case 'off-serves':
        store.load = async (driverId, scenarioId) => createRecordingStore({ dir, mode: 'read-only' }).load(driverId, scenarioId);
        break;
      case 'follows-symlinks':
        store.save = async (rec) => {
          if (mode !== 'read-write') return real.save(rec);
          const existing = await readFile(pathOf(rec), 'utf8').catch(() => null);
          const bytes = stableJson(rec as unknown as JsonValue);
          if (existing === bytes) return 'unchanged';
          await mkdir(dirname(pathOf(rec)), { recursive: true });
          await writeFile(pathOf(rec), bytes);
          return existing === null ? 'created' : 'updated';
        };
        store.load = async (driverId, scenarioId) => {
          if (mode === 'off') return null;
          try {
            return JSON.parse(await readFile(recordingPath(dir, driverId, scenarioId), 'utf8')) as ScenarioRecording;
          } catch {
            return null;
          }
        };
        store.remove = async (driverId, scenarioId) => {
          if (mode !== 'read-write') return real.remove(driverId, scenarioId);
          await rm(recordingPath(dir, driverId, scenarioId), { force: true });
        };
        break;
      case 'remove-throws-when-missing':
        store.remove = async (driverId, scenarioId) => {
          if (mode !== 'read-write') return real.remove(driverId, scenarioId);
          await unlink(recordingPath(dir, driverId, scenarioId));
        };
        break;
      case 'writes-invalid-recordings':
        store.save = async (rec) => {
          if (mode !== 'read-write') return real.save(rec);
          await mkdir(dirname(pathOf(rec)), { recursive: true });
          await writeFile(pathOf(rec), stableJson(rec as unknown as JsonValue));
          return 'created';
        };
        break;
      case 'shares-objects':
        store.save = async (rec) => {
          const verdict = await real.save(rec);
          cache.set(`${rec.driver.id}\0${rec.scenarioId}`, rec);
          return verdict;
        };
        store.load = async (driverId, scenarioId) => cache.get(`${driverId}\0${scenarioId}`) ?? real.load(driverId, scenarioId);
        break;
      case 'corrupt-as-null':
        store.load = async (driverId, scenarioId) => real.load(driverId, scenarioId).catch(() => null);
        break;
      case 'ignores-read-only':
      case 'none':
        break;
    }
    return store;
  };
}

describe('fault injection against the recording store (what each contract case guards)', () => {
  it('the real store passes every case', async () => {
    expect(await failing(recordingStoreContractCases(recordingMutant('none')))).toEqual([]);
  }, 120_000);

  const mutants: Array<[RecordingMutation, RegExp]> = [
    ['torn-write', /overwrite is atomic/],
    ['always-created', /created, unchanged and updated/],
    ['always-rewrites', /created, unchanged and updated/],
    ['unsorted-list', /list is sorted/],
    ['ignores-read-only', /read-only: reads work/],
    ['off-serves', /mode 'off'/],
    ['follows-symlinks', /symlink/],
    ['remove-throws-when-missing', /remove is idempotent/],
    ['writes-invalid-recordings', /fails validation/],
    ['shares-objects', /fresh objects/],
    ['corrupt-as-null', /damaged files/],
  ];
  it.each(mutants)('%s is caught', async (mutation, expected) => {
    expectCaught(mutation, await failing(recordingStoreContractCases(recordingMutant(mutation)).filter((c) => expected.test(c.name))), expected);
  }, 60_000);
});

// ───────────────────────── evidence store

type EvidenceMutation =
  | 'none'
  | 'no-redaction'
  | 'unsorted-artifacts'
  | 'verify-always-ok'
  | 'verify-ignores-content'
  | 'torn-artifact-write'
  | 'ref-lies-about-size'
  | 'record-out-of-order'
  | 'digest-differs-from-manifest';

function evidenceMutant(mutation: EvidenceMutation): { make: MakeEvidenceStore; verify: typeof verifyRun } {
  const make: MakeEvidenceStore = async (runsDir, runId, redactor) => {
    const real = await createEvidenceStore({
      runsDir,
      runId,
      redactor: mutation === 'no-redaction' ? { secretNames: [], redact: (t) => t, redactJson: (v) => v } : redactor,
    });
    const store: EvidenceStore = { runId: real.runId, dir: real.dir, putArtifact: real.putArtifact, record: real.record, finalize: real.finalize };
    switch (mutation) {
      case 'unsorted-artifacts':
        store.finalize = async () => {
          const fin = await real.finalize();
          return { ...fin, artifacts: [...fin.artifacts].reverse() };
        };
        break;
      case 'torn-artifact-write':
        store.putArtifact = async (kind, data) => {
          const ref = await real.putArtifact(kind, data);
          const file = join(real.dir, ref.path);
          const bytes = await readFile(file);
          await tornWrite(file, bytes.toString('latin1'));
          return ref;
        };
        break;
      case 'ref-lies-about-size':
        store.putArtifact = async (kind, data) => ({ ...(await real.putArtifact(kind, data)), bytes: 1 });
        break;
      case 'record-out-of-order': {
        let n = 0;
        store.record = async (entry) => {
          n += 1;
          if (n % 2 === 1) for (let i = 0; i < 5; i += 1) await turn();
          await real.record(entry);
        };
        break;
      }
      case 'digest-differs-from-manifest':
        store.finalize = async () => {
          const fin = await real.finalize();
          return { ...fin, digest: fin.digest.replace(/^./, fin.digest.startsWith('a') ? 'b' : 'a') };
        };
        break;
      default:
        break;
    }
    return store;
  };
  const verify: typeof verifyRun = async (dir) => {
    if (mutation === 'verify-always-ok') return { ok: true, problems: [] };
    if (mutation === 'verify-ignores-content') {
      const names = await readdir(join(dir, 'artifacts')).catch(() => []);
      return { ok: names.length >= 0 && (await readFile(join(dir, 'manifest.json'), 'utf8').then(() => true, () => false)), problems: [] };
    }
    return verifyRun(dir);
  };
  return { make, verify };
}

describe('fault injection against the evidence store (what each contract case guards)', () => {
  it('the real store passes every case', async () => {
    const { make, verify } = evidenceMutant('none');
    expect(await failing(evidenceStoreContractCases(make, { verify }))).toEqual([]);
  }, 120_000);

  const mutants: Array<[EvidenceMutation, RegExp]> = [
    ['no-redaction', /redacted before it is hashed|secret never reaches disk/],
    ['unsorted-artifacts', /finalize lists every artifact once, sorted/],
    ['verify-always-ok', /tamper evidence|unfinalized/],
    ['verify-ignores-content', /tamper evidence: (flipping|replacing|truncating|swapping|deleting|adding)/],
    ['torn-artifact-write', /writing an artifact is atomic/],
    ['ref-lies-about-size', /content addressed/],
    ['record-out-of-order', /record keeps every event/],
    ['digest-differs-from-manifest', /finalized run verifies/],
  ];
  it.each(mutants)('%s is caught', async (mutation, expected) => {
    const { make, verify } = evidenceMutant(mutation);
    expectCaught(mutation, await failing(evidenceStoreContractCases(make, { verify }).filter((c) => expected.test(c.name))), expected);
  }, 60_000);
});
