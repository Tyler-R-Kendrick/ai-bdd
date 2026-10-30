import { execFile, spawn } from 'node:child_process';
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
async function decodedFrames(
  file: string,
  sampleRate: number,
  channels: number,
  signal?: AbortSignal,
): Promise<number> {
  const byteLimit = Math.min(
    MAX_AUDIO_DECODED_BYTES,
    Math.floor(MAX_AUDIO_DECODED_BYTES * Math.min(1, sampleRate / 48000)),
    Math.floor(300 * sampleRate * channels * 4),
  );
  const timeout = AbortSignal.timeout(15000),
    combined = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
  return new Promise<number>((resolve, reject) => {
    let bytes = 0,
      settled = false,
      overflow = false;
    const process = spawn(
      globalThis.process.env.STUDIO_FFMPEG_PATH ?? 'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-threads',
        '1',
        '-protocol_whitelist',
        'file,pipe',
        '-format_whitelist',
        formats,
        '-i',
        file,
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-ac',
        String(channels),
        '-ar',
        String(sampleRate),
        '-c:a',
        'pcm_f32le',
        '-f',
        'f32le',
        'pipe:1',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: combined,
        killSignal: 'SIGKILL',
      },
    );
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(bytes / (channels * 4));
    };
    process.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > byteLimit) {
        overflow = true;
        process.kill('SIGKILL');
      }
    });
    process.stderr.resume();
    process.on('error', (error) =>
      finish(signal?.aborted ? signal.reason : error),
    );
    process.on('close', (code) => {
      if (overflow)
        return finish(
          new HttpError(
            413,
            'The actual decoded audio exceeds the source or browser PCM budget.',
          ),
        );
      if (signal?.aborted) return finish(signal.reason);
      if (timeout.aborted)
        return finish(
          new HttpError(413, 'Audio decoding exceeded its safe time budget.'),
        );
      if (code !== 0 || !bytes || bytes % (channels * 4))
        return finish(
          new HttpError(
            400,
            'The audio source could not be decoded completely.',
          ),
        );
      finish();
    });
  });
}
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
    decodedBytes =
      Math.ceil(duration * Math.max(sampleRate, 48000)) * channels * 4;
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
  // Header durations alone are insufficient: decode the complete source through
  // a streaming byte counter before any browser is permitted to decode it.
  const frames = await decodedFrames(
      file,
      sampleRate,
      channels,
      options.signal,
    ),
    actualDuration = frames / sampleRate;
  return {
    duration: actualDuration,
    sampleRate,
    channels: channels as 1 | 2,
    decodedBytes:
      Math.ceil(actualDuration * Math.max(sampleRate, 48000)) * channels * 4,
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
