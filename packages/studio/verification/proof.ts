import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    system: z.literal('magnetar'),
    programSha256: digest,
    inputSha256: digest,
    outputSha256: digest,
    proofSha256: digest,
    proofFile: z.string().min(1).max(1000),
  })
  .strict();

const verdictSchema = z
  .object({
    verified: z.literal(true),
    system: z.literal('magnetar'),
    programSha256: digest,
    inputSha256: digest,
    outputSha256: digest,
    proofSha256: digest,
  })
  .strict();

async function sha256File(file: string, limit: number): Promise<string> {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size > limit)
    throw new Error('Proof input is not a regular file within its size limit');
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

/**
 * A fail-closed boundary for an operator-supplied verifier adapter.
 * The optional research workflow builds a pinned independent implementation;
 * its executable verifier is supplied explicitly by the operator.
 * The adapter must cryptographically verify the proof, not echo this manifest.
 */
export async function verifyExternalProof(options: {
  verifier: string;
  receipt: string;
  program: string;
  input: string;
  output: string;
}) {
  if (!isAbsolute(options.verifier))
    throw new Error('The proof verifier must be an absolute executable path');
  const verifier = await realpath(options.verifier);
  if (!(await stat(verifier)).isFile())
    throw new Error('The proof verifier is not a regular file');
  const receiptPath = await realpath(options.receipt);
  if ((await stat(receiptPath)).size > 16384)
    throw new Error('The proof receipt is too large');
  const receipt = receiptSchema.parse(
    JSON.parse(await readFile(receiptPath, 'utf8')),
  );
  if (isAbsolute(receipt.proofFile))
    throw new Error('The proof file must be relative to its receipt');
  const receiptDirectory = await realpath(dirname(receiptPath));
  const proofPath = await realpath(
    resolve(receiptDirectory, receipt.proofFile),
  );
  const relation = relative(receiptDirectory, proofPath);
  if (relation.startsWith('..') || isAbsolute(relation))
    throw new Error('The proof file leaves the receipt directory');
  const program = await realpath(options.program);
  const input = await realpath(options.input);
  const output = await realpath(options.output);
  const computed = {
    programSha256: await sha256File(program, 64 * 1024 * 1024),
    inputSha256: await sha256File(input, 16 * 1024 * 1024),
    outputSha256: await sha256File(output, 16 * 1024 * 1024),
    proofSha256: await sha256File(proofPath, 64 * 1024 * 1024),
  };
  for (const key of Object.keys(computed) as (keyof typeof computed)[]) {
    if (computed[key] !== receipt[key])
      throw new Error(`Proof receipt does not match ${key}`);
  }
  const { stdout } = await execute(
    verifier,
    [
      'verify',
      '--program',
      program,
      '--input',
      input,
      '--output',
      output,
      '--proof',
      proofPath,
    ],
    { shell: false, timeout: 120000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
  );
  const verdict = verdictSchema.parse(JSON.parse(stdout));
  for (const key of Object.keys(computed) as (keyof typeof computed)[]) {
    if (computed[key] !== verdict[key])
      throw new Error(`Verifier verdict does not match ${key}`);
  }
  return { system: 'magnetar' as const, verified: true as const, ...computed };
}

export async function requireExternalProof(env: NodeJS.ProcessEnv) {
  const required = [
    'STUDIO_PROOF_VERIFIER',
    'STUDIO_PROOF_RECEIPT',
    'STUDIO_PROOF_PROGRAM',
    'STUDIO_PROOF_INPUT',
    'STUDIO_PROOF_OUTPUT',
  ] as const;
  for (const name of required)
    if (!env[name]) throw new Error(`Required proof gate is missing ${name}`);
  return verifyExternalProof({
    verifier: env.STUDIO_PROOF_VERIFIER!,
    receipt: env.STUDIO_PROOF_RECEIPT!,
    program: env.STUDIO_PROOF_PROGRAM!,
    input: env.STUDIO_PROOF_INPUT!,
    output: env.STUDIO_PROOF_OUTPUT!,
  });
}
