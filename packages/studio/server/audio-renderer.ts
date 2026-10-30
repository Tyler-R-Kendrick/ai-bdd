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

export type AudioExportFormat = 'wav' | 'flac' | 'mp3' | 'm4a' | 'ogg';
export type AudioRenderAsset = { bytes: Uint8Array; mime: string };
export type AudioRenderOptions = {
  content: import('../shared/audio.ts').AudioContent;
  assets: Map<string, AudioRenderAsset>;
  format: AudioExportFormat;
  signal: AbortSignal;
  onProgress?: (percent: number) => void | Promise<void>;
};
export interface AudioRenderDriver {
  readonly name: string;
  readonly runtime: 'long-lived-worker' | 'remote-worker';
  render(options: AudioRenderOptions): Promise<Buffer>;
}
export const audioMime: Record<AudioExportFormat, string> = {
  wav: 'audio/wav',
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
};
export const cpuAudioRenderDriver: AudioRenderDriver = {
  name: 'ffmpeg-audio',
  runtime: 'long-lived-worker',
  render: renderAudio,
};
const num = (value: number) => Number(value.toFixed(9)).toString();
function stereoPan(pan: number, mono = false) {
  if (mono) {
    const angle = ((pan + 1) * Math.PI) / 4;
    return `pan=stereo|c0=${num(Math.cos(angle))}*c0|c1=${num(Math.sin(angle))}*c0`;
  }
  if (pan <= 0) {
    const angle = ((pan + 1) * Math.PI) / 2;
    return `pan=stereo|c0=c0+${num(Math.cos(angle))}*c1|c1=${num(Math.sin(angle))}*c1`;
  }
  const angle = (pan * Math.PI) / 2;
  return `pan=stereo|c0=${num(Math.cos(angle))}*c0|c1=c1+${num(Math.sin(angle))}*c0`;
}
/** Bounded FFmpeg mixdown. URLs and caller-authored filter expressions are never accepted. */
export async function renderAudio(
  options: AudioRenderOptions,
): Promise<Buffer> {
  const { audioContentSchema, audibleAudioTracks } = await import(
    '../shared/audio.ts'
  );
  const content = audioContentSchema.parse(options.content),
    tracks = audibleAudioTracks(content),
    directory = await mkdtemp(join(tmpdir(), 'studio-audio-render-'));
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(120000)]);
  try {
    signal.throwIfAborted();
    const paths = new Map<string, string>(),
      probes = new Map<string, AudioProbe>();
    let encoded = 0,
      decoded = 0,
      reverseBytes = 0;
    for (const track of content.tracks)
      for (const clip of track.clips)
        if (!paths.has(clip.src)) {
          const asset = options.assets.get(clip.src);
          if (
            !asset ||
            !asset.mime.startsWith('audio/') ||
            asset.mime === 'audio/midi' ||
            asset.bytes.byteLength > MAX_AUDIO_SOURCE_BYTES
          )
            throw new HttpError(
              400,
              'An audio clip source is missing, too large or has the wrong media type.',
            );
          encoded += asset.bytes.byteLength;
          if (encoded > 64 * 1024 * 1024 || paths.size >= 32)
            throw new HttpError(
              413,
              'An audio project supports at most 32 sources and 64 MiB of encoded audio.',
            );
          const path = join(directory, `source-${paths.size}.media`);
          await writeFile(path, asset.bytes, { mode: 0o600 });
          const probe = await probeAudioFile(path, { signal });
          decoded += probe.decodedBytes;
          if (decoded > MAX_AUDIO_DECODED_BYTES)
            throw new HttpError(
              413,
              'Combined audio sources exceed the 64 MiB decoded playback budget.',
            );
          paths.set(clip.src, path);
          probes.set(clip.src, probe);
        }
    for (const track of content.tracks)
      for (const clip of track.clips) {
        const probe = probes.get(clip.src)!;
        if (
          clip.offset + clip.duration >
          probe.duration +
            1 / Math.min(probe.sampleRate, content.sampleRate) +
            0.001
        )
          throw new HttpError(
            400,
            'An audio trim extends beyond its actual decoded source.',
          );
        if (clip.reverse)
          reverseBytes += Math.ceil(clip.duration * content.sampleRate) * 2 * 4;
      }
    if (reverseBytes > MAX_AUDIO_DECODED_BYTES)
      throw new HttpError(
        413,
        'Reversed clips exceed the 64 MiB offline buffer budget.',
      );
    const args = [
        '-v',
        'error',
        '-nostdin',
        '-y',
        '-threads',
        '1',
        '-filter_complex_threads',
        '1',
      ],
      filters: string[] = [],
      trackLabels: string[] = [];
    let input = 0;
    for (const track of tracks) {
      const mono = track.clips.every(
        (clip) => probes.get(clip.src)!.channels === 1,
      );
      const clipLabels: string[] = [];
      for (const clip of track.clips) {
        args.push(
          '-protocol_whitelist',
          'file,pipe',
          '-format_whitelist',
          formats,
          '-i',
          paths.get(clip.src)!,
        );
        const chain = [
          `atrim=start=${num(clip.offset)}:duration=${num(clip.duration)}`,
          'asetpts=PTS-STARTPTS',
          `aformat=sample_fmts=fltp:sample_rates=${content.sampleRate}:channel_layouts=${mono ? 'mono' : 'stereo'}`,
        ];
        if (clip.reverse) chain.push('areverse');
        chain.push(`volume=${num(clip.gainDb)}dB`);
        if (clip.fadeIn > 0)
          chain.push(`afade=t=in:st=0:d=${num(clip.fadeIn)}`);
        if (clip.fadeOut > 0)
          chain.push(
            `afade=t=out:st=${num(clip.duration - clip.fadeOut)}:d=${num(clip.fadeOut)}`,
          );
        chain.push(
          `adelay=delays=${Math.round(clip.start * content.sampleRate)}S:all=1`,
          'asetpts=N/SR/TB',
        );
        const label = `clip${input}`;
        filters.push(`[${input}:a:0]${chain.join(',')}[${label}]`);
        clipLabels.push(`[${label}]`);
        input++;
      }
      if (!clipLabels.length) continue;
      const index = trackLabels.length,
        chain = [
          ...(clipLabels.length > 1
            ? [
                `amix=inputs=${clipLabels.length}:duration=longest:dropout_transition=0:normalize=0`,
              ]
            : ['anull']),
          `highpass=f=${num(track.effects.highpassHz)}`,
          `lowpass=f=${num(track.effects.lowpassHz)}`,
        ];
      if (track.effects.compressor)
        chain.push(
          'acompressor=threshold=0.125:ratio=4:attack=5:release=100:makeup=1',
        );
      chain.push(`volume=${num(track.gainDb)}dB`, stereoPan(track.pan, mono));
      filters.push(`${clipLabels.join('')}${chain.join(',')}[track${index}]`);
      trackLabels.push(`[track${index}]`);
    }
    const master = [
      ...(trackLabels.length > 1
        ? [
            `amix=inputs=${trackLabels.length}:duration=longest:dropout_transition=0:normalize=0`,
          ]
        : ['anull']),
      `volume=${num(content.masterGainDb)}dB`,
      `apad=whole_dur=${num(content.duration)}`,
      `atrim=duration=${num(content.duration)}`,
    ];
    if (!input) {
      args.push(
        '-f',
        'lavfi',
        '-i',
        `anullsrc=r=${content.sampleRate}:cl=stereo`,
      );
      filters.push(`[0:a]${master.join(',')}[mix]`);
    } else filters.push(`${trackLabels.join('')}${master.join(',')}[mix]`);
    const output = join(directory, 'mix.' + options.format),
      codec: Record<AudioExportFormat, string[]> = {
        wav: ['-c:a', 'pcm_s16le'],
        flac: ['-c:a', 'flac'],
        mp3: ['-c:a', 'libmp3lame', '-q:a', '2'],
        m4a: ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
        ogg: ['-c:a', 'libvorbis', '-q:a', '5'],
      };
    args.push(
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[mix]',
      '-ar',
      String(content.sampleRate),
      '-ac',
      '2',
      ...codec[options.format],
      '-t',
      num(content.duration),
      '-fs',
      String(100 * 1024 * 1024),
      '-progress',
      'pipe:1',
      '-nostats',
      output,
    );
    await options.onProgress?.(0);
    await new Promise<void>((resolve, reject) => {
      let errorText = '',
        pending = Promise.resolve(),
        settled = false;
      const child = spawn(process.env.STUDIO_FFMPEG_PATH ?? 'ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
        killSignal: 'SIGKILL',
      });
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve();
      };
      child.stderr.on('data', (bytes: Buffer) => {
        errorText = (errorText + bytes.toString()).slice(-2000);
      });
      let partial = '';
      child.stdout.on('data', (bytes: Buffer) => {
        partial = (partial + bytes.toString()).slice(-4096);
        const lines = partial.split('\n');
        partial = lines.pop()!;
        for (const line of lines) {
          const match = /^out_time_us=(\d+)$/.exec(line);
          if (match) {
            const fraction = Math.min(
              0.99,
              Number(match[1]) / 1000000 / content.duration,
            );
            pending = pending
              .then(() => options.onProgress?.(fraction))
              .then(() => {});
            pending.catch((error) => {
              child.kill('SIGKILL');
              finish(error);
            });
          }
        }
      });
      child.on('error', finish);
      child.on('close', (code) => {
        void pending.then(() => {
          if (signal.aborted) finish(signal.reason);
          else if (code !== 0)
            finish(
              new Error('Audio encoding failed: ' + errorText.slice(-1000)),
            );
          else finish();
        }, finish);
      });
    });
    const bytes = await (await import('node:fs/promises')).readFile(output);
    if (bytes.length < 44 || bytes.length >= 100 * 1024 * 1024)
      throw new HttpError(
        413,
        'The rendered audio is empty or exceeds 100 MiB.',
      );
    const verify = await execute(
      process.env.STUDIO_FFPROBE_PATH ?? 'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_type,sample_rate,channels',
        '-of',
        'json',
        output,
      ],
      { signal, timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 65536 },
    );
    const metadata = JSON.parse(verify.stdout);
    if (
      Math.abs(Number(metadata.format?.duration) - content.duration) > 0.15 ||
      metadata.streams?.length !== 1 ||
      metadata.streams[0]?.codec_type !== 'audio' ||
      Number(metadata.streams[0].sample_rate) !== content.sampleRate ||
      metadata.streams[0].channels !== 2
    )
      throw new Error(
        'The encoder did not produce the requested complete stereo mix.',
      );
    await options.onProgress?.(1);
    return bytes;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
