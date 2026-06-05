import React, { useEffect, useState } from 'react';
import { ChevronRight, Database, Table2 } from 'lucide-react';
import {
  hiddenFor,
  withHidden,
  toggleHidden,
  dbVisibilityState,
  type HiddenStore,
} from '../lib/tableVisibility';

interface DbRow {
  name: string;
  open: boolean;
  tables: string[] | null; // null = not loaded yet
  loading: boolean;
}

interface Props {
  profileId: string;
  store: HiddenStore;
  onChange: (next: HiddenStore) => void;
}

// Tree of the connection's databases → tables with a checkbox per node.
// Checked = visible in the schema explorer; unchecked tables are stored in the
// per-connection hidden list (localStorage). Lives inside the connection Edit
// dialog. Requires an active connection (uses listDatabases / listTables).
export const ConnectionTablePrefs: React.FC<Props> = ({ profileId, store, onChange }) => {
  const [dbs, setDbs] = useState<DbRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await window.electronAPI.listDatabases(profileId);
        if (!alive) return;
        if (res.success && res.data) {
          setDbs(res.data.map((d) => ({ name: d.name, open: false, tables: null, loading: false })));
        } else {
          setError(res.error || '데이터베이스 목록을 불러오지 못했습니다.');
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : '데이터베이스 목록을 불러오지 못했습니다.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [profileId]);

  // Load a db's table names once; returns the list so callers can act on it.
  const ensureTables = async (name: string): Promise<string[]> => {
    const existing = dbs.find((d) => d.name === name)?.tables;
    if (existing) return existing;
    setDbs((prev) => prev.map((d) => (d.name === name ? { ...d, loading: true } : d)));
    let names: string[] = [];
    try {
      const res = await window.electronAPI.listTables(profileId, name);
      names = res.success && res.data ? res.data.map((t) => t.name) : [];
    } catch {
      names = [];
    }
    setDbs((prev) => prev.map((d) => (d.name === name ? { ...d, loading: false, tables: names } : d)));
    return names;
  };

  const toggleOpen = (name: string) => {
    const db = dbs.find((d) => d.name === name);
    setDbs((prev) => prev.map((d) => (d.name === name ? { ...d, open: !d.open } : d)));
    if (db && !db.open && db.tables === null) void ensureTables(name);
  };

  const toggleTable = (db: string, table: string) => {
    const cur = hiddenFor(store, profileId, db);
    onChange(withHidden(store, profileId, db, toggleHidden(cur, table)));
  };

  // Top-level db checkbox: reveal everything or hide everything in that db.
  const toggleDbAll = async (name: string) => {
    const tables = await ensureTables(name);
    const allVisible = dbVisibilityState(tables, hiddenFor(store, profileId, name)) === 'all';
    onChange(withHidden(store, profileId, name, allVisible ? [...tables] : []));
  };

  if (loading) return <div className="ctp-status muted">테이블 목록 불러오는 중…</div>;
  if (error) return <div className="ctp-status error">{error}</div>;
  if (dbs.length === 0) return <div className="ctp-status muted">표시할 데이터베이스가 없습니다.</div>;

  return (
    <div className="tree ctp-tree">
      {dbs.map((db) => {
        const hidden = hiddenFor(store, profileId, db.name);
        const state = db.tables ? dbVisibilityState(db.tables, hidden) : hidden.length === 0 ? 'all' : 'some';
        return (
          <div key={db.name} className="tree-node">
            <div className="tree-row">
              <span className={`tree-chevron ${db.open ? 'open' : ''}`} onClick={() => toggleOpen(db.name)}>
                <ChevronRight size={14} />
              </span>
              <input
                type="checkbox"
                className="ctp-check"
                checked={state === 'all'}
                ref={(el) => {
                  if (el) el.indeterminate = state === 'some';
                }}
                onChange={() => void toggleDbAll(db.name)}
                title="이 데이터베이스의 모든 테이블 표시/숨김"
              />
              <span className="tree-icon">
                <Database size={14} />
              </span>
              <span className="tree-label" onClick={() => toggleOpen(db.name)}>
                {db.name}
              </span>
              {db.loading && <span className="spinner" />}
            </div>

            {db.open && db.tables && (
              <div className="tree-children">
                {db.tables.length === 0 ? (
                  <div className="muted" style={{ padding: '4px 8px' }}>
                    No tables
                  </div>
                ) : (
                  db.tables.map((t) => (
                    <label className="tree-row ctp-table-row" key={t}>
                      <span className="tree-chevron" />
                      <input
                        type="checkbox"
                        className="ctp-check"
                        checked={!hidden.includes(t)}
                        onChange={() => toggleTable(db.name, t)}
                      />
                      <span className="tree-icon">
                        <Table2 size={14} />
                      </span>
                      <span className="tree-label">{t}</span>
                    </label>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
