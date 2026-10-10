import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unifiedDiff } from './diff.ts';
import { applyScrubbers, defaultScrubbers, normalizeText } from './scrub.ts';
import type { Scrubber } from './scrub.ts';
import { serialize } from './serialize.ts';

export interface VerifyOptions {
  /** Distinguishes several snapshots in one test. */
  name?: string;
  /** File extension of the snapshot. Strings default to `txt`, bytes to `bin`, other values to `json`. */
  extension?: string;
  /** Applied after the default scrubbers (guids, instants, absolute paths). */
  scrubbers?: Scrubber[];
  /** `false` to skip the default scrubbers. */
  scrubDefaults?: boolean;
  /** Where the snapshot files live. Default: `__verified__` next to the test file. */
  directory?: string;
  /** Use `<directory>/<fileName>.verified.<ext>` instead of the name derived from the test (to keep a fixture layout). */
  fileName?: string;
}

export interface VerifyContext {
  testPath: string;
  testName: string;
  env?: Record<string, string | undefined>;
  /** Replaced by `{root}` in snapshots. Default: the current directory. */
  root?: string;
}

export class VerifyError extends Error {
  readonly received: string;
  readonly verified: string;
  constructor(message: string, files: { received: string; verified: string }) {
    super(message);
    this.name = 'VerifyError';
    this.received = files.received;
    this.verified = files.verified;
  }
}

export function isCI(env: Record<string, string | undefined>): boolean {
  const v = env['CI'];
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

/** `verify` approves a snapshot only when asked to, and never in CI. */
export function acceptRequested(env: Record<string, string | undefined>): boolean {
  return env['VERIFY_ACCEPT'] === '1';
}

export function slug(text: string, max = 80): string {
  // Stryker disable next-line Regex: equivalent mutants, runs of non-alphanumerics were collapsed to a single hyphen first, so at most one hyphen is ever at either end
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
  return s.length > 0 ? s : 'snapshot';
}

export function snapshotFiles(ctx: VerifyContext, opts: VerifyOptions, extension: string): { verified: string; received: string } {
  const dir = opts.directory ?? path.join(path.dirname(ctx.testPath), '__verified__');
  const base = path.basename(ctx.testPath).replace(/\.[cm]?[jt]sx?$/, '');
  const stem = opts.fileName ?? [base, slug(ctx.testName), ...(opts.name === undefined ? [] : [slug(opts.name)])].join('.');
  return { verified: path.join(dir, `${stem}.verified.${extension}`), received: path.join(dir, `${stem}.received.${extension}`) };
}

/** Two tests whose names slug to the same file would silently share a snapshot. */
const claimed = new Map<string, string>();
function claim(file: string, owner: string): void {
  const prev = claimed.get(file);
  if (prev !== undefined && prev !== owner) {
    throw new Error(`verify: "${owner}" and "${prev}" map to the same snapshot file ${file}; give one of them a distinct \`name\``);
  }
  claimed.set(file, owner);
}

// Stryker disable next-line ConditionalExpression: equivalent mutant, Buffer.compare is non-zero for different lengths, so the length check is only a shortcut
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && Buffer.compare(a, b) === 0;

function write(file: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

/**
 * Compare `value` with the committed `.verified.` file.
 *  - equal: any stale `.received.` file is removed and the call returns;
 *  - different or missing: a `.received.` file is written next to it and a `VerifyError` explains the difference.
 * `VERIFY_ACCEPT=1` (outside CI) approves the received output instead of failing.
 */
export function verifyValue(ctx: VerifyContext, value: unknown, opts: VerifyOptions = {}): void {
  const env = ctx.env ?? process.env;
  const s = serialize(value, opts.extension);
  const files = snapshotFiles(ctx, opts, s.extension);
  claim(files.verified, `${ctx.testPath}::${ctx.testName}::${opts.name ?? ''}`);

  const accept = acceptRequested(env);
  if (accept && isCI(env)) throw new Error('verify: VERIFY_ACCEPT is ignored in CI (CI is set); approve snapshots locally and commit them');

  let received: string | Uint8Array;
  if (s.bytes !== undefined) {
    received = s.bytes;
  } else {
    const dirs = { root: ctx.root ?? process.cwd(), tmp: os.tmpdir() };
    const scrubbers = [...(opts.scrubDefaults === false ? [] : defaultScrubbers(dirs)), ...(opts.scrubbers ?? [])];
    // Snapshots are UTF-8 files, in which a lone surrogate can only be stored as U+FFFD: compare what the file will hold,
    // or such a value could never match its own snapshot.
    received = Buffer.from(normalizeText(applyScrubbers(s.text as string, scrubbers)), 'utf8').toString('utf8');
  }

  const hasVerified = fs.existsSync(files.verified);
  let matches = false;
  if (hasVerified) {
    const current = fs.readFileSync(files.verified);
    matches = typeof received === 'string' ? normalizeText(current.toString('utf8')) === received : sameBytes(new Uint8Array(current), received);
  }
  if (matches) {
    fs.rmSync(files.received, { force: true });
    return;
  }
  if (accept) {
    write(files.verified, received);
    fs.rmSync(files.received, { force: true });
    return;
  }
  write(files.received, received);
  const rel = (f: string): string => path.relative(process.cwd(), f);
  if (!hasVerified) {
    throw new VerifyError(`No verified snapshot yet: ${rel(files.verified)}\nReceived output written to ${rel(files.received)}.\nReview it, then approve with "pnpm verify:accept" (or VERIFY_ACCEPT=1 when running the test locally).`, files);
  }
  const detail = typeof received === 'string'
    ? unifiedDiff(normalizeText(fs.readFileSync(files.verified, 'utf8')), received)
    : `binary snapshot differs (${(fs.statSync(files.verified).size)} -> ${received.length} bytes)`;
  throw new VerifyError(`Snapshot mismatch: ${rel(files.verified)}\n${detail}\nReceived output written to ${rel(files.received)}.\nIf the change is intended, approve it with "pnpm verify:accept".`, files);
}
