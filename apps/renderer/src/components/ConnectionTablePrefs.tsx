import React, { useEffect, useState } from 'react';
import { ChevronRight, Database, Table2 } from 'lucide-react';
import {
  hiddenFor,
  withHidden,
  toggleHidden,
  dbVisibilityState,
  hiddenDatabasesFor,
  withDatabaseHidden,
  withDatabasesHidden,
  initializeDatabaseVisibility,
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
          const names = res.data.map((d) => d.name);
          setDbs(names.map((name) => ({ name, open: false, tables: null, loading: false })));
          const nextStore = initializeDatabaseVisibility(store, profileId, names);
          if (nextStore !== store) onChange(nextStore);
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
    // Migrate the old top-level "hide all tables" preference to the explicit
    // database visibility setting so selected schemas disappear from the tree.
    if (names.length > 0 && dbVisibilityState(names, hiddenFor(store, profileId, name)) === 'none' && !hiddenDatabasesFor(store, profileId).includes(name)) {
      onChange(withDatabaseHidden(store, profileId, name, true));
    }
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

  const toggleAllDatabases = () => {
    const names = dbs.map((db) => db.name);
    const state = dbVisibilityState(names, hiddenDatabasesFor(store, profileId));
    // Clicking an unchecked (none/some) checkbox reveals all schemas; clicking
    // a fully checked checkbox hides them all.
    onChange(withDatabasesHidden(store, profileId, names, state === 'all'));
  };

  // Top-level db checkbox: reveal everything or hide everything in that db.
  const toggleDbAll = async (name: string) => {
    const tables = await ensureTables(name);
    const allVisible = !hiddenDatabasesFor(store, profileId).includes(name)
      && dbVisibilityState(tables, hiddenFor(store, profileId, name)) === 'all';
    const nextStore = allVisible
      ? withHidden(withDatabaseHidden(store, profileId, name, true), profileId, name, tables)
      : withHidden(withDatabaseHidden(store, profileId, name, false), profileId, name, []);
    onChange(nextStore);
  };

  if (loading) return <div className="ctp-status muted">테이블 목록 불러오는 중…</div>;
  if (error) return <div className="ctp-status error">{error}</div>;
  if (dbs.length === 0) return <div className="ctp-status muted">표시할 데이터베이스가 없습니다.</div>;

  const databaseNames = dbs.map((db) => db.name);
  const databaseState = dbVisibilityState(databaseNames, hiddenDatabasesFor(store, profileId));

  return (
    <>
      <div className="ctp-bulk-row">
        <label className="ctp-bulk-check">
          <input
            type="checkbox"
            data-testid="schema-visibility-toggle-all"
            checked={databaseState === 'all'}
            ref={(el) => {
              if (el) el.indeterminate = databaseState === 'some';
            }}
            onChange={toggleAllDatabases}
            title="전체 스키마 선택/해제"
          />
          <span>전체 스키마 표시</span>
        </label>
        <span className="ctp-bulk-state">
          {databaseState === 'all' ? '전체 선택' : databaseState === 'none' ? '전체 제외' : '일부 선택'}
        </span>
      </div>
      <div className="tree ctp-tree">
      {dbs.map((db) => {
        const hidden = hiddenFor(store, profileId, db.name);
        const databaseHidden = hiddenDatabasesFor(store, profileId).includes(db.name);
        const state = databaseHidden ? 'none' : db.tables ? dbVisibilityState(db.tables, hidden) : hidden.length === 0 ? 'all' : 'some';
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
                title="이 스키마를 왼쪽 트리에 표시/숨김"
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
    </>
  );
};
