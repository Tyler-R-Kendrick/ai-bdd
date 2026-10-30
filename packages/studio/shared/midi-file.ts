import {
  initialMidiContent,
  midiContentSchema,
  type MidiContent,
  type MidiPreservedEvent,
  type MidiTrack,
} from './midi.ts';
export const MAX_MIDI_FILE_BYTES = 10 * 1024 * 1024;
type Raw = {
  tick: number;
  order: number;
  kind: 'midi' | 'meta' | 'sysex';
  type?: number;
  data: number[];
  track: number;
};
class Reader {
  position = 0;
  constructor(readonly bytes: Uint8Array) {}
  require(count: number) {
    if (
      count < 0 ||
      !Number.isSafeInteger(count) ||
      this.position + count > this.bytes.length
    )
      throw new Error('MIDI data is truncated.');
  }
  byte() {
    this.require(1);
    return this.bytes[this.position++];
  }
  number(count: number) {
    this.require(count);
    let n = 0;
    for (let i = 0; i < count; i++) n = n * 256 + this.byte();
    return n;
  }
  data(count: number) {
    this.require(count);
    const data = Array.from(
      this.bytes.subarray(this.position, this.position + count),
    );
    this.position += count;
    return data;
  }
  text(count: number) {
    return String.fromCharCode(...this.data(count));
  }
  variable() {
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const value = this.byte();
      n = n * 128 + (value & 127);
      if (!(value & 128)) return n;
    }
    throw new Error('MIDI variable-length value exceeds four bytes.');
  }
}
const utf8 = new TextEncoder(),
  decoder = new TextDecoder();
