import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { DiskObjectStore } from '../server/hosting/disk-objects.ts';
import { NativeT3StateLease } from '../server/local/native-t3-state.ts';
import { managedT3FunctionStateId, NATIVE_T3_FUNCTION_PROTOCOL_REVISION, NATIVE_T3_TRANSPORT_PROTOCOL_REVISION } from '../server/local/native-t3-protocol.ts';
import manifest from '../server/local/native-t3-tools.json' with { type: 'json' };

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const identity = (artifactId = 'owned-artifact') => ({
  t3Commit: manifest.t3Commit,
  openCodeVersion: manifest.openCodeVersion,
  artifactId,
  profile: { harness: 't3-code', provider: 'studioLocal', model: 'studio-local/qwen2.5-0.5b-instruct-q4-k-m' } as const,
  idempotencyKey: 'owned-stable-attempt',
});
const legacyId = (input: ReturnType<typeof identity>) => createHash('sha256').update(JSON.stringify([
  'managed-native-t3-v1', input.t3Commit, input.openCodeVersion, input.artifactId, input.profile, input.idempotencyKey,
])).digest('hex');
const bulkFunctionId = (input: ReturnType<typeof identity>) => createHash('sha256').update(JSON.stringify([
  NATIVE_T3_FUNCTION_PROTOCOL_REVISION, input.t3Commit, input.openCodeVersion, input.artifactId, input.profile, input.idempotencyKey,
])).digest('hex');

it('uses a stable chat-protocol namespace distinct from legacy custom-envelope checkpoints', () => {
  const input = identity();
  expect(NATIVE_T3_FUNCTION_PROTOCOL_REVISION).toBe('managed-native-t3-functions-v1');
  expect(NATIVE_T3_TRANSPORT_PROTOCOL_REVISION).toBe('managed-native-t3-reference-v1');
  const current = managedT3FunctionStateId(input);
  expect(current).toMatch(/^[a-f0-9]{64}$/);
  expect(managedT3FunctionStateId(structuredClone(input))).toBe(current);
  expect(current).not.toBe(legacyId(input));
  expect(current).not.toBe(bulkFunctionId(input));
  for (const change of [
    { t3Commit: 'different-public-t3-source' },
    { openCodeVersion: 'different-native-version' },
    { artifactId: 'another-artifact' },
    { idempotencyKey: 'another-attempt' },
    { profile: { ...input.profile, model: 'studio-local/another-registered-model' } },
    { profile: { ...input.profile, provider: 'another-registered-provider' } },
  ]) expect(managedT3FunctionStateId({ ...input, ...change })).not.toBe(current);
});

if (process.env.STUDIO_REQUIRE_NATIVE_T3_POSTGRES === '1' && !process.env.STUDIO_TEST_POSTGRES_URL)
  throw new Error('Native function checkpoint PostgreSQL acceptance requires STUDIO_TEST_POSTGRES_URL');
describe.each(['sqlite', ...(process.env.STUDIO_TEST_POSTGRES_URL ? ['postgres'] : [])])('native function checkpoint isolation on %s', adapter => {
  it.each(['legacy', 'bulk functions'])('does not read a %s checkpoint and restores only the new protocol state on a later lease', async previousProtocol => {
    const root = await mkdtemp('/tmp/studio-native-function-state-');
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const schema = 'native_fn_' + randomUUID().replaceAll('-', '');
    const store = await Store.open(adapter === 'postgres' ? await openDatabase({ adapter: 'postgres', url: process.env.STUDIO_TEST_POSTGRES_URL!, schema }) : ':memory:');
    cleanup.push(() => store.close());
    if (adapter === 'postgres') cleanup.push(() => store.db.exec('DROP SCHEMA "' + schema + '" CASCADE'));
    const user = await store.createUser(randomUUID() + '@test.invalid', 'Owned function protocol state', null);
    const project = await store.createProject(user, 'Owned checkpoint protocol boundary', '');
    const artifactId = project.mainArtifactId;
    const input = identity(artifactId);
    const oldId = previousProtocol === 'legacy' ? legacyId(input) : bulkFunctionId(input), newId = managedT3FunctionStateId(input);
    const key = randomBytes(32), objects = new DiskObjectStore(join(root, 'objects'));
    const options = { store, objects, key, artifactId };
    const oldState = join(root, 'legacy');
    await mkdir(oldState);
    await writeFile(join(oldState, 'session.json'), 'owned-legacy-custom-envelope-session');
    const old = await NativeT3StateLease.acquire({ ...options, id: oldId });
    await old.checkpoint(oldState); await old.release();
    const legacyPointer = (await store.one('SELECT checkpoint_key AS key FROM studio_native_t3_states WHERE id=?', oldId)).key;
    let downloads = 0;
    const observedObjects = {
      provider: objects.provider,
      put: objects.put.bind(objects), delete: objects.delete.bind(objects),
      async get(...args: Parameters<DiskObjectStore['get']>) { downloads++; return objects.get(...args); },
    };
    const current = await NativeT3StateLease.acquire({ ...options, objects: observedObjects, id: newId });
    expect(current.generation).toBe(1);
    await expect(current.restore(join(root, 'must-not-restore-legacy'))).resolves.toBe(false);
    expect(downloads).toBe(0);
    expect((await store.one('SELECT checkpoint_key AS key FROM studio_native_t3_states WHERE id=?', oldId)).key).toBe(legacyPointer);
    const newState = join(root, 'current');
    await mkdir(newState);
    await writeFile(join(newState, 'session.json'), 'owned-native-functions-session');
    await current.checkpoint(newState); await current.release();
    const resumed = await NativeT3StateLease.acquire({ ...options, id: newId });
    const restored = join(root, 'new-restored');
    await expect(resumed.restore(restored)).resolves.toBe(true);
    expect(await readFile(join(restored, 'session.json'), 'utf8')).toBe('owned-native-functions-session');
    await resumed.release();
    const historical = await NativeT3StateLease.acquire({ ...options, id: oldId });
    const historicalRoot = join(root, 'old-restored');
    await expect(historical.restore(historicalRoot)).resolves.toBe(true);
    expect(await readFile(join(historicalRoot, 'session.json'), 'utf8')).toBe('owned-legacy-custom-envelope-session');
    await historical.release();
  });
});
