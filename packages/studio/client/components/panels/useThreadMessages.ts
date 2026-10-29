import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '../../../shared/domain.ts';
import { api } from '../../lib.ts';
import {
  mergeTimeline,
  reconcileLive,
  type TimelineMessage,
  type MessageHistoryPage as Page,
  type MessageHistoryState as HistoryState,
  type HistoryGap,
} from '../../../shared/message-history.ts';
export type { HistoryGap } from '../../../shared/message-history.ts';
const empty = (key: string): HistoryState => ({
  key,
  messages: [],
  nextCursor: null,
  hasMore: false,
  loaded: false,
  error: '',
  gaps: [],
});

export function useThreadMessages(
  artifactId: string,
  threadId: string | undefined,
  liveMessages: Message[],
  onError: (message: string) => void,
) {
  const key = `${artifactId}/${threadId ?? ''}`;
  const [history, setHistory] = useState<HistoryState>(() => empty(key));
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0),
    loading = useRef(false);
  const latestHistory = useRef(history);
  latestHistory.current = history;

  useEffect(() => {
    const request = ++generation.current;
    loading.current = false;
    setLoadingEarlier(false);
    setHistory(empty(key));
    if (!threadId) {
      setHistory({ ...empty(key), loaded: true });
      return;
    }
    const query = new URLSearchParams({ threadId, limit: '100' });
    void api<Page>(`/artifacts/${artifactId}/messages?${query}`)
      .then((page) => {
        if (request === generation.current)
          setHistory({ ...page, key, loaded: true, error: '', gaps: [] });
      })
      .catch((error) => {
        if (request !== generation.current) return;
        const message =
          error instanceof Error
            ? error.message
            : 'Conversation history could not load';
        setHistory({ ...empty(key), loaded: true, error: message });
        onError(message);
      });
    return () => {
      generation.current++;
    };
  }, [artifactId, threadId, key, reload, onError]);

  useEffect(() => {
    if (!threadId) return;
    if (
      history.key === key &&
      history.loaded &&
      !history.messages.length &&
      !history.error &&
      liveMessages.some((message) => message.threadId === threadId)
    ) {
      // A just-created thread may receive its first message after its empty
      // page loaded. Refetch its head so pagination metadata stays accurate.
      setReload((value) => value + 1);
      return;
    }
    setHistory((previous) => {
      if (previous.key !== key || !previous.loaded) return previous;
      return reconcileLive(
        previous,
        liveMessages as TimelineMessage[],
        threadId,
      );
    });
  }, [
    liveMessages,
    threadId,
    key,
    history.key,
    history.loaded,
    history.messages.length,
    history.error,
  ]);

  const loadEarlier = useCallback(
    async (gap?: HistoryGap) => {
      const previous = latestHistory.current;
      const before = gap?.before ?? previous.nextCursor;
      if (!threadId || !before || loading.current || previous.key !== key)
        return;
      const request = generation.current;
      loading.current = true;
      setLoadingEarlier(true);
      try {
        const query = new URLSearchParams({ threadId, before, limit: '100' });
        const page = await api<Page>(
          `/artifacts/${artifactId}/messages?${query}`,
        );
        if (request !== generation.current) return;
        setHistory((current) => {
          if (current.key !== key) return current;
          const gaps = gap
            ? current.gaps.flatMap((item) => {
                if (
                  item.before !== gap.before ||
                  item.afterSequence !== gap.afterSequence
                )
                  return [item];
                const oldest = page.messages[0];
                return oldest &&
                  oldest.sequence > item.afterSequence &&
                  page.nextCursor
                  ? [{ ...item, before: page.nextCursor }]
                  : [];
              })
            : current.gaps;
          return {
            ...current,
            messages: mergeTimeline(current.messages, page.messages),
            error: '',
            gaps,
            ...(gap
              ? {}
              : { nextCursor: page.nextCursor, hasMore: page.hasMore }),
          };
        });
      } catch (error) {
        if (request !== generation.current) return;
        const message =
          error instanceof Error
            ? error.message
            : 'Earlier messages could not load';
        setHistory((current) =>
          current.key === key ? { ...current, error: message } : current,
        );
        onError(message);
      } finally {
        if (request === generation.current) {
          loading.current = false;
          setLoadingEarlier(false);
        }
      }
    },
    [artifactId, threadId, key, onError],
  );

  return {
    ...(history.key === key ? history : empty(key)),
    loadingEarlier,
    loadEarlier,
    retry: () => setReload((value) => value + 1),
  };
}