function noSource(content: MidiContent) {
  const { sourceSrc: _sourceSrc, ...canonical } = content;
  return canonical;
}
/** Fully bounded SMF0/1 decoder; SMPTE imports normalize timing to PPQ while retaining a source for exact untouched export. */
export function parseMidiFile(input: Uint8Array): MidiContent {
  if (input.length < 14 || input.length > MAX_MIDI_FILE_BYTES)
    throw new Error('Choose a complete Standard MIDI File of at most 10 MiB.');
  const reader = new Reader(input);
  if (reader.text(4) !== 'MThd')
    throw new Error('Expected a Standard MIDI File header.');
  const headerLength = reader.number(4);
  if (headerLength < 6 || headerLength > 1024)
    throw new Error('The MIDI header length is invalid.');
  const format = reader.number(2),
    trackCount = reader.number(2),
    division = reader.number(2);
  reader.data(headerLength - 6);
  if (
    ![0, 1].includes(format) ||
    trackCount < 1 ||
    trackCount > 64 ||
    (format === 0 && trackCount !== 1) ||
    !division
  )
    throw new Error('Choose SMF format 0 or 1 with at most 64 source tracks.');
  const smpte = !!(division & 0x8000),
    fpsCode = 256 - (division >> 8),
    fps = fpsCode === 29 ? 30000 / 1001 : fpsCode,
    frameTicks = division & 255;
  if (smpte && (![24, 25, 29, 30].includes(fpsCode) || !frameTicks))
    throw new Error('The MIDI SMPTE time division is invalid.');
  const ppq = smpte ? 480 : division;
  if (ppq < 24 || ppq > 9600)
    throw new Error('MIDI PPQ must be between 24 and 9600.');
  const raw: Raw[] = [],
    names = new Map<number, string>();
  let sequence = 0,
    lastTick = 0,
    payload = 0;
  for (let track = 0; track < trackCount; track++) {
    if (reader.text(4) !== 'MTrk')
      throw new Error('Expected a MIDI track chunk.');
    const length = reader.number(4);
    reader.require(length);
    const end = reader.position + length;
    let tick = 0,
      running = 0,
      sawEnd = false;
    while (reader.position < end) {
      tick += reader.variable();
      lastTick = Math.max(lastTick, tick);
      if (!Number.isSafeInteger(tick) || tick > 0x0fffffff)
        throw new Error('MIDI time exceeds the supported timeline.');
      let status = reader.byte(),
        first: number | undefined;
      if (status < 128) {
        if (running < 0x80 || running >= 0xf0)
          throw new Error('MIDI running status has no channel status.');
        first = status;
        status = running;
      }
      let item: Raw;
      if (status === 255) {
        const type = reader.byte(),
          count = reader.variable();
        if (count > 65536 || payload + count > 512000)
          throw new Error('MIDI event payload exceeds its resource budget.');
        item = {
          kind: 'meta',
          type,
          data: reader.data(count),
          tick,
          track,
          order: sequence++,
        };
        if (type === 0x2f) {
          if (count !== 0)
            throw new Error('MIDI end-of-track length is invalid.');
          sawEnd = true;
        }
        if (type === 3)
          names.set(
            track,
            decoder.decode(Uint8Array.from(item.data)).slice(0, 160),
          );
      } else if (status === 0xf0 || status === 0xf7) {
        const count = reader.variable();
        if (count > 65536 || payload + count > 512000)
          throw new Error('MIDI system payload exceeds its resource budget.');
        item = {
          kind: 'sysex',
          type: status,
          data: reader.data(count),
          tick,
          track,
          order: sequence++,
        };
        running = 0;
      } else if (status >= 0x80 && status < 0xf0) {
        running = status;
        const count = [0xc0, 0xd0].includes(status & 0xf0) ? 1 : 2;
        const data = [status, first ?? reader.byte()];
        if (count === 2) data.push(reader.byte());
        if (data.slice(1).some((value) => value > 127))
          throw new Error(
            'MIDI channel data contains an unexpected status byte.',
          );
        item = { kind: 'midi', data, tick, track, order: sequence++ };
      } else throw new Error('Unsupported MIDI system event in a track.');
      if (reader.position > end)
        throw new Error('MIDI event exceeds its track boundary.');
      payload += item.data.length;
      if (raw.length >= 100000 || payload > 512000)
        throw new Error('MIDI event data exceeds its resource budget.');
      raw.push(item);
      if (sawEnd) {
        if (reader.position !== end)
          throw new Error(
            'MIDI track contains bytes after its end-of-track marker.',
          );
        break;
      }
    }
    if (!sawEnd || reader.position !== end)
      throw new Error('MIDI track has no complete end-of-track event.');
  }
  if (reader.position !== input.length)
    throw new Error('MIDI contains undeclared trailing chunks.');
  const content = initialMidiContent();
  content.format = format as 0 | 1;
  content.ppq = ppq;
  const tempos = raw
    .filter((event) => event.kind === 'meta' && event.type === 0x51)
    .sort((a, b) => a.tick - b.tick || a.order - b.order);
  const tempoTicks = [{ tick: 0, bpm: 120 }];
  for (const event of tempos) {
    if (event.data.length !== 3)
      throw new Error('MIDI tempo has an invalid byte length.');
    const micros = event.data[0] * 65536 + event.data[1] * 256 + event.data[2];
    if (!micros) throw new Error('MIDI tempo cannot be zero.');
    const bpm = 60000000 / micros,
      last = tempoTicks.at(-1)!;
    if (last.tick === event.tick) last.bpm = bpm;
    else tempoTicks.push({ tick: event.tick, bpm });
  }
  const segments: { tick: number; beat: number; bpm: number }[] = [];
  for (const tempo of tempoTicks) {
    const previous = segments.at(-1);
    const beat = previous
      ? previous.beat +
        (((tempo.tick - previous.tick) / (fps * frameTicks)) * previous.bpm) /
          60
      : 0;
    segments.push({ ...tempo, beat: smpte ? beat : tempo.tick / ppq });
  }
  const toBeat = (tick: number) => {
    if (!smpte) return tick / ppq;
    let segment = segments[0];
    for (const next of segments) {
      if (next.tick > tick) break;
      segment = next;
    }
    return (
      segment.beat +
      (((tick - segment.tick) / (fps * frameTicks)) * segment.bpm) / 60
    );
  };
  content.tempo = segments.map((segment) => ({
    beat: segment.beat,
    bpm: segment.bpm,
  }));
  const meters = raw
    .filter((event) => event.kind === 'meta' && event.type === 0x58)
    .sort((a, b) => a.tick - b.tick || a.order - b.order);
  content.timeSignatures = [{ beat: 0, numerator: 4, denominator: 4 }];
  for (const event of meters) {
    if (event.data.length !== 4 || event.data[1] > 5)
      throw new Error(
        'MIDI time signature is outside the supported meter range.',
      );
    const meter = {
        beat: toBeat(event.tick),
        numerator: event.data[0],
        denominator: (2 ** event.data[1]) as 1 | 2 | 4 | 8 | 16 | 32,
      },
      last = content.timeSignatures.at(-1)!;
    if (last.beat === meter.beat) Object.assign(last, meter);
    else content.timeSignatures.push(meter);
  }
  const sourceChannels = new Map<number, Set<number>>();
  for (const event of raw)
    if (event.kind === 'midi') {
      const channels = sourceChannels.get(event.track) ?? new Set<number>();
      channels.add(event.data[0] & 15);
      sourceChannels.set(event.track, channels);
    }
  const logical = new Map<string, MidiTrack>(),
    pending = new Map<string, { raw: Raw; velocity: number }[]>();
  const trackFor = (event: Raw) => {
    const channel = event.data[0] & 15,
      key = event.track + ':' + channel;
    let track = logical.get(key);
    if (!track) {
      const channels = sourceChannels.get(event.track)!;
      const title = names.get(event.track) || `Track ${event.track + 1}`;
      track = {
        id: `track-${event.track}-${channel}`,
        title: channels.size > 1 ? `${title} · Ch ${channel + 1}` : title,
        channel,
        instrument: 0,
        gainDb: 0,
        mute: false,
        solo: false,
        notes: [],
        events: [],
      };
      logical.set(key, track);
    }
    return track;
  };
  for (const event of raw) {
    if (event.kind === 'midi') {
      const track = trackFor(event),
        type = event.data[0] & 0xf0,
        key = track.id + ':' + event.data[1];
      if (type === 0x90 && event.data[2] > 0) {
        const notes = pending.get(key) ?? [];
        notes.push({ raw: event, velocity: event.data[2] });
        pending.set(key, notes);
      } else if (type === 0x80 || type === 0x90) {
        const notes = pending.get(key),
          start = notes?.shift();
        if (start) {
          const startBeat = toBeat(start.raw.tick),
            endBeat = toBeat(event.tick);
          track.notes.push({
            id: 'note-' + start.raw.order,
            pitch: event.data[1],
            start: startBeat,
            duration: Math.max(1 / ppq, endBeat - startBeat),
            velocity: start.velocity,
            releaseVelocity: type === 0x80 ? event.data[2] : 0,
          });
        }
      } else if (type === 0xc0 && event.tick === 0)
        track.instrument = event.data[1];
      else
        track.events.push({
          tick: Math.round(toBeat(event.tick) * ppq),
          kind: 'midi',
          data: event.data,
        });
    } else if (event.kind === 'sysex')
      content.meta.push({
        tick: Math.round(toBeat(event.tick) * ppq),
        kind: 'sysex',
        type: event.type,
        data: event.data,
      });
    else if (![0x2f, 0x51, 0x58, 3].includes(event.type!))
      content.meta.push({
        tick: Math.round(toBeat(event.tick) * ppq),
        kind: 'meta',
        type: event.type,
        data: event.data,
      });
  }
  for (const notes of pending.values())
    for (const start of notes) {
      const track = logical.get(
          start.raw.track + ':' + (start.raw.data[0] & 15),
        )!,
        beat = toBeat(start.raw.tick);
      track.notes.push({
        id: 'note-' + start.raw.order,
        pitch: start.raw.data[1],
        start: beat,
        duration: Math.max(1 / ppq, toBeat(lastTick) - beat),
        velocity: start.velocity,
        releaseVelocity: 0,
      });
    }
  content.tracks = [...logical.values()];
  for (const track of content.tracks)
    track.notes.sort(
      (a, b) =>
        a.start - b.start || a.pitch - b.pitch || a.id.localeCompare(b.id),
    );
  const lastBeat = Math.max(
    toBeat(lastTick),
    ...content.tracks.flatMap((track) =>
      track.notes.map((note) => note.start + note.duration),
    ),
  );
  content.lengthBeats = Math.max(4, Math.ceil(lastBeat / 4) * 4);
  return midiContentSchema.parse(content);
}
const be = (number: number, count: number) =>
  Array.from(
    { length: count },
    (_, i) => Math.floor(number / 256 ** (count - i - 1)) & 255,
  );
