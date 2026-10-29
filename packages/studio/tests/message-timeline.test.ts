import { describe, it, expect } from 'vitest';
import {
  mergeTimeline,
  reconcileLive,
  type TimelineMessage,
} from '../shared/message-history.ts';

const timelineMessage = (
  sequence: number,
  threadId = 'main',
): TimelineMessage => ({
  id: `message-${sequence}`,
  sequence,
  artifactId: 'artifact',
  threadId,
  author: 'Teammate',
  authorId: 'user',
  role: 'user',
  body: `Message ${sequence}`,
  createdAt: '2026-10-29T00:00:00.000Z',
  proposal: null,
});
describe('Conversation continuity across paged and live history', () => {
  it('retains loaded older pages and deduplicates overlapping live updates', () => {
    const messages = Array.from({ length: 200 }, (_, index) =>
      timelineMessage(index + 1),
    );
    const history = {
      key: 'artifact/main',
      loaded: true,
      error: '',
      messages,
      nextCursor: 'message-1',
      hasMore: true,
      gaps: [],
    };
    const live = Array.from({ length: 25 }, (_, index) =>
      timelineMessage(index + 190),
    );
    live[0] = { ...live[0]!, body: 'Updated message' };
    const updated = reconcileLive(history, live, 'main');
    expect(updated.messages).toHaveLength(214);
    expect(updated.messages[0]!.sequence).toBe(1);
    expect(updated.messages.at(-1)!.sequence).toBe(214);
    expect(
      updated.messages.find((message) => message.sequence === 190)!.body,
    ).toBe('Updated message');
    expect(updated.nextCursor).toBe('message-1');
    expect(updated.gaps).toEqual([]);
    expect(
      mergeTimeline(updated.messages, messages).map(
        (message) => message.sequence,
      ),
    ).toEqual(Array.from({ length: 214 }, (_, index) => index + 1));
  });
  it('marks a missing live interval instead of silently dropping messages', () => {
    const history = {
      key: 'artifact/main',
      loaded: true,
      error: '',
      messages: [timelineMessage(1), timelineMessage(2)],
      nextCursor: null,
      hasMore: false,
      gaps: [],
    };
    const updated = reconcileLive(
      history,
      [timelineMessage(1001), timelineMessage(1002)],
      'main',
    );
    expect(updated.messages.map((message) => message.sequence)).toEqual([
      1, 2, 1001, 1002,
    ]);
    expect(updated.gaps).toEqual([
      { before: 'message-1001', afterSequence: 2 },
    ]);
  });
});
