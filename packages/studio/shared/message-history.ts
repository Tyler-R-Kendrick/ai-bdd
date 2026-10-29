import type { Message } from './domain.ts';

export type TimelineMessage = Message & { sequence: number };
export type MessageHistoryPage = {
  messages: TimelineMessage[];
  nextCursor: string | null;
  hasMore: boolean;
};
export type HistoryGap = { before: string; afterSequence: number };
export type MessageHistoryState = MessageHistoryPage & {
  key: string;
  loaded: boolean;
  error: string;
  gaps: HistoryGap[];
};

export function mergeTimeline(
  current: TimelineMessage[],
  incoming: TimelineMessage[],
): TimelineMessage[] {
  const messages = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

// A live bundle contains a bounded, complete suffix of the artifact's messages.
// Only append its new messages and update known records; loading older history is
// explicit. If that suffix no longer overlaps, retain both sides and expose the
// missing interval rather than silently presenting a discontinuous conversation.
export function reconcileLive(
  history: MessageHistoryState,
  allMessages: TimelineMessage[],
  threadId: string,
): MessageHistoryState {
  if (!history.loaded || !history.messages.length) return history;
  const known = new Map(
    history.messages.map((message) => [message.id, message]),
  );
  const latest = history.messages.at(-1)!.sequence;
  const live = allMessages.filter(
    (message) =>
      message.threadId === threadId && Number.isFinite(message.sequence),
  );
  const changes = live.filter((message) => {
    const previous = known.get(message.id);
    return (
      message.sequence > latest ||
      (previous && JSON.stringify(previous) !== JSON.stringify(message))
    );
  });
  if (!changes.length) return history;
  const additions = changes.filter((message) => message.sequence > latest);
  const firstKnownSequence = Math.min(
    ...allMessages
      .filter((message) => Number.isFinite(message.sequence))
      .map((message) => message.sequence),
  );
  const gaps = [...history.gaps];
  if (additions.length && firstKnownSequence > latest) {
    const before = additions.reduce((first, message) =>
      message.sequence < first.sequence ? message : first,
    ).id;
    gaps.push({ before, afterSequence: latest });
  }
  return {
    ...history,
    messages: mergeTimeline(history.messages, changes),
    gaps,
  };
}
