import React, { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { Table2, Columns3, KeyRound, FunctionSquare } from 'lucide-react';
import {
  getSuggestions,
  filterByPrefix,
  currentWord,
  currentClause,
  dotPrefix,
  type SchemaInfo,
  type SqlSuggestion,
  type SuggestionKind,
} from '../lib/sqlCompletion';

interface Props {
  editor: Monaco.editor.IStandaloneCodeEditor | null;
  monaco: typeof Monaco | null;
  schema: SchemaInfo;
}

const MAX_ITEMS = 60;

function KindIcon({ kind }: { kind: SuggestionKind }) {
  if (kind === 'table') return <Table2 size={13} />;
  if (kind === 'column') return <Columns3 size={13} />;
  if (kind === 'function') return <FunctionSquare size={13} />;
  return <KeyRound size={13} />;
}

/**
 * A SQL autocomplete dropdown rendered as plain React DOM (not Monaco's overlay
 * widget). Monaco's suggest widget fails to paint text in some software-GPU
 * environments; a normal in-flow element renders reliably.
 */
export const SqlAutocomplete: React.FC<Props> = ({ editor, monaco, schema }) => {
  const [items, setItems] = useState<SqlSuggestion[]>([]);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [visible, setVisible] = useState(false);

  // Latest-value refs so the once-registered key handler reads current state.
  const visibleRef = useRef(false);
  const itemsRef = useRef<SqlSuggestion[]>([]);
  const activeRef = useRef(0);
  const wordRef = useRef('');
  const listRef = useRef<HTMLDivElement>(null);
  // Mirror the latest values into refs (read by the once-registered key handler).
  useEffect(() => {
    visibleRef.current = visible;
    itemsRef.current = items;
    activeRef.current = active;
  });

  const accept = (item: SqlSuggestion | undefined) => {
    if (!editor || !monaco || !item) return;
    const position = editor.getPosition();
    if (!position) return;
    const word = wordRef.current;
    const range = new monaco.Range(
      position.lineNumber,
      position.column - word.length,
      position.lineNumber,
      position.column
    );
    editor.executeEdits('sql-autocomplete', [{ range, text: item.insertText, forceMoveMarkers: true }]);
    editor.focus();
    setVisible(false);
  };

  useEffect(() => {
    if (!editor || !monaco) return;

    const recompute = () => {
      const model = editor.getModel();
      const position = editor.getPosition();
      if (!model || !position) return setVisible(false);

      const textBefore = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const word = currentWord(textBefore);
      wordRef.current = word;

      const filtered = filterByPrefix(getSuggestions(schema, textBefore), word);
      const clause = currentClause(textBefore);
      const showEmpty = clause === 'from' || clause === 'join' || !!dotPrefix(textBefore);
      if (filtered.length === 0 || (word.length === 0 && !showEmpty)) return setVisible(false);

      const vis = editor.getScrolledVisiblePosition(position);
      if (!vis) return setVisible(false);

      setPos({ top: vis.top + vis.height, left: vis.left });
      setItems(filtered.slice(0, MAX_ITEMS));
      setActive(0);
      setVisible(true);
    };

    const onKey = (e: Monaco.IKeyboardEvent) => {
      if (!visibleRef.current) return;
      const KC = monaco.KeyCode;
      // Cmd/Ctrl+Enter runs the query — close the dropdown and let the editor's
      // run command fire (do NOT preventDefault/stopPropagation here).
      if (e.keyCode === KC.Enter && (e.ctrlKey || e.metaKey)) {
        setVisible(false);
        return;
      }
      const n = itemsRef.current.length;
      if (e.keyCode === KC.DownArrow) {
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => (a + 1) % n);
      } else if (e.keyCode === KC.UpArrow) {
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => (a - 1 + n) % n);
      } else if ((e.keyCode === KC.Enter && !e.ctrlKey && !e.metaKey) || e.keyCode === KC.Tab) {
        e.preventDefault();
        e.stopPropagation();
        accept(itemsRef.current[activeRef.current]);
      } else if (e.keyCode === KC.Escape) {
        e.preventDefault();
        e.stopPropagation();
        setVisible(false);
      }
    };

    const subs = [
      editor.onDidChangeModelContent(recompute),
      editor.onDidChangeCursorPosition((e) => {
        // recompute as the user types; explicit/keyboard navigation moves recompute too
        if (e.reason !== monaco.editor.CursorChangeReason.NotSet) recompute();
      }),
      editor.onKeyDown(onKey),
      editor.onDidBlurEditorText(() => setVisible(false)),
      editor.onDidScrollChange(() => setVisible(false)),
    ];
    return () => subs.forEach((s) => s.dispose());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, monaco, schema]);

  // Keep the active item scrolled into view.
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!visible || !pos || items.length === 0) return null;

  return (
    <div className="sql-ac" style={{ top: pos.top, left: pos.left }} ref={listRef}>
      {items.map((s, i) => (
        <div
          key={s.kind + ':' + s.label + ':' + i}
          className={`sql-ac-item ${i === active ? 'active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault(); // keep editor focus
            accept(s);
          }}
          onMouseEnter={() => setActive(i)}
        >
          <span className={`sql-ac-icon ${s.kind}`}>
            <KindIcon kind={s.kind} />
          </span>
          <span className="sql-ac-label">{s.label}</span>
          {s.detail && <span className="sql-ac-detail">{s.detail}</span>}
        </div>
      ))}
    </div>
  );
};
