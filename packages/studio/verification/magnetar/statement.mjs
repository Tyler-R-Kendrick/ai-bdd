import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const execute = promisify(execFile);
export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
export async function boundedFile(path, maximum = 64 * 1024 * 1024) {
  assert(
    (await stat(path)).size <= maximum,
    'Proof input exceeds the configured bound',
  );
  return readFile(path);
}
export function publicInstance(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'OMIN');
  assert.equal(bytes[4], 1);
  let cursor = 5;
  const u64 = () => {
    assert(cursor + 8 <= bytes.length);
    const value = bytes.readBigUInt64LE(cursor);
    cursor += 8;
    return value;
  };
  const vector = () => {
    const size = Number(u64());
    assert(
      Number.isSafeInteger(size) &&
        size >= 0 &&
        cursor + size <= bytes.length,
    );
    const value = bytes.subarray(cursor, cursor + size);
    cursor += size;
    return value;
  };
  const cycles = u64(),
    input = vector(),
    output = vector(),
    exitCode = u64();
  assert.equal(cursor, bytes.length, 'Trailing instance bytes');
  return { cycles, input, output, exitCode };
}
export async function verifyBundle(
  { program, input, output, proof },
  env = process.env,
) {
  const cli = env.STUDIO_OPEN_MAGNETAR_CLI;
  assert(
    cli && isAbsolute(cli),
    'Set an absolute operator-trusted STUDIO_OPEN_MAGNETAR_CLI',
  );
  assert.match(
    env.STUDIO_OPEN_MAGNETAR_BINARY_SHA256 ?? '',
    /^[a-f0-9]{64}$/,
    'Pin the built CLI checksum',
  );
  assert.equal(
    sha256(await boundedFile(cli, 128 * 1024 * 1024)),
    env.STUDIO_OPEN_MAGNETAR_BINARY_SHA256,
    'Verifier binary checksum mismatch',
  );
  const upstream = JSON.parse(
    await readFile(new URL('./upstream.json', import.meta.url)),
  );
  const bundle = JSON.parse(await boundedFile(proof));
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.implementation, 'Lulzx/open-magnetar');
  assert.equal(bundle.commit, upstream.commit);
  assert.equal(bundle.profile, 'provable-120');
  assert.equal(bundle.pcs, 'ligerito');
  assert.equal(bundle.hash, 'sha384');
  const instanceBytes = Buffer.from(bundle.instance, 'base64'),
    statement = publicInstance(instanceBytes);
  const inputBytes = await boundedFile(input),
    outputBytes = await boundedFile(output),
    programBytes = await boundedFile(program);
  assert(
    statement.input.equals(inputBytes),
    'The cryptographic instance binds a different input',
  );
  assert(
    statement.output.equals(outputBytes),
    'The cryptographic instance binds a different output',
  );
  assert.equal(statement.exitCode, 0n, 'The proven execution failed');
  const scratch = await mkdtemp(join(tmpdir(), 'studio-magnetar-verify-'));
  try {
    const key = join(scratch, 'program.vk'),
      inst = join(scratch, 'instance.bin'),
      blob = join(scratch, 'proof.bin');
    await writeFile(inst, instanceBytes);
    await writeFile(blob, Buffer.from(bundle.proof, 'base64'));
    // Recompute the verifying key from the supplied program. Never trust a key
    // bundled by the prover for a different program or a test/mock PCS profile.
    await execute(
      cli,
      [
        'keygen',
        '--elf',
        resolve(program),
        '--out',
        key,
        '--profile',
        'provable-120',
        '--pcs',
        'ligerito',
        '--hash',
        'sha384',
        '--ram-log-words',
        '16',
        '--input-log-words',
        '4',
        '--output-log-words',
        '4',
      ],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    const result = await execute(
      cli,
      ['verify', '--vk', key, '--instance', inst, '--proof', blob],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(
      result.stdout.trim(),
      'OK',
      'Verifier did not accept the cryptographic proof',
    );
    return {
      verified: true,
      system: 'magnetar',
      programSha256: sha256(programBytes),
      inputSha256: sha256(inputBytes),
      outputSha256: sha256(outputBytes),
      proofSha256: sha256(await boundedFile(proof)),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
