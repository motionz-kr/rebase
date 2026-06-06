import React, { useState } from 'react';
import { X, AlertTriangle, Save } from 'lucide-react';

interface Props {
  profileId: string;
  database: string;
  collection: string;
  /** Insert mode when undefined; replace mode (pre-filled) when set. */
  mode: 'insert' | 'replace';
  /** Pre-filled document JSON (replace mode) or a starter (insert mode). */
  initialJson: string;
  /** _id argument for replace (ext-JSON scalar string). */
  replaceId?: string;
  onClose: () => void;
  onApplied: () => void;
}

export const MongoDocEditor: React.FC<Props> = ({
  profileId,
  database,
  collection,
  mode,
  initialJson,
  replaceId,
  onClose,
  onApplied,
}) => {
  const [text, setText] = useState(initialJson);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    // Validate JSON before sending.
    try {
      JSON.parse(text);
    } catch (e) {
      setError(`잘못된 JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === 'insert'
          ? await window.electronAPI.mongoInsert(profileId, database, collection, text)
          : await window.electronAPI.mongoReplace(profileId, database, collection, replaceId ?? '', text);
      if (res.success) {
        onApplied();
        onClose();
      } else {
        setError(res.error || '저장 실패');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '저장 중 오류');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>
            {mode === 'insert' ? '문서 추가' : '문서 편집'} · <span className="mono">{collection}</span>
          </h3>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </div>

        {error && (
          <div className="alert error">
            <AlertTriangle size={14} />
            <span>{error}</span>
          </div>
        )}

        <textarea
          className="mono mongo-doc-editor"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          autoFocus
        />

        <div className="modal-foot">
          <button className="btn btn-secondary" onClick={onClose}>
            취소
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            <Save size={13} /> {mode === 'insert' ? '추가' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
};
