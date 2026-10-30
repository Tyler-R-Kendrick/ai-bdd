import { HttpError } from './store.ts';

/** Admit data formats, never executable SVG/HTML or a client-supplied MIME label alone. */
export function uploadedMediaType(
  bytes: Buffer,
  name: string,
  declared = '',
): string {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF') {
    const kind = bytes.toString('ascii', 8, 12);
    if (kind === 'WEBP') return 'image/webp';
    if (kind === 'WAVE') return 'audio/wav';
  }
  if (bytes.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac';
  if (bytes.toString('ascii', 0, 4) === 'MThd') {
    validateMidi(bytes);
    return 'audio/midi';
  }
  if (bytes.toString('ascii', 0, 4) === 'wOF2') return 'font/woff2';
  if (bytes.toString('ascii', 0, 4) === 'glTF') {
    validateGlb(bytes);
    return 'model/gltf-binary';
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp')
    return declared === 'audio/mp4' ||
      ['M4A ', 'M4B ', 'M4P '].includes(bytes.toString('ascii', 8, 12))
      ? 'audio/mp4'
      : 'video/mp4';
  if (
    bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
    bytes.subarray(0, 4096).includes(Buffer.from('webm'))
  )
    return declared === 'audio/webm' ? 'audio/webm' : 'video/webm';
  if (bytes.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (
    bytes.toString('ascii', 0, 3) === 'ID3' ||
    (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
  )
    return 'audio/mpeg';
  if (
    /\.(step|stp)$/i.test(name) &&
    /^\s*ISO-10303-21;/i.test(bytes.toString('ascii', 0, 256)) &&
    /END-ISO-10303-21;\s*$/i.test(
      bytes.toString('ascii', Math.max(0, bytes.length - 512)),
    )
  )
    return 'model/step';
  if (/\.stl$/i.test(name)) {
    const binary =
      bytes.length >= 84 &&
      bytes.readUInt32LE(80) <= 200000 &&
      bytes.length === 84 + bytes.readUInt32LE(80) * 50;
    const ascii =
      /^\s*solid\b/i.test(bytes.toString('ascii', 0, 256)) &&
      /\bendsolid\b/i.test(
        bytes.toString('ascii', Math.max(0, bytes.length - 512)),
      );
    if (binary || ascii) return 'model/stl';
  }
  throw new HttpError(
    400,
    'Choose a PNG, JPEG, WebP, WOFF2, GLB, STL, STEP, MP4, WebM, MP3, WAV, FLAC, M4A, Ogg, or MIDI file.',
  );
}

function validateGlb(bytes: Buffer) {
  if (
    bytes.length < 20 ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length ||
    bytes.readUInt32LE(16) !== 0x4e4f534a
  )
    throw new HttpError(400, 'Choose a complete glTF 2 binary file.');
  const length = bytes.readUInt32LE(12);
  if (length > 2000000 || length + 20 > bytes.length)
    throw new HttpError(400, 'GLB metadata exceeds its limit.');
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString('utf8', 20, 20 + length));
  } catch {
    throw new HttpError(400, 'GLB metadata is invalid.');
  }
  const visit = (value: unknown, depth = 0) => {
    if (depth > 40)
      throw new HttpError(400, 'GLB metadata nesting exceeds its limit.');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'uri' && typeof child === 'string')
        throw new HttpError(
          400,
          'GLB imports must embed all buffers and images; external and data URIs are not allowed.',
        );
      visit(child, depth + 1);
    }
  };
  visit(doc);
}

/** SMF chunks are bounded and exact; the dedicated MIDI parser validates events before importing editable notes. */
function validateMidi(bytes: Buffer) {
  if (bytes.length > 10 * 1024 * 1024)
    throw new HttpError(413, 'MIDI source files are limited to10 MB');
  if (bytes.length < 14 || bytes.readUInt32BE(4) !== 6)
    throw new HttpError(400, 'Choose a complete Standard MIDI File');
  const format = bytes.readUInt16BE(8),
    tracks = bytes.readUInt16BE(10),
    division = bytes.readUInt16BE(12);
  if (
    format > 1 ||
    tracks < 1 ||
    tracks > 32 ||
    (format === 0 && tracks !== 1) ||
    division === 0
  )
    throw new HttpError(
      400,
      'Choose a MIDI format0 or1 file with at most32 tracks',
    );
  let cursor = 14;
  for (let track = 0; track < tracks; track++) {
    if (
      cursor + 8 > bytes.length ||
      bytes.toString('ascii', cursor, cursor + 4) !== 'MTrk'
    )
      throw new HttpError(400, 'MIDI track data is truncated or invalid');
    const length = bytes.readUInt32BE(cursor + 4);
    cursor += 8;
    if (length < 4 || cursor + length > bytes.length)
      throw new HttpError(400, 'MIDI track data is truncated or invalid');
    cursor += length;
  }
  if (cursor !== bytes.length)
    throw new HttpError(400, 'MIDI chunk lengths do not match this file');
}
