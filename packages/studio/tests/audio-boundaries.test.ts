import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, hash } from '../server/store.ts';
import { initialAudioContent } from '../shared/audio.ts';
import { initialMidiContent } from '../shared/midi.ts';
import { uploadedMediaType } from '../server/media-files.ts';
import { createApp } from '../server/app.ts';
import { client, setup, testSettings } from './helpers.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function smf() {
  return Buffer.from(
    '4d546864000000060000000101e04d54726b0000000400ff2f00',
    'hex',
  );
}
describe('audio and MIDI admission boundaries', () => {
  it('admits complete bounded SMF chunks and rejects truncated tracks, excessive track counts and false MIME labels', () => {
    expect(uploadedMediaType(smf(), 'source.mid')).toBe('audio/midi');
    for (const bytes of [smf().subarray(0, 20), Buffer.from('MThd<script/>')])
      expect(() =>
        uploadedMediaType(bytes, 'source.mid', 'audio/midi'),
      ).toThrow();
    const tracks = smf();
    tracks.writeUInt16BE(33, 10);
    expect(() => uploadedMediaType(tracks, 'source.mid')).toThrow('at most');
    const m4a = Buffer.from('00000014667479704d344120000000004d344120', 'hex');
    expect(uploadedMediaType(m4a, 'source.m4a')).toBe('audio/mp4');
  });
  it('requires exact project-owned recording and original MIDI assets independently', async () => {
    const store = await Store.open(':memory:');
    cleanup.push(() => store.close());
    const user = await store.createUser(
        'audio-owner@example.test',
        'Audio owner',
        null,
      ),
      a = (await store.createProject(user, 'Audio', ''))!,
      b = (await store.createProject(user, 'Other', ''))!,
      bytes = Buffer.from('explicit-asset-type-fixture');
    const audio = await store.registerFile(user, a.mainArtifactId, {
        name: 'recording.wav',
        mime: 'audio/wav',
        bytes,
        byteSize: bytes.length,
        sha256: hash(bytes),
      }),
      midi = await store.registerFile(user, a.mainArtifactId, {
        name: 'source.mid',
        mime: 'audio/midi',
        bytes: smf(),
        byteSize: smf().length,
        sha256: hash(smf()),
      });
    const source = initialAudioContent();
    source.tracks = [
      {
        id: 'track',
        title: 'Track',
        gainDb: 0,
        pan: 0,
        mute: false,
        solo: false,
        effects: { highpassHz: 20, lowpassHz: 20000, compressor: false },
        clips: [
          {
            id: 'clip',
            title: 'Clip',
            src: '/api/files/' + audio.id,
            start: 0,
            offset: 0,
            duration: 1,
            gainDb: 0,
            fadeIn: 0,
            fadeOut: 0,
            reverse: false,
          },
        ],
      },
    ];
    expect(
      (await store.createArtifact(user, a.id, 'audio', 'Recording', source))
        .kind,
    ).toBe('audio');
    await expect(
      store.createArtifact(user, b.id, 'audio', 'Foreign recording', source),
    ).rejects.toMatchObject({ statusCode: 400 });
    source.tracks[0]!.clips[0]!.src = '/api/files/' + midi.id;
    await expect(
      store.createArtifact(
        user,
        a.id,
        'audio',
        'MIDI is not recorded audio',
        source,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    const notes = {
      ...initialMidiContent(),
      sourceSrc: '/api/files/' + midi.id,
    };
    expect(
      (await store.createArtifact(user, a.id, 'midi', 'MIDI notes', notes))
        .kind,
    ).toBe('midi');
    await expect(
      store.createArtifact(user, b.id, 'midi', 'Foreign MIDI', notes),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  it('rejects a small compressed decoding bomb through the actual multipart endpoint before publishing a file', async () => {
    const directory = await mkdtemp('/workspace/ai-bdd/work/audio-admission-');
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'bomb.flac');
    await promisify(execFile)(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=60:sample_rate=192000',
        '-ac',
        '2',
        '-c:a',
        'flac',
        path,
      ],
      { timeout: 20000 },
    );
    const bytes = await readFile(path);
    expect(bytes.length).toBeLessThan(10 * 1024 * 1024);
    const studio = await createApp(testSettings(directory), { db: ':memory:' });
    cleanup.push(() => studio.app.close());
    const { user, cookie } = await setup(studio.app),
      project = (await studio.store.createProject(user, 'Admission', ''))!;
    const boundary = 'audio-boundary-fixture',
      payload = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.flac"\r\nContent-Type: audio/flac\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
    const response = await studio.app.inject({
      method: 'POST',
      url: `/api/artifacts/${project.mainArtifactId}/files`,
      headers: {
        cookie: 'studio_session=' + cookie,
        origin: 'http://127.0.0.1:8787',
        'content-type': 'multipart/form-data; boundary=' + boundary,
      },
      payload,
    });
    expect(response.statusCode, response.body).toBe(413);
    expect(await studio.store.all('SELECT id FROM files')).toHaveLength(0);
  });
});
