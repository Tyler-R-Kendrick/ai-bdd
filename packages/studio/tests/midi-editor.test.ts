import { describe, it, expect } from 'vitest';
import { initialMidiContent, beatSeconds } from '../shared/midi.ts';
import {
  newMidiTrack,
  newMidiNote,
  moveMidiNote,
  resizeMidiNote,
  barMarkers,
  pitchName,
  gmPrograms,
} from '../client/editors/midi/model.ts';
import {
  midiPerformance,
  bounceMidiWav,
} from '../client/editors/midi/synth.ts';
describe('MIDI editing and tempo-aware performance', () => {
  it('moves and resizes a note within the timeline while preserving its opaque imported source and events', () => {
    const content = initialMidiContent();
    content.sourceSrc = '/api/files/00000000-0000-4000-8000-000000000001';
    const track = newMidiTrack(content);
    track.events = [{ kind: 'midi', tick: 480, data: [0xb0, 1, 40] }];
    track.notes = [newMidiNote(content, 2, 60, 2)];
    content.tracks = [track];
    const moved = moveMidiNote(content, track.id, track.notes[0].id, 100, 140);
    expect(moved.tracks[0].notes[0]).toMatchObject({
      start: 14,
      pitch: 127,
      duration: 2,
    });
    expect(moved.sourceSrc).toBe(content.sourceSrc);
    expect(moved.tracks[0].events).toEqual(track.events);
    const resized = resizeMidiNote(moved, track.id, track.notes[0].id, 100);
    expect(resized.tracks[0].notes[0].duration).toBe(2);
    expect(content.tracks[0].notes[0].start).toBe(2);
  });
  it('schedules notes across tempo changes and sustains them until the pedal is released', () => {
    const content = initialMidiContent();
    content.tempo = [
      { beat: 0, bpm: 120 },
      { beat: 2, bpm: 60 },
    ];
    const track = newMidiTrack(content);
    track.notes = [
      newMidiNote(content, 1, 60, 1),
      newMidiNote(content, 3, 67, 1),
    ];
    track.events = [
      { kind: 'midi', tick: 0, data: [0xb0, 64, 127] },
      { kind: 'midi', tick: content.ppq * 4, data: [0xb0, 64, 0] },
      { kind: 'midi', tick: content.ppq * 2, data: [0xc0, 80] },
    ];
    content.tracks = [track];
    const performance = midiPerformance(content);
    expect(performance.notes[0]).toMatchObject({
      start: 0.5,
      end: 3,
      program: 0,
    });
    expect(performance.notes[1]).toMatchObject({
      start: 2,
      end: 3,
      program: 80,
    });
    expect(performance.duration).toBe(beatSeconds(content, 16));
  });
  it('applies mute and solo before voice admission and rejects excessive polyphony visibly', () => {
    const content = initialMidiContent(),
      a = newMidiTrack(content),
      b = newMidiTrack({ ...content, tracks: [a] });
    a.notes = [newMidiNote(content, 0, 60)];
    b.notes = [newMidiNote(content, 0, 64)];
    b.solo = true;
    content.tracks = [a, b];
    expect(midiPerformance(content).notes.map((n) => n.pitch)).toEqual([64]);
    b.solo = false;
    a.notes = Array.from({ length: 65 }, (_, i) => ({
      ...newMidiNote(content, 0, i % 128),
      id: 'note-' + i,
    }));
    b.mute = true;
    expect(() => midiPerformance(content)).toThrow('64 simultaneous');
  });
  it('keeps compound meter bar boundaries and all128 General MIDI program names stable', () => {
    const content = initialMidiContent();
    content.timeSignatures = [
      { beat: 0, numerator: 7, denominator: 8 },
      { beat: 7, numerator: 3, denominator: 4 },
    ];
    expect(
      barMarkers(content)
        .slice(0, 4)
        .map((m) => m.beat),
    ).toEqual([0, 3.5, 7, 10]);
    expect(gmPrograms).toHaveLength(128);
    expect(pitchName(60)).toBe('C4');
    expect(pitchName(0)).toBe('C-1');
    expect(pitchName(127)).toBe('G9');
  });
  it('rejects an oversized audio bounce before allocating a browser audio buffer', async () => {
    const content = initialMidiContent();
    content.lengthBeats = 300;
    const track = newMidiTrack(content);
    track.notes = [newMidiNote(content, 0, 60)];
    content.tracks = [track];
    await expect(bounceMidiWav(content)).rejects.toThrow('120 seconds');
  });
  it('bounds controller scheduling before allocating a pathological synth graph', () => {
    const content = initialMidiContent();
    content.lengthBeats = 3000;
    const track = newMidiTrack(content);
    track.notes = Array.from({ length: 5000 }, (_, i) => ({
      ...newMidiNote(content, i * 0.5, 60, 0.1),
      id: 'note-' + i,
    }));
    track.events = Array.from({ length: 500 }, (_, i) => ({
      kind: 'midi' as const,
      tick: i * 480,
      data: [0xb0, 7, i % 128],
    }));
    content.tracks = [track];
    expect(() => midiPerformance(content)).toThrow(
      'controller automation exceeds',
    );
  });
});
