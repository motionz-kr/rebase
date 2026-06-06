import React from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { flattenDocument, columnsFor, formatExtJson } from '../lib/mongoDoc';

interface Props {
  documents: string[];
  view: 'grid' | 'json';
  /** When provided, each document gets 편집/삭제 actions. */
  onEdit?: (doc: string) => void;
  onDelete?: (doc: string) => void;
}

/**
 * Shared display for a list of Extended-JSON document strings. Renders either a
 * column grid (top-level fields) or pretty-printed JSON, with optional per-row
 * edit/delete actions.
 */
export const MongoResultView: React.FC<Props> = ({ documents, view, onEdit, onDelete }) => {
  const hasActions = Boolean(onEdit || onDelete);

  if (documents.length === 0) {
    return <div className="muted mongo-empty">문서가 없습니다.</div>;
  }

  if (view === 'json') {
    return (
      <div className="mongo-json-list">
        {documents.map((doc, i) => (
          <div className="mongo-json-doc" key={i}>
            {hasActions && (
              <div className="mongo-doc-actions">
                {onEdit && (
                  <button className="btn btn-ghost btn-xs" title="편집" onClick={() => onEdit(doc)}>
                    <Pencil size={13} />
                  </button>
                )}
                {onDelete && (
                  <button className="btn btn-ghost btn-xs" title="삭제" onClick={() => onDelete(doc)}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            )}
            <pre className="mono">{formatExtJson(doc)}</pre>
          </div>
        ))}
      </div>
    );
  }

  const columns = columnsFor(documents);

  return (
    <div className="mongo-grid-wrap">
      <table className="mongo-grid">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col}>{col}</th>
            ))}
            {hasActions && <th className="mongo-grid-actions-col" />}
          </tr>
        </thead>
        <tbody>
          {documents.map((doc, i) => {
            const flat = flattenDocument(doc);
            return (
              <tr key={i}>
                {columns.map((col) => (
                  <td key={col} className="mono" title={flat[col]}>
                    {col in flat ? flat[col] : ''}
                  </td>
                ))}
                {hasActions && (
                  <td className="mongo-grid-actions-col">
                    {onEdit && (
                      <button className="btn btn-ghost btn-xs" title="편집" onClick={() => onEdit(doc)}>
                        <Pencil size={13} />
                      </button>
                    )}
                    {onDelete && (
                      <button className="btn btn-ghost btn-xs" title="삭제" onClick={() => onDelete(doc)}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
