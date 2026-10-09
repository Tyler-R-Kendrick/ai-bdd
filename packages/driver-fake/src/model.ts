import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { sha256Hex } from '@ai-bdd/contracts';

export interface FakeTransition {
  dialog?: string | null;
  action?: 'upgrade' | 'downgrade' | 'signIn' | 'confirmUpgrade' | 'cancelUpgrade';
  toast?: string | null;
  route?: string;
}

export interface FakeNode {
  role: string;
  name: string;
  testId?: string;
  transition?: FakeTransition;
  visibleWhen?: string;
  secret?: boolean;
  ancestors?: Array<{ role: string; name?: string }>;
}

export interface FakeScreen {
  route: string;
  title: string;
  nodes: FakeNode[];
  dialogs?: Record<string, FakeNode[]>;
  spinnerMs?: number;
}

export interface FakeState {
  workspace: string | null;
  plan: string;
  unpaid: number;
  dialog: string | null;
  signedIn: boolean;
  user: string;
  toast: string | null;
  loading: boolean;
  pendingMs?: number;
  now?: string | null;
}

export interface FakeModel {
  version: number;
  generatedFrom: string;
  initial: FakeState;
  screens: FakeScreen[];
}

export function loadFakeModel(path: string): FakeModel {
  return JSON.parse(readFileSync(path, 'utf8')) as FakeModel;
}

/**
 * Deterministic PNG encoder (8-bit grayscale). Text is drawn as hashed pixel
 * blocks so the bytes are stable across runs but not readable, which keeps the
 * fixture honest without shipping a bitmap stack.
 */
export function renderPng(width: number, height: number, seed: string): Uint8Array {
  const digest = sha256Hex(seed);
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0; // filter type: none
    for (let x = 0; x < width; x += 1) {
      const index = (x * 7 + y * 13) % digest.length;
      const shade = Math.abs((parseInt(digest.slice(index, index + 2), 16) ^ (x * y)) % 256);
      raw[y * (width + 1) + 1 + x] = shade;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const chunks = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return new Uint8Array(chunks);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
