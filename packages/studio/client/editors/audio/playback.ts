import { api } from '../../lib.ts';
import {
  audibleAudioTracks,
  audioGain,
  type AudioContent,
} from '../../../shared/audio.ts';
export type SourceProbe = {
  duration: number;
  sampleRate: number;
  channels: number;
  decodedBytes: number;
  sha256: string;
  byteSize: number;
};
export type DecodedSource = { buffer: AudioBuffer; probe: SourceProbe };
const LIMIT = 64 * 1024 * 1024;
/** The server fully decodes the immutable owned file before the browser allocates PCM. */
export async function loadAudioSources(
  artifactId: string,
  content: AudioContent,
  context: AudioContext,
  cache: Map<string, DecodedSource>,
  signal?: AbortSignal,
) {
  const urls = [
    ...new Set(content.tracks.flatMap((t) => t.clips.map((c) => c.src))),
  ];
  if (urls.length > 32)
    throw new Error('An audio project supports at most 32 sources.');
  for (const key of cache.keys()) if (!urls.includes(key)) cache.delete(key);
  let bytes = 0;
  const probes = new Map<string, SourceProbe>();
  for (const url of urls) {
    signal?.throwIfAborted();
    const probe =
      cache.get(url)?.probe ??
      (await api<SourceProbe>(
        `/artifacts/${artifactId}/audio/sources/${url.split('/').pop()}`,
      ));
    bytes += probe.decodedBytes;
    probes.set(url, probe);
    if (bytes > LIMIT)
      throw new Error('Combined sources exceed 64 MiB of decoded audio.');
  }
  for (const url of urls) {
    if (cache.has(url)) continue;
    const probe = probes.get(url)!;
    const response = await fetch(url, { credentials: 'same-origin', signal });
    if (!response.ok)
      throw new Error('The audio source is no longer accessible.');
    const data = await response.arrayBuffer();
    if (data.byteLength !== probe.byteSize)
      throw new Error('The audio source size changed.');
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', data)),
    )
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
    if (digest !== probe.sha256)
      throw new Error('The audio source failed its integrity check.');
    signal?.throwIfAborted();
    const buffer = await context.decodeAudioData(data);
    if (
      buffer.numberOfChannels !== probe.channels ||
      Math.abs(buffer.duration - probe.duration) > 0.15
    )
      throw new Error('The browser decoded a different audio source.');
    bytes =
      [...cache.values()].reduce(
        (n, s) => n + s.buffer.length * s.buffer.numberOfChannels * 4,
        0,
      ) +
      buffer.length * buffer.numberOfChannels * 4;
    if (bytes > LIMIT)
      throw new Error('Decoded playback buffers exceed 64 MiB.');
    cache.set(url, { buffer, probe });
  }
  return cache;
}
export function scheduleAudio(
  context: AudioContext,
  content: AudioContent,
  sources: Map<string, DecodedSource>,
  from: number,
) {
  const nodes: AudioNode[] = [],
    players: AudioBufferSourceNode[] = [];
  let reverseBytes = 0;
  for (const track of audibleAudioTracks(content))
    for (const clip of track.clips) {
      const buffer = sources.get(clip.src)?.buffer;
      if (!buffer) throw new Error('An audio source has not been decoded.');
      if (clip.offset + clip.duration > buffer.duration + 0.002)
        throw new Error('The trim extends beyond the decoded source.');
      if (clip.reverse)
        reverseBytes +=
          Math.round(clip.duration * buffer.sampleRate) *
          buffer.numberOfChannels *
          4;
    }
  if (reverseBytes > LIMIT)
    throw new Error('Reversed clips exceed 64 MiB of offline audio.');
  const cleanup = () => {
    for (const player of players)
      try {
        player.stop();
      } catch {}
    for (const node of nodes) node.disconnect();
  };
  try {
    const when = context.currentTime + 0.04;
    const master = context.createGain();
    master.gain.value = audioGain(content.masterGainDb);
    master.connect(context.destination);
    nodes.push(master);
    for (const track of audibleAudioTracks(content)) {
      const mono = track.clips.every(
        (c) => sources.get(c.src)?.buffer.numberOfChannels === 1,
      );
      const input = context.createGain();
      input.channelCount = mono ? 1 : 2;
      input.channelCountMode = 'explicit';
      const high = context.createBiquadFilter();
      high.type = 'highpass';
      high.frequency.value = track.effects.highpassHz;
      high.Q.value = Math.SQRT1_2;
      const low = context.createBiquadFilter();
      low.type = 'lowpass';
      low.frequency.value = track.effects.lowpassHz;
      low.Q.value = Math.SQRT1_2;
      const gain = context.createGain();
      gain.gain.value = audioGain(track.gainDb);
      const pan = context.createStereoPanner();
      pan.pan.value = track.pan;
      input.connect(high);
      high.connect(low);
      if (track.effects.compressor) {
        const compressor = context.createDynamicsCompressor();
        compressor.threshold.value = -18.06;
        compressor.knee.value = 0;
        compressor.ratio.value = 4;
        compressor.attack.value = 0.005;
        compressor.release.value = 0.1;
        low.connect(compressor);
        compressor.connect(gain);
        nodes.push(compressor);
      } else low.connect(gain);
      gain.connect(pan);
      pan.connect(master);
      nodes.push(input, high, low, gain, pan);
      for (const clip of track.clips) {
        if (clip.start + clip.duration <= from) continue;
        let buffer = sources.get(clip.src)?.buffer;
        if (!buffer) throw new Error('An audio source has not been decoded.');
        if (clip.offset + clip.duration > buffer.duration + 0.002)
          throw new Error('The trim extends beyond the decoded source.');
        const player = context.createBufferSource(),
          envelope = context.createGain();
        const skipped = Math.max(0, from - clip.start),
          start = when + Math.max(0, clip.start - from),
          remaining = clip.duration - skipped;
        let offset = clip.offset + skipped;
        if (clip.reverse) {
          const length = Math.round(clip.duration * buffer.sampleRate);
          const reverse = context.createBuffer(
              buffer.numberOfChannels,
              length,
              buffer.sampleRate,
            ),
            first = Math.round(clip.offset * buffer.sampleRate);
          for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const src = buffer.getChannelData(ch),
              dest = reverse.getChannelData(ch);
            for (let i = 0; i < length; i++)
              dest[i] = src[first + length - 1 - i] ?? 0;
          }
          buffer = reverse;
          offset = skipped;
        }
        player.buffer = buffer;
        const level =
          audioGain(clip.gainDb) *
          (!mono && buffer.numberOfChannels === 1 ? Math.SQRT1_2 : 1);
        const factor = (at: number) =>
          Math.max(0, Math.min(1, clip.fadeIn ? at / clip.fadeIn : 1)) *
          Math.max(
            0,
            Math.min(1, clip.fadeOut ? (clip.duration - at) / clip.fadeOut : 1),
          );
        if (clip.fadeIn + clip.fadeOut > clip.duration) {
          const curve = new Float32Array(1024);
          for (let i = 0; i < curve.length; i++)
            curve[i] =
              level * factor(skipped + (remaining * i) / (curve.length - 1));
          envelope.gain.setValueCurveAtTime(curve, start, remaining);
        } else {
          envelope.gain.setValueAtTime(level * factor(skipped), start);
          for (const point of [
            clip.fadeIn,
            clip.duration - clip.fadeOut,
            clip.duration,
          ]
            .filter((v) => v > skipped)
            .sort((a, b) => a - b))
            envelope.gain.linearRampToValueAtTime(
              level * factor(point),
              start + point - skipped,
            );
        }
        player.connect(envelope);
        envelope.connect(input);
        players.push(player);
        nodes.push(player, envelope);
        player.start(start, offset, remaining);
      }
    }
    return {
      startedAt: when,
      stop: cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
export function toneWav(
  duration = 2,
  frequency = 440,
): Uint8Array<ArrayBuffer> {
  const rate = 48000,
    frames = Math.round(duration * rate),
    buffer = new ArrayBuffer(44 + frames * 2),
    view = new DataView(buffer),
    bytes = new Uint8Array(buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++)
    view.setInt16(
      44 + i * 2,
      Math.round(Math.sin((i * 2 * Math.PI * frequency) / rate) * 0.2 * 32767),
      true,
    );
  return bytes;
}
