import { readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { AiBddError, type CreateRecordingStore, type JsonValue, type RecordingsMode, type RecordingStore, type ScenarioRecording } from '../contracts/index.ts';
import { atomicWriteFile, stableJson } from '../util/index.ts';
import { ScenarioRecordingSchema } from './schema.ts';

const SAFE_SEGMENT = /^[a-z0-9._-]+$/;
const FILE_EXT = '.json';

function assertSegment(kind: string, segment: string): void {
  if (!SAFE_SEGMENT.test(segment) || /^\.+$/.test(segment)) {
    throw new AiBddError('POLICY_DENIED', `unsafe ${kind} for recording path: ${JSON.stringify(segment)}`, { details: { kind, value: segment } });
  }
}

/** `${dir}/${driverId}/${scenarioId}.json`, the scenario id's `/` becoming a directory separator. */
export function recordingPath(dir: string, driverId: string, scenarioId: string): string {
  assertSegment('driver id', driverId);
  const segments = scenarioId.split('/');
  for (const s of segments) assertSegment('scenario id segment', s);
  const last = segments.pop() ?? '';
  const root = resolve(dir);
  const path = join(root, driverId, ...segments, `${last}${FILE_EXT}`);
  if (!path.startsWith(root + sep)) throw new AiBddError('POLICY_DENIED', 'recording path escapes the recordings directory');
  return path;
}

function parseRecording(text: string, path: string): ScenarioRecording {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AiBddError('RECORDING_CORRUPT', `recording is not valid JSON: ${path}`, { cause: err, details: { path } });
  }
  const parsed = ScenarioRecordingSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AiBddError('RECORDING_CORRUPT', `recording does not match the schema: ${path}`, {
      details: { path, issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) },
    });
  }
  return parsed.data as unknown as ScenarioRecording;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function walk(dir: string, rel: string[]): Promise<string[][]> {
  let entries;
  try {
    entries = await readdir(join(dir, ...rel), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: string[][] = [];
  for (const e of entries) {
    if (e.isDirectory()) out.push(...(await walk(dir, [...rel, e.name])));
    else if (e.isFile() && e.name.endsWith(FILE_EXT)) out.push([...rel, e.name]);
  }
  return out;
}

export const createRecordingStore: CreateRecordingStore = (opts: { dir: string; mode: RecordingsMode }): RecordingStore => {
  const { dir, mode } = opts;
  const requireWritable = (what: string): void => {
    if (mode !== 'read-write') throw new AiBddError('RECORDING_READ_ONLY', `cannot ${what}: recordings mode is ${mode}`, { details: { mode } });
  };

  return {
    dir,
    mode,

    async load(driverId, scenarioId) {
      if (mode === 'off') return null;
      const path = recordingPath(dir, driverId, scenarioId);
      const text = await readIfExists(path);
      if (text === null) return null;
      const rec = parseRecording(text, path);
      if (rec.scenarioId !== scenarioId || rec.driver.id !== driverId) {
        throw new AiBddError('RECORDING_CORRUPT', `recording identity does not match its path: ${path}`, { details: { path } });
      }
      return rec;
    },

    async save(rec) {
      requireWritable('save a recording');
      const path = recordingPath(dir, rec.driver.id, rec.scenarioId);
      const parsed = ScenarioRecordingSchema.safeParse(rec);
      if (!parsed.success) {
        throw new AiBddError('RECORDING_CORRUPT', 'refusing to save a recording that does not match the schema', {
          details: { issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) },
        });
      }
      const bytes = stableJson(parsed.data as JsonValue);
      const existing = await readIfExists(path);
      if (existing === bytes) return 'unchanged';
      await atomicWriteFile(path, bytes, { sweep: true });
      return existing === null ? 'created' : 'updated';
    },

    async remove(driverId, scenarioId) {
      requireWritable('remove a recording');
      const path = recordingPath(dir, driverId, scenarioId);
      await rm(path, { force: true });
      const root = resolve(dir);
      for (let d = dirname(path); d.startsWith(root + sep); d = dirname(d)) {
        try {
          await rmdir(d);
        } catch {
          break;
        }
      }
    },

    async list() {
      if (mode === 'off') return [];
      const out: { driverId: string; scenarioId: string }[] = [];
      for (const parts of await walk(resolve(dir), [])) {
        const [driverId, ...rest] = parts;
        const file = rest.pop();
        if (driverId === undefined || file === undefined) continue;
        const scenarioId = [...rest, file.slice(0, -FILE_EXT.length)].join('/');
        if (!SAFE_SEGMENT.test(driverId) || !scenarioId.split('/').every((s) => SAFE_SEGMENT.test(s) && !/^\.+$/.test(s))) continue;
        out.push({ driverId, scenarioId });
      }
      return out.sort((a, b) => (a.driverId < b.driverId ? -1 : a.driverId > b.driverId ? 1 : a.scenarioId < b.scenarioId ? -1 : a.scenarioId > b.scenarioId ? 1 : 0));
    },
  };
};
