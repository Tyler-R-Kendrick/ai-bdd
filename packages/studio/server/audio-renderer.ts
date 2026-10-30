import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpError } from './store.ts';
const execute = promisify(execFile);
export const MAX_AUDIO_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_DECODED_BYTES = 64 * 1024 * 1024;
export type AudioProbe = {
  duration: number;
  sampleRate: number;
  channels: 1 | 2;
  decodedBytes: number;
  codec: string;
  format: string;
};
const formats = 'wav,flac,mp3,ogg,mov,matroska,aiff';
export async function probeAudioFile(
  file: string,
  options: { signal?: AbortSignal } = {},
): Promise<AudioProbe> {
  options.signal?.throwIfAborted();
  let source: unknown;
  try {
    const output = await execute(
      process.env.STUDIO_FFPROBE_PATH ?? 'ffprobe',
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-format_whitelist',
        formats,
        '-show_format',
        '-show_streams',
        '-of',
        'json',
        file,
      ],
      {
        signal: options.signal,
        timeout: 15000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
      },
    );
    source = JSON.parse(output.stdout);
  } catch {
    options.signal?.throwIfAborted();
    throw new HttpError(
      400,
      'This audio source could not be probed safely. Choose a complete WAV, FLAC, MP3, M4A, Ogg or WebM audio file.',
    );
  }
  const value = source as {
      streams?: Record<string, any>[];
      format?: Record<string, any>;
    },
    streams = value.streams ?? [],
    audio = streams.filter((stream) => stream.codec_type === 'audio');
  if (
    audio.length !== 1 ||
    streams.some(
      (stream) =>
        stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
    )
  )
    throw new HttpError(400, 'Choose one audio stream without a video track.');
  const stream = audio[0],
    duration = Number(stream.duration ?? value.format?.duration),
    sampleRate = Number(stream.sample_rate),
    channels = Number(stream.channels),
    decodedBytes = Math.ceil(duration * sampleRate) * channels * 4;
  if (
    !Number.isFinite(duration) ||
    duration < 0.01 ||
    duration > 300 ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 192000 ||
    ![1, 2].includes(channels) ||
    !Number.isSafeInteger(decodedBytes) ||
    decodedBytes > MAX_AUDIO_DECODED_BYTES
  )
    throw new HttpError(
      413,
      'Audio sources are limited to 300 seconds, mono or stereo, 8–192 kHz, and 64 MiB of decoded PCM. Trim or downsample this source before importing.',
    );
  return {
    duration,
    sampleRate,
    channels: channels as 1 | 2,
    decodedBytes,
    codec: String(stream.codec_name ?? 'unknown').slice(0, 80),
    format: String(value.format?.format_name ?? 'unknown').slice(0, 80),
  };
}
/** Shared multipart/Blob admission and editor pre-decode gate. All inputs are owned local bytes, never URLs. */
export async function probeAudio(
  bytes: Uint8Array,
  options: { signal?: AbortSignal } = {},
): Promise<AudioProbe> {
  if (bytes.byteLength < 16 || bytes.byteLength > MAX_AUDIO_SOURCE_BYTES)
    throw new HttpError(
      413,
      'An audio source must be a complete file of at most 10 MiB.',
    );
  const directory = await mkdtemp(join(tmpdir(), 'studio-audio-probe-'));
  try {
    const file = join(directory, 'source.bin');
    await writeFile(file, bytes, { mode: 0o600 });
    return await probeAudioFile(file, options);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
