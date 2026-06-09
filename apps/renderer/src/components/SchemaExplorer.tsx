import React, { useState, useEffect } from 'react';
import { ChevronRight, Database, Table2, KeyRound, AlertTriangle, FileCode, Copy, X, Pencil, PlusSquare, Eraser, Trash2, Type, FilePlus, Upload, Eye, Network, RefreshCw } from 'lucide-react';
import { TableEditDialog } from './TableEditDialog';
import { TableActionDialog, type TableAction } from './TableActionDialog';
import { CreateTableDialog } from './CreateTableDialog';
import { CsvImportDialog } from './CsvImportDialog';
import { IndexManagerDialog } from './IndexManagerDialog';
import { buildRecentRowsQuery } from '../lib/recentQuery';
import { hiddenFor, hiddenCount, type HiddenStore } from '../lib/tableVisibility';
import type { Driver } from '../lib/ddlBuilder';
import type { ColumnInfo } from '../global';

interface SchemaExplorerProps {
  profileId: string;
  driver: 'mysql' | 'postgres' | 'redis' | 'sqlite' | 'sqlserver';
  hiddenStore: HiddenStore;
  onDisconnect: () => void;
  onSchemaChanged?: () => void;
  onOpenTableData?: (db: string, table: string) => void;
  onRunQuery?: (sql: string) => void;
  onOpenErDiagram?: (db: string) => void;
}

interface TableNode {
  name: string;
  columns?: ColumnInfo[];
  isOpen: boolean;
  isLoading: boolean;
}

interface DatabaseNode {
  name: string;
  tables?: TableNode[];
  views?: string[];
  isOpen: boolean;
  isLoading: boolean;
}

