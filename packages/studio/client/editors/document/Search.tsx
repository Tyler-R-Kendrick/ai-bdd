import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { Button, Input } from '../../components/ui.tsx';
import {
  findDocumentText,
  replaceDocumentMatches,
  type DocumentTextMatch,
} from '../../../shared/document-authoring.ts';
import { useDocumentWorkspace } from './Workspace.tsx';
export const documentSearchMeta = 'studio-document-search';
export const DocumentSearch = Extension.create({
  name: 'documentSearch',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey(documentSearchMeta),
        state: {
          init: () => DecorationSet.empty,
          apply(transaction, previous) {
            const update = transaction.getMeta(documentSearchMeta) as
              | { matches: DocumentTextMatch[]; active: number }
              | undefined;
            return update
              ? DecorationSet.create(
                  transaction.doc,
                  update.matches.map((match, index) =>
                    Decoration.inline(match.from, match.to, {
                      class:
                        index === update.active
                          ? 'document-find-match document-find-match-active'
                          : 'document-find-match',
                    }),
                  ),
                )
              : transaction.docChanged
                ? previous.map(transaction.mapping, transaction.doc)
                : previous;
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});
export function DocumentSearchBar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { editor, readOnly, onError } = useDocumentWorkspace(),
    [query, setQuery] = useState(''),
    [replacement, setReplacement] = useState(''),
    [caseSensitive, setCaseSensitive] = useState(false),
    [matches, setMatches] = useState<DocumentTextMatch[]>([]),
    [truncated, setTruncated] = useState(false),
    [active, setActive] = useState(0),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const result = open
        ? findDocumentText(editor.state.doc, query, caseSensitive)
        : { matches: [], truncated: false };
      setMatches(result.matches);
      setTruncated(result.truncated);
      setActive(0);
      editor.view.dispatch(
        editor.state.tr.setMeta(documentSearchMeta, {
          matches: result.matches,
          active: 0,
        }),
      );
    };
    update();
    editor.on('update', update);
    return () => {
      editor.off('update', update);
    };
  }, [editor, query, caseSensitive, open]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  const next = (direction: number) => {
    if (!editor || !matches.length) return;
    const index = (active + direction + matches.length) % matches.length;
    setActive(index);
    editor.view.dispatch(
      editor.state.tr
        .setMeta(documentSearchMeta, { matches, active: index })
        .setSelection(
          TextSelection.create(
            editor.state.doc,
            matches[index]!.from,
            matches[index]!.to,
          ),
        )
        .scrollIntoView(),
    );
  };
  const replace = (all: boolean) => {
    if (!editor || readOnly || !matches.length || truncated) return;
    try {
      const current = findDocumentText(editor.state.doc, query, caseSensitive);
      if (current.truncated)
        throw new Error(
          'More than 500 matches. Narrow the search before replacing.',
        );
      if (!current.matches.length)
        throw new Error(
          'This text no longer appears in the document. Search again.',
        );
      const targets = all
        ? current.matches
        : [current.matches[Math.min(active, current.matches.length - 1)]!];
      editor.view.dispatch(
        replaceDocumentMatches(editor.state.tr, targets, replacement),
      );
    } catch (error) {
      onError((error as Error).message);
    }
  };
  if (!open) return null;
  return (
    <div
      className="document-search"
      role="search"
      aria-label="Find and replace in document"
    >
      <div>
        <Search size={14} />
        <Input
          ref={input}
          aria-label="Find in document"
          placeholder="Find in document"
          maxLength={500}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              next(event.shiftKey ? -1 : 1);
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
              editor?.commands.focus();
            }
          }}
        />
        <span className="document-search-count" role="status">
          {matches.length
            ? `${active + 1} / ${matches.length}${truncated ? '+' : ''}`
            : query
              ? 'No matches'
              : ''}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Previous match"
          disabled={!matches.length}
          onClick={() => next(-1)}
        >
          <ChevronUp size={15} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Next match"
          disabled={!matches.length}
          onClick={() => next(1)}
        >
          <ChevronDown size={15} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close document search"
          onClick={onClose}
        >
          <X size={15} />
        </Button>
      </div>
      <div>
        <Input
          aria-label="Replace with"
          placeholder="Replace with"
          value={replacement}
          maxLength={20000}
          disabled={readOnly}
          onChange={(event) => setReplacement(event.target.value)}
        />
        <label className="document-search-case">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(event) => setCaseSensitive(event.target.checked)}
          />
          Match case
        </label>
        <Button
          variant="outline"
          size="sm"
          disabled={readOnly || !matches.length || truncated}
          onClick={() => replace(false)}
        >
          Replace
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={readOnly || !matches.length || truncated}
          onClick={() => replace(true)}
        >
          Replace all
        </Button>
      </div>
      {truncated && (
        <p className="document-component-note">
          More than 500 matches. Narrow the search before replacing.
        </p>
      )}
    </div>
  );
}
