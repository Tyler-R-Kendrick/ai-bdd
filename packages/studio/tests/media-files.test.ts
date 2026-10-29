import { describe, expect, it } from 'vitest';
import { uploadedMediaType } from '../server/media-files.ts';

function glb(json: unknown) {
  const data = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4, 32);
  data.copy(padded);
  const header = Buffer.alloc(20);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, padded]);
}
describe('Uploaded project media boundary', () => {
  it('rejects executable content even when a client claims an allowed MIME', () => {
    expect(() =>
      uploadedMediaType(
        Buffer.from('<svg onload="alert(1)"></svg>'),
        'logo.png',
        'image/png',
      ),
    ).toThrow('Choose a');
    expect(() =>
      uploadedMediaType(
        Buffer.from('<script>alert(1)</script>'),
        'movie.mp4',
        'video/mp4',
      ),
    ).toThrow('Choose a');
  });
  it('accepts self-contained GLB metadata but prevents remote asset loading and truncated chunks', () => {
    expect(
      uploadedMediaType(
        glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 0 }] }),
        'scene.glb',
      ),
    ).toBe('model/gltf-binary');
    for (const uri of [
      'https://example.test/private',
      'file:///etc/passwd',
      'data:application/octet-stream;base64,AA==',
    ])
      expect(() =>
        uploadedMediaType(glb({ buffers: [{ uri }] }), 'scene.glb'),
      ).toThrow('must embed');
    expect(() =>
      uploadedMediaType(glb({}).subarray(0, 20), 'scene.glb'),
    ).toThrow('complete');
  });
  it('requires an internally consistent binary STL length and STEP boundaries', () => {
    const stl = Buffer.alloc(134);
    stl.writeUInt32LE(1, 80);
    expect(uploadedMediaType(stl, 'part.stl')).toBe('model/stl');
    stl.writeUInt32LE(200001, 80);
    expect(() => uploadedMediaType(stl, 'part.stl')).toThrow('Choose a');
    expect(
      uploadedMediaType(
        Buffer.from(
          'ISO-10303-21;\nHEADER;ENDSEC;DATA;ENDSEC;END-ISO-10303-21;',
        ),
        'part.step',
      ),
    ).toBe('model/step');
    expect(() =>
      uploadedMediaType(Buffer.from('ISO-10303-21;'), 'part.step'),
    ).toThrow('Choose a');
  });
});
