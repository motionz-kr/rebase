import React, { useState, useEffect } from 'react';
import {
  KeyRound,
  RefreshCw,
  AlertTriangle,
  Database,
  Pencil,
  Trash2,
  Clock,
  Check,
  X,
  TextCursorInput,
} from 'lucide-react';
import type { RedisValueInfo } from '../global';

interface RedisValueInspectorProps {
  profileId: string;
  redisKey: string | null;
  /** Change the selected key (e.g. after a rename, or clear after a delete). */
  onSelectKey?: (key: string | null) => void;
  /** Ask the parent to re-scan the keyspace list (after rename/delete). */
  onRefresh?: () => void;
}

export const RedisValueInspector: React.FC<RedisValueInspectorProps> = ({
  profileId,
  redisKey,
  onSelectKey,
  onRefresh,
}) => {
  const [info, setInfo] = useState<RedisValueInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mutation UI state
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState(false);
  const [draftValue, setDraftValue] = useState('');
  const [editingTtl, setEditingTtl] = useState(false);
  const [draftTtl, setDraftTtl] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [draftKey, setDraftKey] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset all transient editing state whenever the selected key changes.
  const resetEditing = () => {
    setEditingValue(false);
    setEditingTtl(false);
    setRenaming(false);
    setConfirmDelete(false);
    setActionError(null);
  };

  useEffect(() => {
    let ignore = false;
    resetEditing();
    if (redisKey) {
      loadValue(() => ignore);
    } else {
      setInfo(null);
    }
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, redisKey]);

  const loadValue = async (isStale?: () => boolean) => {
    if (!redisKey) return;
    setLoading(true);
    setError(null);
    try {
      const res = await window.electronAPI.redisValue(profileId, redisKey);
      if (isStale?.()) return;
      if (res.success && res.data) {
        setInfo(res.data);
      } else {
        setError(res.error || 'Failed to inspect key value');
      }
    } catch (e: any) {
      if (isStale?.()) return;
      setError(e.message || 'Error occurred inspecting value');
    } finally {
      if (!isStale?.()) setLoading(false);
    }
  };

  if (!redisKey) {
    return (
      <div className="empty-state full">
        <div className="es-icon">
          <Database size={22} />
        </div>
        <h2>Redis inspector</h2>
        <p>Select a key from the sidebar to inspect its type, TTL, and value.</p>
      </div>
    );
  }

  const ttlText = (ttl: number) =>
    ttl === -1 ? 'No expiry' : ttl === -2 ? 'Expired / missing' : `${ttl}s`;

  // --- Mutations -----------------------------------------------------------

  const saveValue = async () => {
    if (!redisKey) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await window.electronAPI.redisSet(profileId, redisKey, draftValue);
      if (res.success) {
        setEditingValue(false);
        await loadValue();
      } else {
        setActionError(res.error || 'Failed to set value');
      }
    } catch (e: any) {
      setActionError(e.message || 'Error setting value');
    } finally {
      setBusy(false);
    }
  };

  const applyTtl = async (seconds: number) => {
    if (!redisKey) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await window.electronAPI.redisExpire(profileId, redisKey, seconds);
      if (res.success) {
        setEditingTtl(false);
        await loadValue();
      } else {
        setActionError(res.error || 'Failed to update TTL');
      }
    } catch (e: any) {
      setActionError(e.message || 'Error updating TTL');
    } finally {
      setBusy(false);
    }
  };

  const doRename = async () => {
    if (!redisKey) return;
    const next = draftKey.trim();
    if (!next || next === redisKey) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const res = await window.electronAPI.redisRename(profileId, redisKey, next);
      if (res.success) {
        setRenaming(false);
        onSelectKey?.(next);
        onRefresh?.();
      } else {
        setActionError(res.error || 'Failed to rename key');
      }
    } catch (e: any) {
      setActionError(e.message || 'Error renaming key');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!redisKey) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await window.electronAPI.redisDelete(profileId, redisKey);
      if (res.success) {
        setConfirmDelete(false);
        onSelectKey?.(null);
        onRefresh?.();
      } else {
        setActionError(res.error || 'Failed to delete key');
      }
    } catch (e: any) {
      setActionError(e.message || 'Error deleting key');
    } finally {
      setBusy(false);
    }
  };

  // --- Value rendering -----------------------------------------------------

  let content: React.ReactNode = null;
  if (info && info.exists !== false) {
    if (editingValue && info.type === 'string') {
      content = (
        <div className="value-edit">
          <textarea
            className="value-editor"
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            spellCheck={false}
            autoFocus
          />
          <div className="value-edit-actions">
            <button className="btn btn-primary btn-sm" onClick={saveValue} disabled={busy}>
              <Check size={13} /> Save
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setEditingValue(false)}
              disabled={busy}
            >
              <X size={13} /> Cancel
            </button>
          </div>
        </div>
      );
    } else {
      try {
        if (info.type === 'hash') {
          const obj = JSON.parse(info.value);
          content = (
            <table className="kv-table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(obj).map(([f, v]) => (
                  <tr key={f}>
                    <td className="dim">{f}</td>
                    <td>{String(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        } else if (info.type === 'zset') {
          const list = JSON.parse(info.value) as Array<{ member: string; score: number }>;
          content = (
            <table className="kv-table">
              <thead>
                <tr>
                  <th>Score</th>
                  <th>Member</th>
                </tr>
              </thead>
              <tbody>
                {list.map((item, idx) => (
                  <tr key={idx}>
                    <td className="accent">{item.score}</td>
                    <td>{item.member}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        } else if (info.type === 'list' || info.type === 'set') {
          const list = JSON.parse(info.value) as string[];
          content = (
            <table className="kv-table">
              <thead>
                <tr>
                  <th>{info.type === 'list' ? 'Index' : '#'}</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {list.map((item, idx) => (
                  <tr key={idx}>
                    <td className="dim">{idx}</td>
                    <td>{item}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        } else {
          content = <div className="value-raw">{info.value}</div>;
        }
      } catch {
        content = <div className="value-raw">{info.value}</div>;
      }
    }
  }

  const missing = info && info.exists === false;
  const isString = info?.type === 'string';

  return (
    <div className="inspector">
      <div className="inspector-head">
        <div className="inspector-key">
          <span className="tree-icon">
            <KeyRound size={15} />
          </span>
          <h2>{redisKey}</h2>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => loadValue()} disabled={loading || busy}>
          <RefreshCw size={13} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </div>

      <div className="inspector-body">
        {loading && (
          <div className="load-center">
            <span className="spinner lg" /> Loading value…
          </div>
        )}

        {error && (
          <div className="alert error">
            <AlertTriangle size={14} />
            <span>{error}</span>
          </div>
        )}

        {!loading && missing && (
          <div className="alert error">
            <AlertTriangle size={14} />
            <span>This key does not exist (it may have expired).</span>
          </div>
        )}

        {!loading && info && info.exists !== false && (
          <>
            <div className="meta-row">
              <div className="meta-card">
                <span className="meta-label">Type</span>
                <span className="meta-value">
                  <span className="badge type">{info.type.toUpperCase()}</span>
                </span>
              </div>
              <div className="meta-card">
                <span className="meta-label">TTL</span>
                {editingTtl ? (
                  <span className="meta-value ttl-edit">
                    <input
                      type="number"
                      min={1}
                      className="ttl-input"
                      value={draftTtl}
                      onChange={(e) => setDraftTtl(e.target.value)}
                      placeholder="seconds"
                      autoFocus
                    />
                    <button
                      className="btn btn-primary btn-xs"
                      disabled={busy || !draftTtl || Number(draftTtl) <= 0}
                      onClick={() => applyTtl(Number(draftTtl))}
                    >
                      <Check size={12} />
                    </button>
                    <button
                      className="btn btn-secondary btn-xs"
                      disabled={busy}
                      onClick={() => applyTtl(-1)}
                      title="Remove expiry (PERSIST)"
                    >
                      Persist
                    </button>
                    <button className="btn btn-secondary btn-xs" disabled={busy} onClick={() => setEditingTtl(false)}>
                      <X size={12} />
                    </button>
                  </span>
                ) : (
                  <span className="meta-value">
                    {ttlText(info.ttl)}
                    <button
                      className="icon-btn"
                      title="Edit TTL"
                      onClick={() => {
                        setDraftTtl(info.ttl > 0 ? String(info.ttl) : '');
                        setEditingTtl(true);
                      }}
                    >
                      <Clock size={13} />
                    </button>
                  </span>
                )}
              </div>
            </div>

            {/* Key-level actions */}
            <div className="key-actions">
              {renaming ? (
                <div className="rename-row">
                  <TextCursorInput size={14} />
                  <input
                    className="rename-input"
                    value={draftKey}
                    onChange={(e) => setDraftKey(e.target.value)}
                    placeholder="New key name"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') doRename();
                      if (e.key === 'Escape') setRenaming(false);
                    }}
                  />
                  <button className="btn btn-primary btn-sm" onClick={doRename} disabled={busy}>
                    <Check size={13} /> Rename
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setRenaming(false)} disabled={busy}>
                    <X size={13} />
                  </button>
                </div>
              ) : confirmDelete ? (
                <div className="confirm-row">
                  <AlertTriangle size={14} />
                  <span>
                    Delete <code>{redisKey}</code>? This cannot be undone.
                  </span>
                  <button className="btn btn-danger btn-sm" onClick={doDelete} disabled={busy}>
                    <Trash2 size={13} /> Delete
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setConfirmDelete(false)} disabled={busy}>
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  {isString && !editingValue && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        setDraftValue(info.value);
                        setEditingValue(true);
                      }}
                    >
                      <Pencil size={13} /> Edit value
                    </button>
                  )}
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setDraftKey(redisKey);
                      setRenaming(true);
                    }}
                  >
                    <TextCursorInput size={13} /> Rename
                  </button>
                  <button className="btn btn-danger-ghost btn-sm" onClick={() => setConfirmDelete(true)}>
                    <Trash2 size={13} /> Delete
                  </button>
                </>
              )}
            </div>

            {actionError && (
              <div className="alert error">
                <AlertTriangle size={14} />
                <span>{actionError}</span>
              </div>
            )}

            <div className="value-block-head">
              <h3>Value{info.type !== 'string' ? ' (tabular)' : ''}</h3>
              {!isString && (
                <span className="status-pill" title="Inline value editing is available for string keys">
                  <AlertTriangle size={13} /> Read-only type
                </span>
              )}
            </div>

            {info.truncated && (
              <div className="alert" style={{ background: 'var(--amber-soft)', color: 'var(--amber)', marginBottom: 10 }}>
                <AlertTriangle size={14} />
                <span>Preview truncated to the first 100 elements.</span>
              </div>
            )}

            {content}
          </>
        )}
      </div>
    </div>
  );
};