export const SchemaExplorer: React.FC<SchemaExplorerProps> = ({ profileId, driver, hiddenStore, onSchemaChanged, onOpenTableData, onRunQuery, onOpenErDiagram }) => {
  const [databases, setDatabases] = useState<DatabaseNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Right-click context menu + DDL viewer
  const [menu, setMenu] = useState<{ x: number; y: number; db: string; table: string } | null>(null);
  const [ddl, setDdl] = useState<{ table: string; text: string; loading: boolean; error: string | null } | null>(null);
  const [edit, setEdit] = useState<{ db: string; table: string; focusNewColumn: boolean } | null>(null);
  const [tableAction, setTableAction] = useState<{ db: string; table: string; action: TableAction } | null>(null);
  const [csvImport, setCsvImport] = useState<{ db: string; table: string } | null>(null);
  const [indexMgr, setIndexMgr] = useState<{ db: string; table: string } | null>(null);
  const [dbMenu, setDbMenu] = useState<{ x: number; y: number; db: string } | null>(null);
  const [create, setCreate] = useState<{ db: string } | null>(null);
  const [viewMenu, setViewMenu] = useState<{ x: number; y: number; db: string; view: string } | null>(null);

  // Close the context menu on any outside click or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const openMenu = (e: React.MouseEvent, dbName: string, table: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, db: dbName, table });
  };

  // Close the database context menu on any outside click or Escape.
  useEffect(() => {
    if (!dbMenu) return;
    const close = () => setDbMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDbMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [dbMenu]);

  const openDbMenu = (e: React.MouseEvent, dbName: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDbMenu({ x: e.clientX, y: e.clientY, db: dbName });
  };

  // Close the view context menu on any outside click or Escape.
  useEffect(() => {
    if (!viewMenu) return;
    const close = () => setViewMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [viewMenu]);

  const openViewMenu = (e: React.MouseEvent, db: string, view: string) => {
    e.preventDefault();
    e.stopPropagation();
    setViewMenu({ x: e.clientX, y: e.clientY, db, view });
  };

  // One-click "recent rows": order by the primary key descending (newest first)
  // when there is a single-column PK, otherwise an unordered LIMIT.
  const runRecentRows = async (dbName: string, table: string) => {
    setMenu(null);
    let pk: string | null = null;
    try {
      const res = await window.electronAPI.describeTable(profileId, dbName, table);
      if (res.success && res.data) {
        const pks = res.data.columns.filter((c) => c.primaryKey);
        if (pks.length === 1) pk = pks[0].name;
      }
    } catch {
      /* fall back to no ORDER BY */
    }
    onRunQuery?.(buildRecentRowsQuery(driver as Driver, table, pk, 500));
  };

  const showDDL = async (dbName: string, table: string) => {
    setMenu(null);
    setDdl({ table, text: '', loading: true, error: null });
    try {
      const res = await window.electronAPI.getTableDDL(profileId, dbName, table);
      if (res.success && res.data) {
        setDdl({ table, text: res.data.ddl, loading: false, error: null });
      } else {
        setDdl({ table, text: '', loading: false, error: res.error || 'Failed to load DDL' });
      }
    } catch (e) {
      setDdl({ table, text: '', loading: false, error: e instanceof Error ? e.message : 'Error loading DDL' });
    }
  };

  const showViewDDL = async (dbName: string, view: string) => {
    setViewMenu(null);
    setDdl({ table: view, text: '', loading: true, error: null });
    try {
      const res = await window.electronAPI.getViewDDL(profileId, dbName, view);
      if (res.success && res.data) setDdl({ table: view, text: res.data.ddl, loading: false, error: null });
      else setDdl({ table: view, text: '', loading: false, error: res.error || 'Failed to load view DDL' });
    } catch (e) {
      setDdl({ table: view, text: '', loading: false, error: e instanceof Error ? e.message : 'Error loading view DDL' });
    }
  };

  const copyDDL = () => {
    if (ddl?.text) navigator.clipboard.writeText(ddl.text);
  };

  const refreshAfterDdl = async (dbName: string) => {
    onSchemaChanged?.();
    let tables: TableNode[] | undefined;
    try {
      const res = await window.electronAPI.listTables(profileId, dbName);
      if (res.success && res.data) {
        tables = res.data.map((t) => ({ name: t.name, isOpen: false, isLoading: false }));
      }
    } catch (err) {
      console.error(err);
    }
    setDatabases((prev) =>
      prev.map((db) => (db.name === dbName ? { ...db, isOpen: true, isLoading: false, tables: tables ?? db.tables } : db))
    );
  };

  // Manual refresh of a single database's tables + views (e.g. after running
  // CREATE TABLE in the SQL editor, which doesn't auto-refresh the tree).
  const refreshDatabase = async (dbName: string) => {
    onSchemaChanged?.();
    setDatabases((prev) => prev.map((db) => (db.name === dbName ? { ...db, isLoading: true } : db)));
    let tables: TableNode[] | undefined;
    let views: string[] | undefined;
    try {
      const [tRes, vRes] = await Promise.all([
        window.electronAPI.listTables(profileId, dbName),
        window.electronAPI.listViews(profileId, dbName),
      ]);
      if (tRes.success && tRes.data) tables = tRes.data.map((t) => ({ name: t.name, isOpen: false, isLoading: false }));
      if (vRes.success && vRes.data) views = vRes.data.map((v) => v.name);
    } catch (err) {
      console.error(err);
    }
    setDatabases((prev) =>
      prev.map((db) =>
        db.name === dbName ? { ...db, isOpen: true, isLoading: false, tables: tables ?? db.tables, views: views ?? db.views } : db,
      ),
    );
  };

  // Connection-wide refresh: re-list databases (so newly-created ones appear)
  // while preserving which databases were expanded, re-fetching their contents.
  const refreshAll = async () => {
    setRefreshing(true);
    onSchemaChanged?.();
    const openNames = new Set(databases.filter((d) => d.isOpen).map((d) => d.name));
    try {
      const res = await window.electronAPI.listDatabases(profileId);
      if (!res.success || !res.data) {
        setError(res.error || 'Failed to list databases');
        return;
      }
      const base: DatabaseNode[] = res.data.map((db) => ({ name: db.name, isOpen: openNames.has(db.name), isLoading: false }));
      await Promise.all(
        base.map(async (node) => {
          if (!node.isOpen) return;
          try {
            const [tRes, vRes] = await Promise.all([
              window.electronAPI.listTables(profileId, node.name),
              window.electronAPI.listViews(profileId, node.name),
            ]);
            if (tRes.success && tRes.data) node.tables = tRes.data.map((t) => ({ name: t.name, isOpen: false, isLoading: false }));
            if (vRes.success && vRes.data) node.views = vRes.data.map((v) => v.name);
          } catch (err) {
            console.error(err);
          }
        }),
      );
      setError(null);
      setDatabases(base);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'An error occurred while refreshing');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (driver === 'redis') return;
    // Intentional load-on-mount; loadDatabases manages its own state.
    // eslint-disable-next-line react-hooks/immutability
    loadDatabases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, driver]);

  const loadDatabases = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.electronAPI.listDatabases(profileId);
      if (res.success && res.data) {
        setDatabases(res.data.map((db) => ({ name: db.name, isOpen: false, isLoading: false })));
      } else {
        setError(res.error || 'Failed to list databases');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'An error occurred while fetching databases');
    } finally {
      setLoading(false);
    }
  };

  const toggleDatabase = async (dbName: string) => {
    const target = databases.find((d) => d.name === dbName);
    if (!target) return;
    const nextIsOpen = !target.isOpen;

    if (nextIsOpen && !target.tables) {
      setDatabases((prev) =>
        prev.map((db) => (db.name === dbName ? { ...db, isOpen: true, isLoading: true } : db))
      );

      let tables: TableNode[] | undefined;
      let views: string[] = [];
      try {
        const [tRes, vRes] = await Promise.all([
          window.electronAPI.listTables(profileId, dbName),
          window.electronAPI.listViews(profileId, dbName),
        ]);
        if (tRes.success && tRes.data) {
          tables = tRes.data.map((t) => ({ name: t.name, isOpen: false, isLoading: false }));
        }
        if (vRes.success && vRes.data) {
          views = vRes.data.map((v) => v.name);
        }
      } catch (err) {
        console.error(err);
      }

      setDatabases((prev) =>
        prev.map((db) =>
          db.name === dbName ? { ...db, isOpen: true, isLoading: false, tables: tables ?? db.tables, views } : db
        )
      );
      return;
    }

    setDatabases((prev) => prev.map((db) => (db.name === dbName ? { ...db, isOpen: nextIsOpen } : db)));
  };

  const toggleTable = async (dbName: string, tableName: string) => {
    const db = databases.find((d) => d.name === dbName);
    const target = db?.tables?.find((t) => t.name === tableName);
    if (!db || !target) return;
    const nextIsOpen = !target.isOpen;

    const patchTable = (patch: Partial<TableNode>) =>
      setDatabases((prev) =>
        prev.map((d) =>
          d.name === dbName && d.tables
            ? { ...d, tables: d.tables.map((t) => (t.name === tableName ? { ...t, ...patch } : t)) }
            : d
        )
      );

    if (nextIsOpen && !target.columns) {
      patchTable({ isOpen: true, isLoading: true });

      let columns: ColumnInfo[] | undefined;
      try {
        const res = await window.electronAPI.describeTable(profileId, dbName, tableName);
        if (res.success && res.data) {
          columns = res.data.columns;
        }
      } catch (err) {
        console.error(err);
      }

      patchTable({ isOpen: true, isLoading: false, columns });
      return;
    }

    patchTable({ isOpen: nextIsOpen });
  };

  if (loading) {
    return (
      <div className="load-center">
        <span className="spinner" /> Loading databases…
      </div>
    );
  }

  if (error) {
    return (
      <div className="alert error alert-inline">
        <AlertTriangle size={14} />
        <span>{error}</span>
      </div>
    );
  }

  if (databases.length === 0) {
    return <div className="muted">No databases found.</div>;
  }

  return (
    <>
      <div className="tree-toolbar">
        <button
          className="icon-btn tree-refresh-all"
          title="새로고침 (DB 목록·열린 테이블 다시 불러오기)"
          onClick={() => void refreshAll()}
          disabled={refreshing}
        >
          <RefreshCw size={13} className={refreshing ? 'icon-spin' : ''} />
        </button>
      </div>
      <div className="tree">
      {databases.map((db) => (
        <div key={db.name} className="tree-node">
          <div className="tree-row" onClick={() => toggleDatabase(db.name)} onContextMenu={(e) => openDbMenu(e, db.name)}>
            <span className={`tree-chevron ${db.isOpen ? 'open' : ''}`}>
              <ChevronRight size={14} />
            </span>
            <span className="tree-icon">
              <Database size={14} />
            </span>
            <span className="tree-label">{db.name}</span>
            {db.isLoading && <span className="spinner" />}
            <button
              className="tree-row-action"
              title="이 데이터베이스 새로고침"
              onClick={(e) => { e.stopPropagation(); void refreshDatabase(db.name); }}
            >
              <RefreshCw size={12} />
            </button>
          </div>

          {db.isOpen && db.tables && (
            <div className="tree-children">
              {db.tables.length === 0 ? (
                <div className="muted" style={{ padding: '4px 8px' }}>
                  No tables
                </div>
              ) : (
                db.tables
                  .filter((t) => !hiddenFor(hiddenStore, profileId, db.name).includes(t.name))
                  .map((table) => (
                  <div key={table.name} className="tree-node">
                    <div
                      className="tree-row"
                      onClick={() => toggleTable(db.name, table.name)}
                      onContextMenu={(e) => openMenu(e, db.name, table.name)}
                      onDoubleClick={() => onOpenTableData?.(db.name, table.name)}
                    >
                      <span className={`tree-chevron ${table.isOpen ? 'open' : ''}`}>
                        <ChevronRight size={14} />
                      </span>
                      <span className="tree-icon">
                        <Table2 size={14} />
                      </span>
                      <span className="tree-label">{table.name}</span>
                      {table.isLoading && <span className="spinner" />}
                    </div>

                    {table.isOpen && table.columns && (
                      <div className="tree-children">
                        {table.columns.map((col) => (
                          <div key={col.name} className="col-row">
                            {col.primaryKey ? (
                              <span className="col-pk" title="Primary key">
                                <KeyRound size={12} />
                              </span>
                            ) : (
                              <span className="col-pk-spacer" />
                            )}
                            <span className="col-name">{col.name}</span>
                            <span className="col-type">
                              {col.type}
                              {col.nullable ? '' : ' · not null'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
              {hiddenCount(db.tables.map((t) => t.name), hiddenFor(hiddenStore, profileId, db.name)) > 0 && (
                <div className="tree-hidden-row" title="연결 수정(✏️)에서 표시할 테이블을 선택할 수 있습니다">
                  숨긴 테이블 {hiddenCount(db.tables.map((t) => t.name), hiddenFor(hiddenStore, profileId, db.name))}개 · 연결 수정에서 변경
                </div>
              )}
              {db.views && db.views.length > 0 && (
                <>
                  <div className="tree-subheader">뷰</div>
                  {db.views.map((vname) => (
                    <div key={`v-${vname}`} className="tree-node">
                      <div
                        className="tree-row"
                        onDoubleClick={() => onOpenTableData?.(db.name, vname)}
                        onContextMenu={(e) => openViewMenu(e, db.name, vname)}
                      >
                        <span className="tree-chevron" />
                        <span className="tree-icon"><Eye size={14} /></span>
                        <span className="tree-label">{vname}</span>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      ))}
      </div>

      {menu && (
        <div className="ctx-menu" style={{ top: menu.y, left: menu.x }} onClick={(e) => e.stopPropagation()}>
          <button className="ctx-item" onClick={() => runRecentRows(menu.db, menu.table)}>
            <Table2 size={13} /> 최근 500개 조회
          </button>
          <div className="ctx-sep" />
          <button className="ctx-item" onClick={() => showDDL(menu.db, menu.table)}>
            <FileCode size={13} /> Show DDL
          </button>
          <button className="ctx-item" onClick={() => { setCsvImport({ db: menu.db, table: menu.table }); setMenu(null); }}>
            <Upload size={13} /> CSV 가져오기…
          </button>
          <button className="ctx-item" onClick={() => { setIndexMgr({ db: menu.db, table: menu.table }); setMenu(null); }}>
            <KeyRound size={13} /> 인덱스 관리…
          </button>
          <div className="ctx-sep" />
          <button className="ctx-item" onClick={() => { setEdit({ db: menu.db, table: menu.table, focusNewColumn: false }); setMenu(null); }}>
            <Pencil size={13} /> 테이블 수정…
          </button>
          <button className="ctx-item" onClick={() => { setEdit({ db: menu.db, table: menu.table, focusNewColumn: true }); setMenu(null); }}>
            <PlusSquare size={13} /> 컬럼 추가…
          </button>
          <button className="ctx-item" onClick={() => { setTableAction({ db: menu.db, table: menu.table, action: 'rename' }); setMenu(null); }}>
            <Type size={13} /> 테이블 이름 변경…
          </button>
          <div className="ctx-sep" />
          <button className="ctx-item" onClick={() => { setTableAction({ db: menu.db, table: menu.table, action: 'truncate' }); setMenu(null); }}>
            <Eraser size={13} /> 테이블 비우기…
          </button>
          <button className="ctx-item danger" onClick={() => { setTableAction({ db: menu.db, table: menu.table, action: 'drop' }); setMenu(null); }}>
            <Trash2 size={13} /> 테이블 삭제…
          </button>
        </div>
      )}

      {edit && (
        <TableEditDialog
          key={`${edit.db}.${edit.table}.${edit.focusNewColumn}`}
          profileId={profileId}
          driver={driver as Driver}
          database={edit.db}
          table={edit.table}
          focusNewColumn={edit.focusNewColumn}
          onClose={() => setEdit(null)}
          onApplied={() => refreshAfterDdl(edit.db)}
        />
      )}

      {tableAction && (
        <TableActionDialog
          key={`${tableAction.db}.${tableAction.table}.${tableAction.action}`}
          profileId={profileId}
          driver={driver as Driver}
          table={tableAction.table}
          action={tableAction.action}
          onClose={() => setTableAction(null)}
          onApplied={() => refreshAfterDdl(tableAction.db)}
        />
      )}

      {csvImport && (
        <CsvImportDialog
          key={`${csvImport.db}.${csvImport.table}`}
          profileId={profileId}
          driver={driver as Driver}
          database={csvImport.db}
          table={csvImport.table}
          onClose={() => setCsvImport(null)}
          onImported={() => refreshAfterDdl(csvImport.db)}
        />
      )}

      {indexMgr && (
        <IndexManagerDialog
          key={`idx.${indexMgr.db}.${indexMgr.table}`}
          profileId={profileId}
          driver={driver as Driver}
          database={indexMgr.db}
          table={indexMgr.table}
          onClose={() => setIndexMgr(null)}
          onChanged={() => refreshAfterDdl(indexMgr.db)}
        />
      )}

      {dbMenu && (
        <div className="ctx-menu" style={{ top: dbMenu.y, left: dbMenu.x }} onClick={(e) => e.stopPropagation()}>
          <button className="ctx-item" onClick={() => { void refreshDatabase(dbMenu.db); setDbMenu(null); }}>
            <RefreshCw size={13} /> 새로고침
          </button>
          <button className="ctx-item" onClick={() => { setCreate({ db: dbMenu.db }); setDbMenu(null); }}>
            <FilePlus size={13} /> 테이블 추가…
          </button>
          {/* The schema graph is computed by the engine for sqlite too, so the
              ER diagram works across mysql/postgres/sqlite. */}
          {driver !== 'redis' && (
            <button className="ctx-item" onClick={() => { onOpenErDiagram?.(dbMenu.db); setDbMenu(null); }}>
              <Network size={13} /> ER 다이어그램
            </button>
          )}
        </div>
      )}

      {viewMenu && (
        <div className="ctx-menu" style={{ top: viewMenu.y, left: viewMenu.x }} onClick={(e) => e.stopPropagation()}>
          <button className="ctx-item" onClick={() => showViewDDL(viewMenu.db, viewMenu.view)}>
            <FileCode size={13} /> 뷰 DDL 보기
          </button>
        </div>
      )}

      {create && (
        <CreateTableDialog
          key={create.db}
          profileId={profileId}
          driver={driver as Driver}
          database={create.db}
          onClose={() => setCreate(null)}
          onApplied={() => refreshAfterDdl(create.db)}
        />
      )}

      {ddl && (
        <div className="modal-overlay" onClick={() => setDdl(null)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>
                DDL · <span className="mono">{ddl.table}</span>
              </h3>
              <div className="modal-head-actions">
                <button className="btn btn-secondary btn-xs" onClick={copyDDL} disabled={!ddl.text}>
                  <Copy size={12} /> Copy
                </button>
                <button className="icon-btn" onClick={() => setDdl(null)} title="Close">
                  <X size={15} />
                </button>
              </div>
            </div>
            {ddl.loading ? (
              <div className="load-center">
                <span className="spinner" /> Loading DDL…
              </div>
            ) : ddl.error ? (
              <div className="alert error">
                <AlertTriangle size={14} />
                <span>{ddl.error}</span>
              </div>
            ) : (
              <pre className="ddl-block">{ddl.text}</pre>
            )}
          </div>
        </div>
      )}
    </>
  );
};
