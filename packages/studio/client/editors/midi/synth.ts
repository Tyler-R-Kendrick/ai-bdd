import {
  beatSeconds,
  midiContentSchema,
  type MidiContent,
  type MidiTrack,
} from '../../../shared/midi.ts';
export const MAX_SYNTH_VOICES = 64,
  MAX_SYNTH_BOUNCE_SECONDS = 120;
type Control = {
  seconds: number;
  kind: 'volume' | 'expression' | 'pan' | 'bend' | 'program' | 'pedal' | 'off';
  value: number;
};
export type PerformedNote = {
  id: string;
  pitch: number;
  velocity: number;
  start: number;
  end: number;
  program: number;
  channel: number;
  gain: number;
  controls: Control[];
};
export type MidiPerformance = {
  duration: number;
  notes: PerformedNote[];
  peakVoices: number;
};
function controls(content: MidiContent, track: MidiTrack): Control[] {
  const result: Control[] = [];
  for (const event of track.events) {
    if (event.kind !== 'midi') continue;
    const [status, a, b] = event.data,
      seconds = beatSeconds(content, event.tick / content.ppq),
      kind = status & 0xf0;
    if (kind === 0xb0) {
      const name = (
        {
          7: 'volume',
          11: 'expression',
          10: 'pan',
          64: 'pedal',
          120: 'off',
          123: 'off',
        } as const
      )[a as 7];
      if (name) result.push({ seconds, kind: name, value: b });
    } else if (kind === 0xe0)
      result.push({
        seconds,
        kind: 'bend',
        value: (a + b * 128 - 8192) / 8192,
      });
    else if (kind === 0xc0) result.push({ seconds, kind: 'program', value: a });
  }
  return result.sort((a, b) => a.seconds - b.seconds);
}
export function midiPerformance(input: MidiContent): MidiPerformance {
  const content = midiContentSchema.parse(input),
    duration = beatSeconds(content, content.lengthBeats),
    solo = content.tracks.some((t) => t.solo && !t.mute),
    notes: PerformedNote[] = [];
  for (const track of content.tracks) {
    if (track.mute || (solo && !track.solo)) continue;
    const automation = controls(content, track);
    for (const note of track.notes) {
      const start = beatSeconds(content, note.start);
      let end = beatSeconds(content, note.start + note.duration);
      const off = automation.find(
        (e) => e.kind === 'off' && e.seconds >= start && e.seconds < end,
      );
      if (off) end = off.seconds;
      const pedal = automation
        .filter((e) => e.kind === 'pedal' && e.seconds <= end)
        .at(-1);
      if (pedal && pedal.value >= 64)
        end =
          automation.find(
            (e) => e.kind === 'pedal' && e.value < 64 && e.seconds > end,
          )?.seconds ?? duration;
      const program =
        automation
          .filter((e) => e.kind === 'program' && e.seconds <= start)
          .at(-1)?.value ?? track.instrument;
      notes.push({
        id: note.id,
        pitch: note.pitch,
        velocity: note.velocity,
        start,
        end: Math.max(start + 0.001, Math.min(duration, end)),
        program,
        channel: track.channel,
        gain: Math.pow(10, track.gainDb / 20),
        controls: automation,
      });
    }
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const events = notes
    .flatMap((note) => [
      { time: note.start, change: 1 },
      { time: note.end + 0.08, change: -1 },
    ])
    .sort((a, b) => a.time - b.time || a.change - b.change);
  let current = 0,
    peakVoices = 0;
  for (const event of events) {
    current += event.change;
    peakVoices = Math.max(peakVoices, current);
  }
  if (peakVoices > MAX_SYNTH_VOICES)
    throw new Error(
      `This oscillator synth supports ${MAX_SYNTH_VOICES} simultaneous voices including release tails. Reduce overlap or export MIDI for an external instrument.`,
    );
  return { duration, notes, peakVoices };
}
function waveform(program: number): OscillatorType {
  const family = Math.floor(program / 8);
  return family === 0 || family === 3
    ? 'triangle'
    : family === 1 || family === 9
      ? 'sine'
      : family === 2 || family === 4 || family === 8 || family === 10
        ? 'square'
        : 'sawtooth';
}
const latest = (
  note: PerformedNote,
  kind: Control['kind'],
  seconds: number,
  fallback: number,
) =>
  note.controls.filter((e) => e.kind === kind && e.seconds <= seconds).at(-1)
    ?.value ?? fallback;
function voice(
  context: BaseAudioContext,
  destination: AudioNode,
  note: PerformedNote,
  origin: number,
  from: number,
): { stop: () => void } {
  const start = Math.max(note.start, from),
    at = Math.max(context.currentTime, origin + start - from),
    end = Math.max(at + 0.001, origin + note.end - from),
    duration = Math.max(0.001, note.end - note.start),
    attack = Math.min(0.008, duration * 0.2),
    decay = Math.min(0.07, duration * 0.3),
    amplitude = 0.14 * (note.velocity / 127) ** 1.5 * note.gain;
  const envelope = context.createGain(),
    controller = context.createGain(),
    pan = context.createStereoPanner();
  envelope.connect(controller);
  controller.connect(pan);
  pan.connect(destination);
  const elapsed = start - note.start,
    level =
      elapsed < attack
        ? elapsed / attack
        : elapsed < attack + decay
          ? 1 - ((elapsed - attack) / decay) * 0.4
          : 0.6;
  envelope.gain.setValueAtTime(amplitude * Math.max(0, level), at);
  if (elapsed < attack)
    envelope.gain.linearRampToValueAtTime(amplitude, at + attack - elapsed);
  if (elapsed < attack + decay)
    envelope.gain.linearRampToValueAtTime(
      amplitude * 0.6,
      at + attack + decay - elapsed,
    );
  envelope.gain.setValueAtTime(amplitude * 0.6, end);
  envelope.gain.linearRampToValueAtTime(0, end + 0.07);
  const volume = (seconds: number) =>
    ((latest(note, 'volume', seconds, 100) / 100) *
      latest(note, 'expression', seconds, 127)) /
    127;
  controller.gain.setValueAtTime(volume(start), at);
  pan.pan.setValueAtTime(
    Math.max(-1, Math.min(1, (latest(note, 'pan', start, 64) - 64) / 63)),
    at,
  );
  let source: OscillatorNode | AudioBufferSourceNode;
  if (note.channel === 9) {
    const noise = context.createBuffer(
        1,
        Math.ceil(context.sampleRate * 0.25),
        context.sampleRate,
      ),
      data = noise.getChannelData(0);
    let seed = note.pitch * 7919 + note.velocity;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      data[i] = (seed >>> 0) / 2147483648 - 1;
    }
    const buffer = context.createBufferSource(),
      filter = context.createBiquadFilter();
    buffer.buffer = noise;
    buffer.loop = true;
    filter.type = 'bandpass';
    filter.frequency.value = 150 + note.pitch * 24;
    filter.Q.value = 1.2;
    buffer.connect(filter);
    filter.connect(envelope);
    source = buffer;
  } else {
    const oscillator = context.createOscillator();
    oscillator.type = waveform(note.program);
    oscillator.frequency.setValueAtTime(
      440 * 2 ** ((note.pitch - 69 + latest(note, 'bend', start, 0) * 2) / 12),
      at,
    );
    oscillator.connect(envelope);
    source = oscillator;
  }
  for (const event of note.controls) {
    if (event.seconds <= start || event.seconds > note.end) continue;
    const when = origin + event.seconds - from;
    if (event.kind === 'volume' || event.kind === 'expression')
      controller.gain.setValueAtTime(volume(event.seconds), when);
    else if (event.kind === 'pan')
      pan.pan.setValueAtTime(
        Math.max(-1, Math.min(1, (event.value - 64) / 63)),
        when,
      );
    else if (event.kind === 'bend' && source instanceof OscillatorNode)
      source.frequency.setValueAtTime(
        440 * 2 ** ((note.pitch - 69 + event.value * 2) / 12),
        when,
      );
  }
  source.onended = () => {
    source.disconnect();
    envelope.disconnect();
    controller.disconnect();
    pan.disconnect();
  };
  source.start(at);
  source.stop(end + 0.08);
  return {
    stop() {
      try {
        source.stop();
      } catch {}
      envelope.disconnect();
      controller.disconnect();
      pan.disconnect();
    },
  };
}
function master(context: BaseAudioContext) {
  const gain = context.createGain(),
    limiter = context.createDynamicsCompressor();
  gain.gain.value = 0.65;
  limiter.threshold.value = -9;
  limiter.knee.value = 10;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  gain.connect(limiter);
  limiter.connect(context.destination);
  return gain;
}
export class MidiTransport {
  private context?: AudioContext;
  private generation = 0;
  private timer?: ReturnType<typeof setInterval>;
  private voices: { stop: () => void }[] = [];
  private output?: GainNode;
  private auditionTimers = new Set<ReturnType<typeof setTimeout>>();
  stop() {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const source of this.voices) source.stop();
    this.voices = [];
    this.output?.disconnect();
    this.output = undefined;
  }
  async play(
    content: MidiContent,
    seconds: number,
    onPosition: (seconds: number) => void,
    onEnded: () => void,
  ) {
    this.stop();
    const generation = this.generation;
    const performance = midiPerformance(content);
    if (!performance.notes.length)
      throw new Error('Add an audible note before starting playback');
    if (!globalThis.AudioContext)
      throw new Error('This browser does not provide Web Audio playback');
    const context = (this.context ??= new AudioContext());
    await context.resume();
    if (generation !== this.generation) return false;
    if (context.state !== 'running')
      throw new Error('Allow audio playback in this browser before playing');
    const output = (this.output = master(context)),
      from = Math.max(0, Math.min(seconds, performance.duration)),
      origin = context.currentTime + 0.035;
    let index = 0;
    while (
      index < performance.notes.length &&
      performance.notes[index]!.end <= from
    )
      index++;
    const schedule = () => {
      const position = Math.max(from, from + context.currentTime - origin);
      while (
        index < performance.notes.length &&
        performance.notes[index]!.start < position + 0.15
      ) {
        const note = performance.notes[index++]!;
        if (note.end > position)
          this.voices.push(voice(context, output, note, origin, from));
      }
      onPosition(Math.min(performance.duration, position));
      if (position >= performance.duration) {
        this.stop();
        onEnded();
      }
    };
    schedule();
    this.timer = setInterval(schedule, 30);
    return true;
  }
  async audition(pitch: number, program: number, channel = 0) {
    if (!globalThis.AudioContext) return;
    const context = (this.context ??= new AudioContext());
    await context.resume();
    const output = master(context),
      source = voice(
        context,
        output,
        {
          id: 'audition',
          pitch,
          program,
          channel,
          velocity: 96,
          start: 0,
          end: 0.3,
          gain: 1,
          controls: [],
        },
        context.currentTime,
        0,
      );
    const timer = setTimeout(() => {
      source.stop();
      output.disconnect();
      this.auditionTimers.delete(timer);
    }, 500);
    this.auditionTimers.add(timer);
  }
  async close() {
    this.stop();
    for (const timer of this.auditionTimers) clearTimeout(timer);
    this.auditionTimers.clear();
    await this.context?.close();
    this.context = undefined;
  }
}
export async function bounceMidiWav(
  content: MidiContent,
  options: { sampleRate?: number } = {},
) {
  const performance = midiPerformance(content);
  if (performance.duration > MAX_SYNTH_BOUNCE_SECONDS)
    throw new Error(
      `Synth WAV bounce is limited to ${MAX_SYNTH_BOUNCE_SECONDS} seconds. Export MIDI for longer arrangements.`,
    );
  if (!performance.notes.length)
    throw new Error('Add an unmuted note before bouncing synth audio');
  if (!globalThis.OfflineAudioContext)
    throw new Error(
      'This browser does not support offline Web Audio rendering',
    );
  const sampleRate = options.sampleRate ?? 44100,
    context = new OfflineAudioContext(
      2,
      Math.ceil((performance.duration + 0.09) * sampleRate),
      sampleRate,
    ),
    output = master(context);
  for (const note of performance.notes) voice(context, output, note, 0, 0);
  const audio = await context.startRendering(),
    size = audio.length * audio.numberOfChannels * 2,
    bytes = new Uint8Array(44 + size),
    view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + size, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, audio.numberOfChannels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * audio.numberOfChannels * 2, true);
  view.setUint16(32, audio.numberOfChannels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, size, true);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) =>
    audio.getChannelData(i),
  );
  for (let frame = 0; frame < audio.length; frame++)
    for (let channel = 0; channel < audio.numberOfChannels; channel++)
      view.setInt16(
        44 + (frame * audio.numberOfChannels + channel) * 2,
        Math.round(
          Math.max(-1, Math.min(1, channels[channel]![frame]!)) * 32767,
        ),
        true,
      );
  return bytes;
}
