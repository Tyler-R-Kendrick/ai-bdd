import { useCallback, useEffect, useRef, useState } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import {
  investigationBlockSchemas,
  type Investigation,
} from '../../../shared/investigations.ts';
import { isInvestigationBlockKind } from '../../../shared/investigation-blocks.ts';
import { InvestigationView as NativeInvestigationView } from '../../components/investigations/InvestigationPanel.tsx';
import { api } from '../../lib.ts';
import { Badge, Button } from '../../components/ui.tsx';
import { useDocumentWorkspace } from './Workspace.tsx';
import './investigations.css';
export function InvestigationBlockView({ node }: NodeViewProps) {
  const workspace = useDocumentWorkspace(),
    kind = node.type.name;
  const parsed = isInvestigationBlockKind(kind)
    ? investigationBlockSchemas[kind].safeParse(node.attrs.data)
    : null;
  const id = parsed?.success ? parsed.data.investigationId : null;
  const [record, setRecord] = useState<Investigation | null>(null),
    [error, setError] = useState(''),
    request = useRef(0);
  const load = useCallback(async () => {
    if (!id) return;
    const sequence = ++request.current;
    const value = await api<Investigation>(`/investigations/${id}`);
    if (sequence !== request.current) return;
    const parent = value.artifactId === workspace.artifact.id,
      child = value.childArtifactId === workspace.artifact.id;
    if (
      value.projectId !== workspace.artifact.projectId ||
      (kind === 'investigationCard' ? !parent : !(parent || child))
    )
      throw new Error('This investigation does not belong to this artifact');
    setRecord(value);
    setError('');
  }, [id, kind, workspace.artifact.id, workspace.artifact.projectId]);
  useEffect(() => {
    let active = true;
    setRecord(null);
    setError('');
    const refresh = async () => {
      try {
        if (active) await load();
      } catch (e) {
        if (active) {
          setRecord(null);
          setError((e as Error).message);
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      request.current++;
      clearInterval(timer);
    };
  }, [load]);
  const viewData = investigationBlockSchemas.investigationView.safeParse(
    node.attrs.data,
  );
  const viewId = viewData.success ? viewData.data.viewId : null;
  return (
    <NodeViewWrapper
      className="document-investigation"
      contentEditable={false}
      data-investigation-id={id ?? undefined}
    >
      {!parsed?.success ? (
        <p role="alert">Invalid investigation reference.</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : !record ? (
        <p role="status">Loading investigation…</p>
      ) : (
        <>
          <div className="document-investigation-heading">
            <strong>{record.result?.title ?? 'Investigation request'}</strong>
            <Badge
              tone={
                record.status === 'completed'
                  ? 'green'
                  : record.status === 'failed'
                    ? 'red'
                    : 'neutral'
              }
            >
              {record.status}
            </Badge>
          </div>
          {kind === 'investigationCard' ? (
            <>
              <p className="document-investigation-brief">{record.brief}</p>
              <p>
                Source artifact version {record.artifactVersion} · commit{' '}
                <code>{record.sourceCommit.slice(0, 12)}</code>
              </p>
              {record.error && <p role="alert">{record.error}</p>}
              {record.requiredReason && <p>{record.requiredReason}</p>}
              <Button
                size="sm"
                variant="outline"
                disabled={!workspace.onInvestigations}
                onClick={() => workspace.onInvestigations?.(record.id)}
              >
                Open investigation
              </Button>
              {record.status === 'completed' && record.childArtifactId && (
                <a
                  href={`?project=${record.projectId}&artifact=${record.childArtifactId}`}
                >
                  Open published report
                </a>
              )}
            </>
          ) : record.status !== 'completed' || !record.result ? (
            <p>The referenced result has not been published.</p>
          ) : !viewId ||
            !record.result.views.some((view) => view.id === viewId) ? (
            <p role="alert">The published result does not contain this view.</p>
          ) : (
            <NativeInvestigationView
              investigation={record}
              viewId={viewId}
              canWrite={!workspace.readOnly}
              onRefresh={load}
            />
          )}
        </>
      )}
    </NodeViewWrapper>
  );
}
