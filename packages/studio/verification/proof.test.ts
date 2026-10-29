import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyExternalProof } from './proof.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'studio-proof-'));
  roots.push(root);
  const files = {
    program: join(root, 'program.bin'),
    input: join(root, 'input.json'),
    output: join(root, 'output.json'),
    receipt: join(root, 'receipt.json'),
    verifier: join(root, 'test-verifier.cjs'),
  };
  await Promise.all([
    writeFile(files.program, 'program'),
    writeFile(files.input, 'input'),
    writeFile(files.output, 'output'),
    writeFile(join(root, 'proof.bin'), 'fixture-only-proof'),
  ]);
  const receipt = {
    schemaVersion: 1,
    system: 'magnetar',
    programSha256: digest('program'),
    inputSha256: digest('input'),
    outputSha256: digest('output'),
    proofSha256: digest('fixture-only-proof'),
    proofFile: 'proof.bin',
  };
  await writeFile(files.receipt, JSON.stringify(receipt));
  // Protocol test double, deliberately not a cryptographic verifier or a production proof.
  await writeFile(
    files.verifier,
    `#!${process.execPath}\nconst fs=require('node:fs');const crypto=require('node:crypto');const argv=process.argv.slice(2);if(argv[0]!=='verify')process.exit(2);const out={verified:true,system:'magnetar'};for(const n of ['program','input','output','proof']){const p=argv[argv.indexOf('--'+n)+1];out[n+'Sha256']=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}process.stdout.write(JSON.stringify(out));\n`,
  );
  await chmod(files.verifier, 0o700);
  return { root, files, receipt };
}

describe('external proof trust boundary', () => {
  it('requires a successful external verifier verdict bound to all four digests', async () => {
    const { files } = await fixture();
    expect(await verifyExternalProof(files)).toMatchObject({
      verified: true,
      programSha256: digest('program'),
      inputSha256: digest('input'),
      outputSha256: digest('output'),
    });
  });

  it('rejects a tampered program before executing the verifier', async () => {
    const { files } = await fixture();
    await writeFile(files.program, 'different-program');
    await expect(verifyExternalProof(files)).rejects.toThrow('programSha256');
  });

  it('rejects a forged verifier claim even when it exits successfully', async () => {
    const { files } = await fixture();
    await writeFile(
      files.verifier,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({verified:true,system:'magnetar',programSha256:'${'0'.repeat(64)}',inputSha256:'${'0'.repeat(64)}',outputSha256:'${'0'.repeat(64)}',proofSha256:'${'0'.repeat(64)}'}));\n`,
    );
    await expect(verifyExternalProof(files)).rejects.toThrow('programSha256');
  });

  it('rejects a receipt pointing outside its directory', async () => {
    const { files, receipt } = await fixture();
    await writeFile(
      files.receipt,
      JSON.stringify({ ...receipt, proofFile: '../outside.bin' }),
    );
    await expect(verifyExternalProof(files)).rejects.toThrow();
  });

  it('rejects a boolean false verdict, a relative executable, and an invalid receipt', async () => {
    const { files } = await fixture();
    await writeFile(
      files.verifier,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({verified:false}));\n`,
    );
    await expect(verifyExternalProof(files)).rejects.toThrow();
    await expect(
      verifyExternalProof({ ...files, verifier: './verifier' }),
    ).rejects.toThrow('absolute');
    await writeFile(files.receipt, '{}');
    await expect(verifyExternalProof(files)).rejects.toThrow();
  });
});
