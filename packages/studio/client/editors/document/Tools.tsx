import { useEffect, useRef, useState } from 'react';
import {
  ClipboardList,
  FileDown,
  FileUp,
  MessageSquarePlus,
  PanelRightClose,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import {
  Badge,
  Button,
  Field,
  Modal,
  Select,
  Spinner,
  Textarea,
} from '../../components/ui.tsx';
import { api, date, download } from '../../lib.ts';
import type { Artifact, RichNode } from '../../../shared/domain.ts';
import { docText } from '../../../shared/domain.ts';
import {
  documentBlockDefaults,
  type DocumentBlockKind,
} from '../../../shared/document-blocks.ts';
import {
  exportMarkdown,
  type DocumentImport,
  type DocxImage,
} from '../../../shared/document-interchange.ts';
import {
  documentWorker,
  replaceImportAttachments,
  useDocumentWorkspace,
} from './Workspace.tsx';
import type { DocumentSuggestion } from '../../../shared/document-review.ts';
import { DocumentSearchBar } from './Search.tsx';
const names: Record<DocumentBlockKind, string> = {
  calloutBlock: 'Callout',
  columnsBlock: 'Columns',
  questionnaireBlock: 'Questionnaire',
  artifactReferenceBlock: 'Artifact reference',
  evidenceBlock: 'Evidence',
};
export function DocumentTools() {
  const context = useDocumentWorkspace(),
    { editor, artifact, readOnly, onError } = context;
  const [suggestion, setSuggestion] = useState<{
      anchor: string;
      from: number;
      to: number;
      before: string;
      snapshot: string;
    } | null>(null),
    [replacement, setReplacement] = useState(''),
    [comment, setComment] = useState(''),
    [suggestionError, setSuggestionError] = useState(''),
    [saving, setSaving] = useState(false);
  const [pendingImport, setPendingImport] = useState<{
      result: DocumentImport;
      version: number;
      snapshot: string;
      filename: string;
    } | null>(null),
    [processing, setProcessing] = useState(false),
    [importError, setImportError] = useState('');
  const [searchOpen, setSearchOpen] = useState(false),
    [outline, setOutline] = useState<
      { id: string; title: string; level: number }[]
    >([]),
    [tableActive, setTableActive] = useState(false);
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const headings: { id: string; title: string; level: number }[] = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'heading' && node.attrs.id)
          headings.push({
            id: String(node.attrs.id),
            title: node.textContent,
            level: Number(node.attrs.level),
          });
      });
      setOutline(headings);
    };
    const selection = () => setTableActive(editor.isActive('table'));
    const keyboard = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        ['f', 'h'].includes(event.key.toLowerCase()) &&
        (event.target as Element | null)?.closest('.document-editor')
      ) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    update();
    selection();
    editor.on('update', update);
    editor.on('selectionUpdate', selection);
    document.addEventListener('keydown', keyboard);
    return () => {
      editor.off('update', update);
      editor.off('selectionUpdate', selection);
      document.removeEventListener('keydown', keyboard);
    };
  }, [editor]);
  const cancellation = useRef<AbortController | null>(null),
    fileInput = useRef<HTMLInputElement>(null);
  const propose = () => {
    if (!editor || readOnly) return;
    const { from, to, $from, $to } = editor.state.selection;
    if (
      !$from.parent.isTextblock ||
      $from.parent !== $to.parent ||
      !$from.parent.attrs.id
    ) {
      onError(
        'Select text within one paragraph or heading to suggest a replacement.',
      );
      return;
    }
    const before = editor.state.doc.textBetween(from, to, '\n', '\n');
    setSuggestion({
      anchor: String($from.parent.attrs.id),
      from: from - $from.start(),
      to: to - $from.start(),
      before,
      snapshot: JSON.stringify(editor.getJSON()),
    });
    setReplacement(before);
    setComment('');
    setSuggestionError('');
  };
  const submitSuggestion = async () => {
    if (!editor || !suggestion) return;
    setSaving(true);
    setSuggestionError('');
    try {
      if (JSON.stringify(editor.getJSON()) !== suggestion.snapshot)
        throw new Error(
          'The document changed while you composed this suggestion. Your proposed text is retained. Copy it, close this dialog, and select the current passage again.',
        );
      const current = await api<{ artifact: Artifact }>(
        `/artifacts/${artifact.id}`,
      );
      await api(`/artifacts/${artifact.id}/document/suggestions`, 'POST', {
        version: current.artifact.version,
        anchor: suggestion.anchor,
        from: suggestion.from,
        to: suggestion.to,
        before: suggestion.before,
        after: replacement,
        comment,
      });
      setSuggestion(null);
      context.setReviewOpen(true);
      await context.refresh();
    } catch (error) {
      setSuggestionError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const importFile = async (file: File) => {
    if (!editor || readOnly) return;
    const format = file.name.toLowerCase().endsWith('.docx')
      ? 'docx'
      : file.name.toLowerCase().endsWith('.mdx')
        ? 'mdx'
        : /\.(md|markdown)$/i.test(file.name)
          ? 'md'
          : '';
    if (!format) {
      onError(
        'Choose a Markdown (.md), restricted MDX (.mdx), or Word (.docx) document.',
      );
      return;
    }
    if (file.size > (format === 'docx' ? 10_000_000 : 1_000_000)) {
      onError(
        format === 'docx'
          ? 'Word imports are limited to 10 MB.'
          : 'Markdown imports are limited to 1 MB.',
      );
      return;
    }
    cancellation.current?.abort();
    const controller = new AbortController();
    cancellation.current = controller;
    setProcessing(true);
    setImportError('');
    try {
      const snapshot = JSON.stringify(editor.getJSON()),
        current = await api<{ artifact: Artifact }>(
          `/artifacts/${artifact.id}`,
        );
      const input =
        format === 'docx'
          ? { bytes: await file.arrayBuffer() }
          : { source: await file.text() };
      const output = await documentWorker<{ ok: true; result: DocumentImport }>(
        { operation: 'import', format, ...input },
        controller.signal,
      );
      if (!controller.signal.aborted)
        setPendingImport({
          result: output.result,
          version: current.artifact.version,
          snapshot,
          filename: file.name,
        });
    } catch (error) {
      if (!controller.signal.aborted) onError((error as Error).message);
    } finally {
      if (cancellation.current === controller) {
        cancellation.current = null;
        setProcessing(false);
      }
    }
  };
  const applyImport = async () => {
    if (!editor || !pendingImport || readOnly) return;
    setSaving(true);
    setImportError('');
    try {
      if (JSON.stringify(editor.getJSON()) !== pendingImport.snapshot)
        throw new Error(
          'The document changed while this import was open. Your source file is unchanged. Close this dialog and import again against the latest document.',
        );
      const uploads: Record<string, string> = {};
      for (const attachment of pendingImport.result.attachments) {
        const form = new FormData();
        form.append(
          'file',
          new Blob([attachment.bytes.slice().buffer], {
            type: attachment.mime,
          }),
          attachment.name,
        );
        const result = await api<{ url: string }>(
          `/artifacts/${artifact.id}/files`,
          'POST',
          form,
        );
        uploads[attachment.key] = result.url;
      }
      const doc = replaceImportAttachments(pendingImport.result.doc, uploads);
      await api(`/artifacts/${artifact.id}`, 'PATCH', {
        version: pendingImport.version,
        content: { doc },
      });
      setPendingImport(null);
      await context.refresh();
    } catch (error) {
      setImportError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const exportFile = async (format: string) => {
    if (!editor || !format) return;
    try {
      const doc = editor.getJSON() as RichNode;
      if (format === 'md' || format === 'mdx') {
        download(
          artifact.title + '.' + format,
          exportMarkdown(doc, format === 'mdx'),
          'text/markdown',
        );
        return;
      }
      if (format === 'print') {
        window.print();
        return;
      }
      if (format === 'html') {
        setProcessing(true);
        let html = editor.getHTML(),
          total = 0;
        const urls = [
            ...new Set(
              [...html.matchAll(/src="(\/api\/files\/[0-9a-f-]{36})"/g)].map(
                (match) => match[1]!,
              ),
            ),
          ],
          embedded: Record<string, string> = {};
        for (const url of urls) {
          const response = await fetch(url, {
            credentials: 'same-origin',
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok)
            throw new Error(
              'A document image could not be downloaded for this export',
            );
          const blob = await response.blob();
          total += blob.size;
          if (
            total > 16000000 ||
            !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)
          )
            throw new Error(
              'HTML export supports up to 16 MB of uploaded raster images',
            );
          embedded[url] = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () =>
              reject(new Error('An image could not be embedded'));
            reader.readAsDataURL(blob);
          });
        }
        html = html.replace(
          /src="(\/api\/files\/[0-9a-f-]{36})"/g,
          (_, url: string) => 'src="' + embedded[url] + '"',
        );
        download(
          artifact.title + '.html',
          '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:"><title>Exported document</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:75ch;margin:3rem auto;padding:0 1.5rem;color:#24292e}table{border-collapse:collapse;width:100%}td,th{border:1px solid #cdd2c8;padding:.5rem}pre{white-space:pre-wrap}img{max-width:100%}</style></head><body>' +
            html +
            '</body></html>',
          'text/html',
        );
        return;
      }
      if (format === 'docx') {
        setProcessing(true);
        const images: Record<string, DocxImage> = {};
        let bytes = 0;
        const collect = async (node: RichNode): Promise<void> => {
          if (node.type === 'image') {
            const src = String(node.attrs?.src ?? '');
            if (!/^\/api\/files\/[0-9a-f-]{36}$/.test(src))
              throw new Error(
                'Only uploaded project images can be embedded in a Word export',
              );
            if (!images[src]) {
              const response = await fetch(src, { credentials: 'same-origin' });
              if (!response.ok)
                throw new Error(
                  'An image is no longer available. Remove it or restore access before exporting.',
                );
              const blob = await response.blob();
              bytes += blob.size;
              if (bytes > 16_000_000)
                throw new Error(
                  'Embedded images exceed the 16 MB document export limit',
                );
              if (blob.type === 'image/png' || blob.type === 'image/jpeg') {
                const bitmap = await createImageBitmap(blob),
                  width = bitmap.width,
                  height = bitmap.height;
                bitmap.close();
                if (width * height > 40000000)
                  throw new Error('An image is too large for Word export');
                images[src] = {
                  bytes: new Uint8Array(await blob.arrayBuffer()),
                  mime: blob.type,
                  width,
                  height,
                };
              } else {
                const bitmap = await createImageBitmap(blob),
                  width = bitmap.width,
                  height = bitmap.height;
                if (bitmap.width * bitmap.height > 40_000_000) {
                  bitmap.close();
                  throw new Error(
                    'An image is too large to convert for Word export',
                  );
                }
                const canvas = document.createElement('canvas');
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
                bitmap.close();
                const converted = await new Promise<Blob>((resolve, reject) =>
                  canvas.toBlob(
                    (value) =>
                      value
                        ? resolve(value)
                        : reject(new Error('Image conversion failed')),
                    'image/png',
                  ),
                );
                images[src] = {
                  bytes: new Uint8Array(await converted.arrayBuffer()),
                  mime: 'image/png',
                  width,
                  height,
                };
                bytes += converted.size - blob.size;
                if (bytes > 16000000)
                  throw new Error(
                    'Converted images exceed the 16 MB document export limit',
                  );
              }
            }
          }
          for (const child of node.content ?? []) await collect(child);
        };
        await collect(doc);
        const result = await documentWorker<{ ok: true; bytes: Uint8Array }>({
          operation: 'export-docx',
          doc,
          title: artifact.title,
          images,
        });
        download(
          artifact.title + '.docx',
          result.bytes.slice().buffer,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        );
      }
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setProcessing(false);
    }
  };
  return (
    <>
      <div className="document-actions" aria-label="Document tools">
        <label className="document-insert">
          <Plus size={14} />
          <select
            aria-label="Insert planning component"
            disabled={readOnly || !editor}
            value=""
            onChange={(event) => {
              const kind = event.target.value as DocumentBlockKind;
              if (kind)
                editor
                  ?.chain()
                  .focus()
                  .insertContent({
                    type: kind,
                    attrs: {
                      data: structuredClone(documentBlockDefaults[kind]),
                    },
                  })
                  .run();
            }}
          >
            <option value="">Insert component</option>
            {Object.entries(names).map(([kind, label]) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly || !editor}
          onClick={propose}
        >
          <MessageSquarePlus size={14} />
          Suggest edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={context.reviewOpen}
          onClick={() => {
            context.setReviewOpen(!context.reviewOpen);
            void context.refresh();
          }}
        >
          <ClipboardList size={14} />
          Review
          {context.review?.suggestions.filter((s) => s.status === 'pending')
            .length ? (
            <span className="document-count">
              {
                context.review.suggestions.filter((s) => s.status === 'pending')
                  .length
              }
            </span>
          ) : null}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={searchOpen}
          onClick={() => setSearchOpen(!searchOpen)}
        >
          <Search size={14} />
          Find
        </Button>
        <select
          className="document-outline-select"
          aria-label="Document outline"
          value=""
          disabled={!outline.length}
          onChange={(event) => {
            let target = -1;
            editor?.state.doc.descendants((node, position) => {
              if (node.attrs.id === event.target.value) target = position;
            });
            if (target >= 0)
              editor
                ?.chain()
                .focus()
                .setTextSelection(target + 1)
                .scrollIntoView()
                .run();
          }}
        >
          <option value="">Outline</option>
          {outline.map((heading) => (
            <option key={heading.id} value={heading.id}>
              {'— '.repeat(Math.min(5, heading.level - 1))}
              {heading.title || 'Untitled heading'}
            </option>
          ))}
        </select>
        {tableActive && (
          <select
            className="document-outline-select"
            aria-label="Table actions"
            value=""
            disabled={readOnly}
            onChange={(event) => {
              if (!editor || readOnly) return;
              const chain = editor.chain().focus(),
                commands: Record<string, () => unknown> = {
                  rowBefore: () => chain.addRowBefore().run(),
                  rowAfter: () => chain.addRowAfter().run(),
                  columnBefore: () => chain.addColumnBefore().run(),
                  columnAfter: () => chain.addColumnAfter().run(),
                  header: () => chain.toggleHeaderRow().run(),
                  merge: () => chain.mergeCells().run(),
                  split: () => chain.splitCell().run(),
                  deleteRow: () => chain.deleteRow().run(),
                  deleteColumn: () => chain.deleteColumn().run(),
                  deleteTable: () => chain.deleteTable().run(),
                };
              commands[event.target.value]?.();
            }}
          >
            <option value="">Table actions</option>
            <option value="rowBefore">Add row above</option>
            <option value="rowAfter">Add row below</option>
            <option value="columnBefore">Add column left</option>
            <option value="columnAfter">Add column right</option>
            <option value="header">Toggle header row</option>
            <option value="merge">Merge selected cells</option>
            <option value="split">Split selected cell</option>
            <option value="deleteRow">Delete row</option>
            <option value="deleteColumn">Delete column</option>
            <option value="deleteTable">Delete table</option>
          </select>
        )}
        <span className="document-actions-spacer" />
        {processing ? (
          <>
            <Spinner label="Processing document…" />
            {cancellation.current && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => cancellation.current?.abort()}
              >
                Cancel
              </Button>
            )}
          </>
        ) : (
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".md,.markdown,.mdx,.docx"
              hidden
              aria-label="Choose document to import"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importFile(file);
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={readOnly || !editor}
              onClick={() => fileInput.current?.click()}
            >
              <FileUp size={14} />
              Import
            </Button>
            <label className="document-export">
              <FileDown size={14} />
              <select
                value=""
                aria-label="Export document"
                disabled={!editor}
                onChange={(event) => void exportFile(event.target.value)}
              >
                <option value="">Export</option>
                <option value="md">Markdown (.md)</option>
                <option value="mdx">Restricted MDX (.mdx)</option>
                <option value="docx">Word (.docx)</option>
                <option value="html">Readable HTML (.html)</option>
                <option value="print">Print / Save PDF</option>
              </select>
            </label>
          </>
        )}
      </div>
      <DocumentSearchBar
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
      />
      <Modal
        open={!!suggestion}
        onOpenChange={(open) => {
          if (!open && !saving) setSuggestion(null);
        }}
        title="Suggest a text change"
        description="Your proposal stays separate from the shared document until a teammate accepts it."
      >
        <div className="document-dialog-fields">
          <Field label="Current passage">
            <div className="document-quote">
              {suggestion?.before || 'Insertion at the cursor'}
            </div>
          </Field>
          <Field label="Proposed replacement">
            <Textarea
              aria-label="Proposed replacement"
              value={replacement}
              maxLength={20000}
              onChange={(event) => setReplacement(event.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Reason for the change">
            <Textarea
              aria-label="Reason for the change"
              value={comment}
              maxLength={2000}
              onChange={(event) => setComment(event.target.value)}
            />
          </Field>
          {suggestionError && (
            <p className="document-error" role="alert">
              {suggestionError}
            </p>
          )}
          <div className="document-dialog-actions">
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => setSuggestion(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={saving || replacement === suggestion?.before}
              onClick={() => void submitSuggestion()}
            >
              {saving ? 'Saving suggestion…' : 'Save suggestion'}
            </Button>
          </div>
        </div>
      </Modal>
      <Modal
        open={!!pendingImport}
        onOpenChange={(open) => {
          if (!open && !saving) setPendingImport(null);
        }}
        title="Review document import"
        description="Import replaces this document’s content. Previous revisions and the artifact’s discussion, decisions, and evidence remain in History."
      >
        <div className="document-dialog-fields">
          <strong>{pendingImport?.filename}</strong>
          {pendingImport?.result.attachments.length ? (
            <p>
              {pendingImport.result.attachments.length} embedded image
              {pendingImport.result.attachments.length === 1 ? '' : 's'} will be
              attached to this artifact.
            </p>
          ) : null}
          {pendingImport?.result.warnings.map((warning) => (
            <p className="document-import-warning" key={warning}>
              {warning}
            </p>
          ))}
          <pre className="document-import-preview">
            {pendingImport && docText(pendingImport.result.doc).slice(0, 3000)}
          </pre>
          {importError && (
            <p className="document-error" role="alert">
              {importError}
            </p>
          )}
          <div className="document-dialog-actions">
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => setPendingImport(null)}
            >
              Cancel
            </Button>
            <Button disabled={saving} onClick={() => void applyImport()}>
              {saving ? 'Importing…' : 'Replace document'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
export function DocumentReviewPane() {
  const {
    reviewOpen,
    setReviewOpen,
    review,
    reviewError,
    readOnly,
    editor,
    artifact,
    onError,
    onComment,
    refresh,
    earlier,
  } = useDocumentWorkspace();
  const [busy, setBusy] = useState(''),
    [filter, setFilter] = useState<'pending' | 'all'>('pending');
  if (!reviewOpen) return null;
  const suggestions = (review?.suggestions ?? []).filter(
    (row) => filter === 'all' || row.status === 'pending',
  );
  const resolve = async (
    suggestion: DocumentSuggestion,
    action: 'accept' | 'reject',
  ) => {
    setBusy(suggestion.id);
    try {
      const current = await api<{ artifact: Artifact }>(
        `/artifacts/${artifact.id}`,
      );
      await api(
        `/artifacts/${artifact.id}/document/suggestions/${suggestion.id}/resolve`,
        'POST',
        { version: current.artifact.version, action },
      );
      await refresh();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy('');
    }
  };
  const reveal = (anchor: string) => {
    let position = -1;
    editor?.state.doc.descendants((node, pos) => {
      if (node.attrs.id === anchor) position = pos;
    });
    if (position < 0) {
      onError(
        'The original passage is no longer in this document. Its review history is retained.',
      );
      return;
    }
    editor
      ?.chain()
      .focus()
      .setTextSelection(position + 1)
      .scrollIntoView()
      .run();
  };
  return (
    <aside className="document-review-pane" aria-label="Document review">
      <div className="document-review-heading">
        <strong>Document review</strong>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close document review"
          onClick={() => setReviewOpen(false)}
        >
          <PanelRightClose size={16} />
        </Button>
      </div>
      <div className="document-review-controls">
        <Select
          aria-label="Review status filter"
          value={filter}
          onChange={(event) =>
            setFilter(event.target.value as 'pending' | 'all')
          }
        >
          <option value="pending">Pending suggestions</option>
          <option value="all">All review history</option>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh document review"
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} />
        </Button>
      </div>
      {reviewError && (
        <p className="document-error" role="alert">
          Review could not load: {reviewError}
        </p>
      )}
      {!review && !reviewError && <Spinner label="Loading review…" />}
      {review && suggestions.length === 0 && (
        <p className="document-empty">
          {filter === 'pending'
            ? 'No pending suggestions. Select a passage and choose Suggest edit to start a review.'
            : 'No suggestions have been recorded for this document.'}
        </p>
      )}
      {suggestions.map((suggestion) => (
        <article className="document-suggestion" key={suggestion.id}>
          <div>
            <strong>{suggestion.author}</strong>
            <Badge
              tone={
                suggestion.status === 'accepted'
                  ? 'green'
                  : suggestion.status === 'rejected'
                    ? 'neutral'
                    : 'purple'
              }
            >
              {suggestion.status}
            </Badge>
          </div>
          <time dateTime={suggestion.createdAt}>
            {date(suggestion.createdAt)} · v{suggestion.baseVersion}
          </time>
          {suggestion.before && <del>{suggestion.before}</del>}
          {suggestion.after && <ins>{suggestion.after}</ins>}
          {suggestion.comment && <p>{suggestion.comment}</p>}
          <div className="document-suggestion-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => reveal(suggestion.anchor)}
            >
              Find passage
            </Button>
            {!readOnly && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onComment(suggestion.anchor, suggestion.before)}
              >
                Discuss
              </Button>
            )}
            {suggestion.status === 'pending' && !readOnly && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!busy}
                  onClick={() => void resolve(suggestion, 'reject')}
                >
                  Reject
                </Button>
                <Button
                  size="sm"
                  disabled={!!busy}
                  onClick={() => void resolve(suggestion, 'accept')}
                >
                  {busy === suggestion.id ? 'Saving…' : 'Accept'}
                </Button>
              </>
            )}
          </div>
          {suggestion.resolvedBy && (
            <small>
              {suggestion.status === 'accepted' ? 'Accepted' : 'Rejected'} by{' '}
              {suggestion.resolvedBy}
            </small>
          )}
        </article>
      ))}
      {(review?.pagination.suggestions.hasMore ||
        review?.pagination.answers.hasMore) && (
        <Button size="sm" variant="outline" onClick={() => void earlier()}>
          Load earlier review history
        </Button>
      )}
    </aside>
  );
}
