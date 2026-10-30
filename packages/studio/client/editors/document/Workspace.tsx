import type { InvestigationPlacement } from '../../../shared/investigations.ts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import type { Editor } from '@tiptap/core';
import { api, ApiError } from '../../lib.ts';
import type { Artifact, RichNode, User } from '../../../shared/domain.ts';
import type {
  DocumentSuggestion,
  QuestionnaireAnswer,
} from '../../../shared/document-review.ts';

type PageCursor = { hasMore: boolean; nextCursor: number | null };
export type ReviewResponse = {
  suggestions: DocumentSuggestion[];
  answers: QuestionnaireAnswer[];
  anchors: {
    id: string;
    decisionId: string;
    anchor: string;
    sourceId: string;
    sourceKind: string;
    createdAt: string;
  }[];
  pagination: { suggestions: PageCursor; answers: PageCursor };
};
type Job = {
  id: string;
  status: string;
  error: string | null;
  childArtifactId: string | null;
  intent: string;
  brief: string;
};
type Workspace = {
  artifact: Artifact;
  user: User;
  readOnly: boolean;
  runs: any[];
  editor: Editor | null;
  review: ReviewResponse | null;
  reviewError: string;
  refresh: () => Promise<void>;
  earlier: () => Promise<void>;
  artifacts: Artifact[];
  refreshArtifacts: () => Promise<void>;
  jobs: Job[];
  onError: (message: string) => void;
  onTests: () => void;
  onDecisions?: () => void;
  onInvestigations?: (
    id?: string,
    placement?: InvestigationPlacement,
  ) => void;
  onComment: (anchor: string, quote: string) => void;
  reviewOpen: boolean;
  setReviewOpen: (value: boolean) => void;
};
const Context = createContext<Workspace | null>(null);
export const useDocumentWorkspace = () => {
  const value = useContext(Context);
  if (!value) throw new Error('Document workspace is unavailable');
  return value;
};
export function DocumentWorkspaceProvider({
  children,
  ...props
}: PropsWithChildren<
  Omit<
    Workspace,
    | 'review'
    | 'reviewError'
    | 'refresh'
    | 'earlier'
    | 'artifacts'
    | 'refreshArtifacts'
    | 'jobs'
    | 'reviewOpen'
    | 'setReviewOpen'
  >
>) {
  const [review, setReview] = useState<ReviewResponse | null>(null),
    [reviewError, setReviewError] = useState(''),
    [artifacts, setArtifacts] = useState<Artifact[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [reviewOpen, setReviewOpen] = useState(false),
    active = useRef(true),
    refreshing = useRef(false),
    lastContextRead = useRef(0),
    lastJobRead = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    lastContextRead.current = Date.now();
    try {
      const result = await api<ReviewResponse>(
        `/artifacts/${props.artifact.id}/document/review`,
      );
      if (active.current) {
        setReview((old) =>
          old
            ? {
                ...result,
                suggestions: merge(old.suggestions, result.suggestions),
                answers: merge(old.answers, result.answers),
                pagination:
                  old.pagination.suggestions.hasMore ||
                  old.pagination.answers.hasMore
                    ? old.pagination
                    : result.pagination,
              }
            : result,
        );
        setReviewError('');
      }
    } catch (error) {
      if (active.current) setReviewError((error as Error).message);
    } finally {
      refreshing.current = false;
    }
  }, [props.artifact.id]);
  const refreshArtifacts = useCallback(async () => {
    try {
      const result = await api<Artifact[]>(
        `/projects/${props.artifact.projectId}/artifacts`,
      );
      if (active.current) setArtifacts(result);
    } catch (error) {
      if (active.current) props.onError((error as Error).message);
    }
  }, [props.artifact.projectId]);
  const earlier = useCallback(async () => {
    if (!review) return;
    try {
      const params = new URLSearchParams({
          beforeSuggestions: String(
            review.pagination.suggestions.nextCursor ?? 0,
          ),
          beforeAnswers: String(review.pagination.answers.nextCursor ?? 0),
        }),
        result = await api<ReviewResponse>(
          `/artifacts/${props.artifact.id}/document/review?${params}`,
        );
      if (active.current)
        setReview((old) =>
          old
            ? {
                ...result,
                suggestions: merge(result.suggestions, old.suggestions),
                answers: merge(result.answers, old.answers),
              }
            : result,
        );
    } catch (error) {
      props.onError((error as Error).message);
    }
  }, [review, props.artifact.id]);
  useEffect(() => {
    setReview(null);
    setReviewOpen(false);
    void refresh();
    void refreshArtifacts();
  }, [props.artifact.id, refresh, refreshArtifacts]);
  useEffect(() => {
    const timeout = setTimeout(
      () => {
        void refresh();
        void refreshArtifacts();
      },
      Math.max(250, 4000 - (Date.now() - lastContextRead.current)),
    );
    return () => clearTimeout(timeout);
  }, [props.artifact, refresh, refreshArtifacts]);
  useEffect(() => {
    let stopped = false,
      timeout: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      lastJobRead.current = Date.now();
      try {
        const result = await api<{ jobs: Job[] }>(
          `/artifacts/${props.artifact.id}/integrations/jobs`,
        );
        if (!stopped) {
          setJobs(result.jobs);
          const pending = result.jobs.some((job) =>
            ['queued', 'running'].includes(job.status),
          );
          if (pending) timeout = setTimeout(load, 5000);
        }
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404) && !stopped)
          props.onError((error as Error).message);
      }
    };
    timeout = setTimeout(
      load,
      Math.max(0, 4000 - (Date.now() - lastJobRead.current)),
    );
    return () => {
      stopped = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [props.artifact.id, props.artifact.version]);
  return (
    <Context.Provider
      value={{
        ...props,
        review,
        reviewError,
        refresh,
        earlier,
        artifacts,
        refreshArtifacts,
        jobs,
        reviewOpen,
        setReviewOpen,
      }}
    >
      {children}
    </Context.Provider>
  );
}
function merge<T extends { id: string }>(older: T[], recent: T[]): T[] {
  const result = new Map(older.map((row) => [row.id, row]));
  for (const row of recent) result.set(row.id, row);
  return [...result.values()];
}
export function replaceImportAttachments(
  doc: RichNode,
  uploads: Record<string, string>,
): RichNode {
  return {
    ...doc,
    ...(doc.attrs?.src &&
    typeof doc.attrs.src === 'string' &&
    doc.attrs.src.startsWith('attachment:')
      ? {
          attrs: {
            ...doc.attrs,
            src: uploads[doc.attrs.src.slice(11)] ?? '',
          },
        }
      : {}),
    ...(doc.content
      ? {
          content: doc.content.map((node) =>
            replaceImportAttachments(node, uploads),
          ),
        }
      : {}),
  };
}
export async function documentWorker<T>(
  input: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const worker = new Worker(
    new URL('./interchange.worker.ts', import.meta.url),
    { type: 'module' },
  );
  return new Promise<T>((resolve, reject) => {
    const finish = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        worker.terminate();
      },
      abort = () => {
        finish();
        reject(
          new Error(
            'Document operation cancelled. Your document was not changed.',
          ),
        );
      },
      timeout = setTimeout(() => {
        finish();
        reject(
          new Error(
            'Document processing exceeded 15 seconds. Use a smaller document; your current document was not changed.',
          ),
        );
      }, 15000);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event) => {
      finish();
      if (event.data.ok) resolve(event.data as T);
      else reject(new Error(event.data.error));
    };
    worker.onerror = () => {
      finish();
      reject(
        new Error(
          'The document could not be processed. Your current document was not changed.',
        ),
      );
    };
    worker.postMessage(input);
  });
}