function variable(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 0x0fffffff)
    throw new Error('MIDI tick delta exceeds its four-byte limit.');
  const bytes = [value & 127];
  while ((value = Math.floor(value / 128))) bytes.unshift((value & 127) | 128);
  return bytes;
}
type OutputEvent = { tick: number; priority: number; bytes: number[] };
function preserved(
  event: MidiPreservedEvent,
  channel?: number,
): OutputEvent | null {
  if (event.kind === 'midi') {
    const status = event.data[0],
      count = [0xc0, 0xd0].includes(status & 0xf0) ? 2 : 3;
    if (
      status < 0x80 ||
      status >= 0xf0 ||
      event.data.length !== count ||
      event.data.slice(1).some((value) => value > 127) ||
      [0x80, 0x90].includes(status & 0xf0)
    )
      throw new Error('Preserved MIDI channel event is invalid.');
    return {
      tick: event.tick,
      priority: 1,
      bytes: [
        channel === undefined ? status : (status & 0xf0) | channel,
        ...event.data.slice(1),
      ],
    };
  }
  if (event.kind === 'meta') {
    if (event.type === undefined || event.type > 127)
      throw new Error('Preserved MIDI meta type is invalid.');
    if (event.type === 0x2f) return null;
    return {
      tick: event.tick,
      priority: 1,
      bytes: [255, event.type, ...variable(event.data.length), ...event.data],
    };
  }
  if (![0xf0, 0xf7].includes(event.type ?? -1))
    throw new Error('Preserved MIDI system event is invalid.');
  return {
    tick: event.tick,
    priority: 1,
    bytes: [event.type!, ...variable(event.data.length), ...event.data],
  };
}
function trackChunk(events: OutputEvent[], endTick: number) {
  events.sort((a, b) => a.tick - b.tick || a.priority - b.priority);
  const bytes: number[] = [];
  let previous = 0;
  for (const event of events) {
    bytes.push(...variable(event.tick - previous), ...event.bytes);
    previous = event.tick;
  }
  bytes.push(...variable(Math.max(0, endTick - previous)), 255, 0x2f, 0);
  return [77, 84, 114, 107, ...be(bytes.length, 4), ...bytes];
}
/** Returns original validated bytes when untouched; otherwise writes a canonical SMF0/1 with edited notes/controllers/tempo. */
export function writeMidiFile(
  input: MidiContent,
  options: { original?: Uint8Array } = {},
): Uint8Array {
  const content = midiContentSchema.parse(input);
  if (options.original) {
    try {
      if (
        JSON.stringify(noSource(parseMidiFile(options.original))) ===
        JSON.stringify(noSource(content))
      )
        return options.original.slice();
    } catch {
      /* The canonical project still exports when an original is unavailable or changed. */
    }
  }
  const conductor: OutputEvent[] = content.meta
    .map((event) => preserved(event))
    .filter((event): event is OutputEvent => !!event);
  for (const tempo of content.tempo) {
    const micros = Math.round(60000000 / tempo.bpm);
    if (micros < 1 || micros > 0xffffff)
      throw new Error('Tempo cannot be represented in a Standard MIDI File.');
    conductor.push({
      tick: Math.round(tempo.beat * content.ppq),
      priority: 0,
      bytes: [255, 0x51, 3, ...be(micros, 3)],
    });
  }
  for (const meter of content.timeSignatures)
    conductor.push({
      tick: Math.round(meter.beat * content.ppq),
      priority: 0,
      bytes: [
        255,
        0x58,
        4,
        meter.numerator,
        Math.log2(meter.denominator),
        24,
        8,
      ],
    });
  const solo = content.tracks.some((track) => track.solo && !track.mute),
    tracks = content.tracks.map((track) => {
      const name = Array.from(utf8.encode(track.title)),
        events: OutputEvent[] = [
          {
            tick: 0,
            priority: 0,
            bytes: [255, 3, ...variable(name.length), ...name],
          },
          {
            tick: 0,
            priority: 0,
            bytes: [0xc0 | track.channel, track.instrument],
          },
        ];
      const muted = track.mute || (solo && !track.solo);
      // SMF has no track-mute event. Omit this part's notes and channel state,
      // so later CC7/SysEx and other parts sharing its channel cannot unmute it.
      if (muted) return events.slice(0, 1);
      const gain = Math.pow(10, track.gainDb / 20),
        volume = (value: number) =>
          Math.min(127, Math.max(0, Math.round(value * gain)));
      if (track.gainDb !== 0)
        events.push({
          tick: 0,
          priority: 1,
          bytes: [0xb0 | track.channel, 7, volume(100)],
        });
      events.push(
        ...track.events
          .map((event) => {
            const adjusted =
              track.gainDb !== 0 &&
              event.kind === 'midi' &&
              (event.data[0] & 0xf0) === 0xb0 &&
              event.data[1] === 7
                ? { ...event, data: [event.data[0], 7, volume(event.data[2])] }
                : event;
            return preserved(adjusted, track.channel);
          })
          .filter((event): event is OutputEvent => !!event),
      );
      for (const note of track.notes) {
        const start = Math.round(note.start * content.ppq),
          end = Math.max(
            start + 1,
            Math.round((note.start + note.duration) * content.ppq),
          );
        events.push(
          {
            tick: start,
            priority: 3,
            bytes: [0x90 | track.channel, note.pitch, note.velocity],
          },
          {
            tick: end,
            priority: 2,
            bytes: [0x80 | track.channel, note.pitch, note.releaseVelocity],
          },
        );
      }
      return events;
    });
  const endTick = Math.ceil(content.lengthBeats * content.ppq),
    chunks =
      content.format === 0
        ? [trackChunk([...conductor, ...tracks.flat()], endTick)]
        : [
            trackChunk(conductor, endTick),
            ...tracks.map((events) => trackChunk(events, endTick)),
          ];
  const bytes = Uint8Array.from([
    77,
    84,
    104,
    100,
    0,
    0,
    0,
    6,
    ...be(content.format, 2),
    ...be(chunks.length, 2),
    ...be(content.ppq, 2),
    ...chunks.flat(),
  ]);
  if (bytes.length > MAX_MIDI_FILE_BYTES)
    throw new Error('The exported MIDI file exceeds 10 MiB.');
  return bytes;
}
