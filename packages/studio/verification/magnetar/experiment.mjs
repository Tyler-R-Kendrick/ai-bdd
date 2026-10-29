import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { STUDIO_LAYOUT, studioLayout } from '../layout.ts';
import {
  execute,
  sha256,
  publicInstance,
  verifyBundle,
} from './statement.mjs';

const source = resolve(
  process.env.STUDIO_OPEN_MAGNETAR_SOURCE ?? 'work/open-magnetar',
);
const out = resolve(
  process.env.STUDIO_MAGNETAR_REPORT_DIR ?? 'work/review/magnetar',
);
await mkdir(out, { recursive: true });
const upstream = JSON.parse(
  await readFile(new URL('./upstream.json', import.meta.url)),
);
const model = STUDIO_LAYOUT;
const c = `#include "../rt/om.h"\nint main(void) {\n if(om_input_len()!=16) return 1;\n uint64_t w=om_read_u64(0),o=om_read_u64(8);\n if(w<${model.minViewport * 64} || w>${model.maxViewport * 64} || o>1) return 2;\n uint64_t s=w>=${model.sidebarBreakpoint * 64}?${model.sidebarWidth * 64}:0;\n uint64_t d=(w>=${model.detailBreakpoint * 64} && o)?${model.detailWidth * 64}:0;\n om_write_u64(s);om_write_u64(d);om_write_u64(w-s-d);return 0;\n}\n`;
const guest = join(source, 'guest/examples/studio-layout.c');
await writeFile(guest, c);
if (process.argv.includes('--prepare-only')) {
  process.stdout.write(
    'Prepared RV64I guest from the shared layout constants\n',
  );
  process.exit(0);
}
const cli = resolve(
  process.env.STUDIO_OPEN_MAGNETAR_CLI ?? join(source, 'target/release/om'),
);
const elf = join(source, 'guest/examples/studio-layout.elf');
const cliHash = sha256(await readFile(cli));
const key = join(out, 'layout.vk');
await execute(
  cli,
  [
    'keygen',
    '--elf',
    elf,
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
const cases = [];
const words = (values) => {
  const bytes = Buffer.alloc(values.length * 8);
  values.forEach((value, index) =>
    bytes.writeBigUInt64LE(BigInt(value), index * 8),
  );
  return bytes;
};
for (const width of [
  model.minViewport,
  model.sidebarBreakpoint,
  model.detailBreakpoint,
  model.maxViewport,
])
  for (const detail of [false, true]) {
    const name = `${width}-${Number(detail)}`,
      input = join(out, name + '.input'),
      instance = join(out, name + '.instance'),
      proof = join(out, name + '.proof');
    const inputBytes = words([width * 64, Number(detail)]);
    await writeFile(input, inputBytes);
    await execute(
      cli,
      [
        'prove',
        '--vk',
        key,
        '--elf',
        elf,
        '--input',
        input,
        '--instance',
        instance,
        '--out',
        proof,
        '--max-cycles',
        '4096',
      ],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    const bytes = await readFile(instance),
      decoded = publicInstance(bytes),
      expected = studioLayout(width, detail);
    assert(decoded.input.equals(inputBytes));
    assert(
      decoded.output.equals(
        words([
          expected.sidebarWidth * 64,
          expected.detailWidth * 64,
          expected.canvasWidth * 64,
        ]),
      ),
    );
    assert.equal(decoded.exitCode, 0n);
    const verified = await execute(
      cli,
      ['verify', '--vk', key, '--instance', instance, '--proof', proof],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(verified.stdout.trim(), 'OK');
    // Actual cryptographic rejection, not a digest-only precheck.
    const damaged = Buffer.from(await readFile(proof));
    damaged[Math.floor(damaged.length / 2)] ^= 1;
    const invalid = join(out, name + '.tampered-proof');
    await writeFile(invalid, damaged);
    const rejected = await execute(
      cli,
      ['verify', '--vk', key, '--instance', instance, '--proof', invalid],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    ).then(
      () => false,
      () => true,
    );
    assert(rejected, 'Tampered proof was accepted');
    for (const [field, offset] of [
      ['input', 21],
      ['output', 45],
    ]) {
      const changed = Buffer.from(bytes);
      changed[offset] ^= 1;
      const changedPath = join(out, name + '.tampered-' + field);
      await writeFile(changedPath, changed);
      const rejectedStatement = await execute(
        cli,
        ['verify', '--vk', key, '--instance', changedPath, '--proof', proof],
        { timeout: 120000, maxBuffer: 1024 * 1024 },
      ).then(
        () => false,
        () => true,
      );
      assert(rejectedStatement, 'Tampered public ' + field + ' was accepted');
    }
    cases.push({
      width,
      detail,
      cycles: String(decoded.cycles),
      proofBytes: damaged.length,
      verified: true,
      tamperedProofRejected: true,
      tamperedInputRejected: true,
      tamperedOutputRejected: true,
    });
  }
const chosen = '1280-1',
  proofPath = join(out, 'execution-proof.json'),
  outputPath = join(out, 'execution.output');
const chosenInstance = await readFile(join(out, chosen + '.instance'));
await writeFile(outputPath, publicInstance(chosenInstance).output);
await writeFile(
  proofPath,
  JSON.stringify({
    schemaVersion: 1,
    implementation: 'Lulzx/open-magnetar',
    commit: upstream.commit,
    profile: 'provable-120',
    pcs: 'ligerito',
    hash: 'sha384',
    instance: chosenInstance.toString('base64'),
    proof: (await readFile(join(out, chosen + '.proof'))).toString('base64'),
  }),
);
const verdict = await verifyBundle(
  {
    program: elf,
    input: join(out, chosen + '.input'),
    output: outputPath,
    proof: proofPath,
  },
  {
    ...process.env,
    STUDIO_OPEN_MAGNETAR_CLI: cli,
    STUDIO_OPEN_MAGNETAR_BINARY_SHA256: cliHash,
  },
);
await writeFile(
  join(out, 'receipt.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      system: 'magnetar',
      programSha256: verdict.programSha256,
      inputSha256: verdict.inputSha256,
      outputSha256: verdict.outputSha256,
      proofSha256: verdict.proofSha256,
      proofFile: 'execution-proof.json',
    },
    null,
    2,
  ),
);
const report = {
  schemaVersion: 1,
  implementation: upstream,
  binarySha256: cliHash,
  guestSourceSha256: sha256(Buffer.from(c)),
  modelSha256: sha256(Buffer.from(JSON.stringify(model))),
  cases,
  adapterVerified: true,
  scope:
    'Experimental independent implementation of the Magnetar paper, unaudited and not affiliated with Microsoft. Public layout guest executions only; no confidential witness, browser rendering, or whole-application proof. This research result is not a production security certification.',
};
await writeFile(
  join(out, 'report.json'),
  JSON.stringify(report, null, 2) + '\n',
);
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
