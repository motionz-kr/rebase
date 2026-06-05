import React, { useState, useEffect, useRef } from 'react';
import MonacoEditor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { Play, Square, Save, Plus, X, Lock, Pencil, AlertTriangle, ShieldAlert, AlignLeft, ListTree } from 'lucide-react';
import { ResultGrid } from './ResultGrid';
import { SqlAutocomplete } from './SqlAutocomplete';
import { formatSql } from '../lib/formatSql';
import { splitStatements } from '../lib/splitStatements';
import { analyzeEditableQuery, type EditableQuery } from '../lib/editableQuery';
import { TableDataView } from './TableDataView';
import { ExecStatusBar, type ExecInfo } from './ExecStatusBar';
import type { SchemaInfo } from '../lib/sqlCompletion';
import { clampEditorHeight, EDITOR_DEFAULT, loadNum, saveNum } from '../lib/uiPrefs';

loader.config({ monaco });

interface PolicyPrompt {
  code: string;
  message: string;
  verb: string;
}

// One statement's outcome when running a multi-statement script. The single-
// statement path uses the flat columns/rows fields above; this is only populated
// when the editor text contains more than one statement.
interface ResultSet {
  statement: string;
  columns: string[];
  rows: unknown[][];
  rowsAffected: number | null;
  error: string | null;
  truncated: boolean;
  rowLimit: number;
}

interface QueryTab {
  id: string;
  name: string;
  query: string;
  columns: string[];
  rows: unknown[][];
  loading: boolean;
  error: string | null;
  rowsAffected: number | null;
  queryId: string | null;
  startTime: number | null;
  elapsedTimeMs: number | null;
  policyPrompt: PolicyPrompt | null;
  truncated: boolean;
  rowLimit: number;
  // Multi-statement results (empty for single-statement runs).
  resultSets: ResultSet[];
  activeResultIndex: number;
  // Compact summary of the last execution (for the status bar).
  lastExec: ExecInfo | null;
}

interface QueryEditorProps {
  profileId: string;
  driver: 'mysql' | 'postgres' | 'redis' | 'sqlite';
  database: string;
  connectionName: string;
  onQueryExecuted?: () => void;
  loadTriggerQuery?: string;
  // A request to load a SQL into the active tab AND run it immediately (one-click
  // actions like "recent rows"). The nonce makes repeat requests of the same SQL fire.
  runQueryRequest?: { sql: string; nonce: number };
  schemaVersion?: number;
}

const DRIVER_LABEL: Record<string, string> = { mysql: 'MY', postgres: 'PG', redis: 'RS' };

const newTab = (id: string, name: string, query: string): QueryTab => ({
  id,
  name,
  query,
  columns: [],
  rows: [],
  loading: false,
  error: null,
  rowsAffected: null,
  queryId: null,
  startTime: null,
  elapsedTimeMs: null,
  policyPrompt: null,
  truncated: false,
  rowLimit: 0,
  resultSets: [],
  activeResultIndex: 0,
  lastExec: null,
});

export const QueryEditor: React.FC<QueryEditorProps> = ({ profileId, driver, database, connectionName, onQueryExecuted, loadTriggerQuery, runQueryRequest, schemaVersion }) => {
  const [tabs, setTabs] = useState<QueryTab[]>([
    newTab(
      'tab-1',
      'Query 1',
      driver === 'mysql'
        ? 'SELECT SCHEMA_NAME FROM information_schema.schemata;'
        : 'SELECT datname FROM pg_database;'
    ),
  ]);
  const [activeTabId, setActiveTabId] = useState('tab-1');
  // When the run query is a plain single-table SELECT *, the result is shown in
  // an editable table view (add/edit/delete) instead of the read-only grid.
  const [editView, setEditView] = useState<EditableQuery | null>(null);
  const [writeMode, setWriteMode] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveQueryName, setSaveQueryName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (loadTriggerQuery) {
      setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, query: loadTriggerQuery } : t)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadTriggerQuery]);

  const tabsRef = useRef<QueryTab[]>(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // The Monaco editor + monaco namespace, exposed for the custom autocomplete.
  const [editorInstance, setEditorInstance] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);

  // Drag-resizable SQL editor height (the splitter below it grows/shrinks the
  // results area inversely). Persisted across sessions.
  const [editorHeight, setEditorHeight] = useState(() => clampEditorHeight(loadNum('rebase.ui.editorHeight', EDITOR_DEFAULT)));
  useEffect(() => saveNum('rebase.ui.editorHeight', editorHeight), [editorHeight]);
  const startEditorResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorHeight;
    const onMove = (ev: MouseEvent) => setEditorHeight(clampEditorHeight(startH + (ev.clientY - startY)));
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // Load this connection's schema (tables + columns) for autocompletion.
  const [schema, setSchema] = useState<SchemaInfo>({ tables: [] });
  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await window.electronAPI.getSchemaCompletion(profileId, database);
        if (!ignore && res.success && res.data) {
          setSchema({ tables: res.data.tables });
        }
      } catch (e) {
        console.error('Failed to load schema for completion:', e);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [profileId, database, schemaVersion]);

  useEffect(() => {
    const cleanup = window.electronAPI.onQueryStreamChunk((queryId, chunk) => {
      const targetTab = tabsRef.current.find((t) => t.queryId === queryId);
      if (!targetTab) return;

      setTabs((prevTabs) =>
        prevTabs.map((tab) => {
          if (tab.queryId !== queryId) return tab;
          const updated = { ...tab };

          if (chunk.type === 'meta') {
            updated.columns = chunk.columns ?? [];
            updated.rows = [];
          } else if (chunk.type === 'row') {
            updated.rows = [...updated.rows, chunk.data ?? []];
          } else if (chunk.type === 'policy') {
            updated.loading = false;
            updated.queryId = null;
            updated.policyPrompt = { code: chunk.code ?? '', message: chunk.message ?? '', verb: chunk.verb ?? '' };
          } else if (chunk.type === 'done') {
            updated.loading = false;
            updated.rowsAffected = chunk.rowsAffected ?? null;
            updated.truncated = chunk.truncated === true;
            updated.rowLimit = chunk.rowLimit ?? 0;
            updated.elapsedTimeMs = tab.startTime ? Date.now() - tab.startTime : 0;
            updated.queryId = null;
            updated.lastExec = {
              sql: tab.query,
              durationMs: updated.elapsedTimeMs,
              rowCount: updated.columns.length > 0 ? updated.rows.length : null,
              rowsAffected: updated.columns.length > 0 ? null : chunk.rowsAffected ?? null,
              error: null,
            };

            window.electronAPI
              .addQueryHistory({
                workspaceId: 'default',
                profileId,
                queryText: tab.query,
                durationMs: updated.elapsedTimeMs,
                success: true,
                errorMessage: null,
                rowCount: updated.rows.length || chunk.rowsAffected,
              })
              .then(() => onQueryExecuted?.())
              .catch((err) => console.error('Failed to log history:', err));
          } else if (chunk.type === 'error') {
            updated.loading = false;
            updated.error = chunk.message ?? null;
            updated.elapsedTimeMs = tab.startTime ? Date.now() - tab.startTime : 0;
            updated.queryId = null;
            updated.lastExec = { sql: tab.query, durationMs: updated.elapsedTimeMs, error: chunk.message };

            window.electronAPI
              .addQueryHistory({
                workspaceId: 'default',
                profileId,
                queryText: tab.query,
                durationMs: updated.elapsedTimeMs,
                success: false,
                errorMessage: chunk.message,
                rowCount: 0,
              })
              .then(() => onQueryExecuted?.())
              .catch((err) => console.error('Failed to log error history:', err));
          }

          return updated;
        })
      );
    });

    return cleanup;
  }, [profileId, onQueryExecuted]);

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  const handleQueryChange = (value: string | undefined) => {
    if (value === undefined) return;
    setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, query: value } : t)));
  };

  // Multi-statement run state: the queryId of the statement currently streaming
  // (so Cancel can target it) and an abort flag the sequential loop checks.
  const multiCancelRef = useRef<string | null>(null);
  const multiAbortRef = useRef<boolean>(false);

  // Run one statement to completion and collect its full result set. Uses a
  // dedicated chunk subscription keyed on its own queryId; the global handler
  // ignores it because the tab's queryId is never set to these ids.
  const runSingleStatementCollected = (
    stmt: string,
    opts: { allowWrite: boolean; confirmDestructive: boolean; fetchAll: boolean }
  ): Promise<{ result?: ResultSet; policy?: PolicyPrompt }> =>
    new Promise((resolve) => {
      const queryId = `query-${crypto.randomUUID()}`;
      multiCancelRef.current = queryId;
      let columns: string[] = [];
      const rows: unknown[][] = [];
      let settled = false;
      const finish = (payload: { result?: ResultSet; policy?: PolicyPrompt }) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(payload);
      };
      const cleanup = window.electronAPI.onQueryStreamChunk((qid, chunk) => {
        if (qid !== queryId) return;
        if (chunk.type === 'meta') {
          columns = chunk.columns ?? [];
        } else if (chunk.type === 'row') {
          rows.push(chunk.data ?? []);
        } else if (chunk.type === 'policy') {
          finish({ policy: { code: chunk.code ?? '', message: chunk.message ?? '', verb: chunk.verb ?? '' } });
        } else if (chunk.type === 'done') {
          finish({
            result: {
              statement: stmt,
              columns,
              rows,
              rowsAffected: chunk.rowsAffected ?? null,
              error: null,
              truncated: chunk.truncated === true,
              rowLimit: chunk.rowLimit ?? 0,
            },
          });
        } else if (chunk.type === 'error') {
          finish({
            result: { statement: stmt, columns, rows, rowsAffected: null, error: chunk.message ?? null, truncated: false, rowLimit: 0 },
          });
        }
      });
      window.electronAPI
        .executeQueryStream(queryId, profileId, stmt, opts)
        .then((res) => {
          if (!res.success) {
            finish({
              result: { statement: stmt, columns: [], rows: [], rowsAffected: null, error: res.error || 'Failed to start query', truncated: false, rowLimit: 0 },
            });
          }
        })
        .catch((e) => {
          finish({
            result: { statement: stmt, columns: [], rows: [], rowsAffected: null, error: e instanceof Error ? e.message : 'Execution request failed', truncated: false, rowLimit: 0 },
          });
        });
    });

  // Run a script's statements sequentially, accumulating one result set each and
  // stopping on the first error or policy block.
  const runMultiStatements = async (
    statements: string[],
    opts: { allowWrite: boolean; confirmDestructive: boolean; fetchAll: boolean }
  ) => {
    const startTime = Date.now();
    multiAbortRef.current = false;
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              loading: true,
              columns: [],
              rows: [],
              error: null,
              rowsAffected: null,
              queryId: null,
              startTime,
              elapsedTimeMs: null,
              policyPrompt: null,
              truncated: false,
              resultSets: [],
              activeResultIndex: 0,
            }
          : t
      )
    );

    const collected: ResultSet[] = [];
    let policy: PolicyPrompt | null = null;
    for (const stmt of statements) {
      const r = await runSingleStatementCollected(stmt, opts);
      if (r.policy) {
        policy = r.policy;
        break;
      }
      if (r.result) {
        collected.push(r.result);
        window.electronAPI
          .addQueryHistory({
            workspaceId: 'default',
            profileId,
            queryText: stmt,
            durationMs: 0,
            success: !r.result.error,
            errorMessage: r.result.error,
            rowCount: r.result.rows.length || r.result.rowsAffected || 0,
          })
          .then(() => onQueryExecuted?.())
          .catch(() => {});
        const snapshot = [...collected];
        setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, resultSets: snapshot } : t)));
        if (r.result.error) break; // stop the script on the first failure
      }
      if (multiAbortRef.current) break;
    }

    multiCancelRef.current = null;
    const elapsed = Date.now() - startTime;
    const lastErr = collected.find((rs) => rs.error)?.error ?? null;
    const totalRows = collected.reduce((n, rs) => n + (rs.columns.length > 0 ? rs.rows.length : 0), 0);
    const lastExec: ExecInfo = {
      sql: statements.join(';\n'),
      durationMs: elapsed,
      rowCount: lastErr ? null : totalRows,
      rowsAffected: null,
      error: lastErr,
    };
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? { ...t, loading: false, elapsedTimeMs: elapsed, activeResultIndex: 0, policyPrompt: policy ?? t.policyPrompt, lastExec }
          : t
      )
    );
  };

  const executeQuery = async (override?: {
    allowWrite?: boolean;
    confirmDestructive?: boolean;
    fetchAll?: boolean;
    sqlOverride?: string;
  }) => {
    if (activeTab.loading) return;

    const allowWrite = override?.allowWrite ?? writeMode;
    const confirmDestructive = override?.confirmDestructive ?? false;
    const fetchAll = override?.fetchAll ?? false;
    const sql = override?.sqlOverride ?? activeTab.query;

    // A script of several statements runs sequentially with one result set each
    // (DataGrip-style). A single statement keeps the existing streaming path.
    const statements = splitStatements(sql);
    if (statements.length > 1) {
      setEditView(null);
      await runMultiStatements(statements, { allowWrite, confirmDestructive, fetchAll });
      return;
    }

    // A plain single-table SELECT * → show an editable table view of that table
    // instead of running a read-only result grid.
    const editable = analyzeEditableQuery(sql);
    if (editable) {
      setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, query: sql, error: null, policyPrompt: null } : t)));
      setEditView(editable);
      return;
    }
    setEditView(null);

    const queryId = `query-${crypto.randomUUID()}`;
    const startTime = Date.now();

    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              loading: true,
              columns: [],
              rows: [],
              error: null,
              rowsAffected: null,
              queryId,
              startTime,
              elapsedTimeMs: null,
              policyPrompt: null,
              truncated: false,
              resultSets: [],
              activeResultIndex: 0,
            }
          : t
      )
    );

    try {
      const res = await window.electronAPI.executeQueryStream(queryId, profileId, sql, {
        allowWrite,
        confirmDestructive,
        fetchAll,
      });
      if (!res.success) {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === activeTabId ? { ...t, loading: false, error: res.error || 'Failed to start query', queryId: null } : t
          )
        );
      }
    } catch (e) {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId ? { ...t, loading: false, error: e instanceof Error ? e.message : 'Execution request failed', queryId: null } : t
        )
      );
    }
  };

  // One-click "load this SQL and run it" requests (e.g. table → recent rows).
  useEffect(() => {
    if (!runQueryRequest) return;
    const sql = runQueryRequest.sql;
    setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, query: sql } : t)));
    void executeQuery({ sqlOverride: sql });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runQueryRequest?.nonce]);

  const formatQuery = () => {
    const formatted = formatSql(activeTab.query, driver);
    if (formatted === activeTab.query) return;
    setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, query: formatted } : t)));
  };

  // Keep refs to the latest handlers so Monaco keybindings (registered once on
  // mount) always run the current closures, not stale ones.
  const runQueryRef = useRef<() => void>(() => {});
  runQueryRef.current = () => {
    if (activeTab.loading || !activeTab.query.trim()) return;
    void executeQuery();
  };
  const formatRef = useRef<() => void>(() => {});
  formatRef.current = formatQuery;

  const cancelQuery = async () => {
    const qid = activeTab.queryId || multiCancelRef.current;
    if (!activeTab.loading || !qid) return;
    multiAbortRef.current = true; // stop the multi-statement loop after this one
    try {
      await window.electronAPI.cancelQuery(qid);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId ? { ...t, loading: false, error: 'Query cancelled.', queryId: null } : t
        )
      );
    } catch (e) {
      console.error('Failed to cancel query:', e);
    }
  };

  const dismissPolicy = () =>
    setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, policyPrompt: null } : t)));

  const createTab = () => {
    const id = `tab-${Date.now()}`;
    setTabs((prev) => [...prev, newTab(id, `Query ${prev.length + 1}`, 'SELECT * FROM ')]);
    setActiveTabId(id);
  };

  const closeTab = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabs.length === 1) return;
    const target = tabs.find((t) => t.id === tabId);
    if (target?.loading && target.queryId) {
      window.electronAPI.cancelQuery(target.queryId);
    }
    const filtered = tabs.filter((t) => t.id !== tabId);
    setTabs(filtered);
    if (activeTabId === tabId) setActiveTabId(filtered[filtered.length - 1].id);
  };

  const handleSaveSQL = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!saveQueryName.trim()) return;
    setIsSaving(true);
    try {
      const res = await window.electronAPI.saveQuery({
        workspaceId: 'default',
        profileId,
        name: saveQueryName,
        queryText: activeTab.query,
        isFavorite: false,
      });
      if (res.success) {
        setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, name: saveQueryName } : t)));
        setShowSaveModal(false);
        setSaveQueryName('');
        onQueryExecuted?.();
      } else {
        alert('Failed to save query: ' + (res.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Error saving query: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setIsSaving(false);
    }
  };

  const prompt = activeTab.policyPrompt;

  return (
    <div className="editor">
      {/* Tabs */}
      <div className="editor-tabs">
        <div className="editor-conn" title={`${connectionName} · ${driver} · ${database}`}>
          <span className={`driver-chip sm ${driver}`}>{DRIVER_LABEL[driver]}</span>
          <span className="editor-conn-name">{connectionName}</span>
          {database && <span className="editor-conn-db">{database}</span>}
        </div>
        <span className="editor-tabs-sep" />
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`etab ${activeTabId === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTabId(tab.id)}
          >
            <span>{tab.name}</span>
            {tabs.length > 1 && (
              <button className="etab-close" onClick={(e) => closeTab(tab.id, e)}>
                <X size={12} />
              </button>
            )}
          </div>
        ))}
        <button className="etab-add" onClick={createTab} title="New query tab">
          <Plus size={15} />
        </button>
      </div>

      {/* Monaco */}
      <div className="monaco-host">
        <MonacoEditor
          height={`${editorHeight}px`}
          language="sql"
          theme="vs-dark"
          value={activeTab.query}
          onChange={handleQueryChange}
          onMount={(editor, monacoInstance) => {
            // Autocomplete is handled by the custom <SqlAutocomplete> overlay
            // (Monaco's built-in suggest widget is disabled via options below).
            setEditorInstance(editor);

            const { KeyCode } = monacoInstance;
            // Handle shortcuts via onKeyDown (per-editor) rather than addCommand.
            // addCommand registers a global standalone keybinding; with multiple
            // editors mounted (multi-connection) those bindings collide and the
            // focused editor's command may not fire. onKeyDown is scoped to the
            // editor that actually has focus, so it always targets the right one.
            editor.onKeyDown((e) => {
              // Cmd+Enter (mac) / Ctrl+Enter (win/linux) runs the query.
              if (e.keyCode === KeyCode.Enter && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                e.stopPropagation();
                runQueryRef.current();
                return;
              }
              // Cmd/Ctrl+Alt+L reformats the SQL (DataGrip-style).
              if (e.keyCode === KeyCode.KeyL && (e.ctrlKey || e.metaKey) && e.altKey) {
                e.preventDefault();
                e.stopPropagation();
                formatRef.current();
              }
            });
          }}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            automaticLayout: true,
            scrollBeyondLastLine: false,
            lineNumbers: 'on',
            padding: { top: 10 },
            renderLineHighlight: 'line',
            // Disable Monaco's built-in suggest widget — we render our own.
            quickSuggestions: false,
            suggestOnTriggerCharacters: false,
            wordBasedSuggestions: 'off',
            parameterHints: { enabled: false },
            hover: { enabled: false },
          }}
        />
        <SqlAutocomplete editor={editorInstance} monaco={monaco} schema={schema} />
      </div>

      {/* Drag handle to resize the editor vs. the results area */}
      <div
        className="editor-vsplit"
        onMouseDown={startEditorResize}
        onDoubleClick={() => setEditorHeight(EDITOR_DEFAULT)}
        title="드래그하여 높이 조절 · 더블클릭으로 초기화"
      />

      {/* Toolbar */}
      <div className="editor-toolbar">
        <div className="toolbar-left">
          {activeTab.loading ? (
            <button className="btn btn-danger btn-sm" onClick={cancelQuery}>
              <Square size={13} /> Cancel
            </button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={() => executeQuery()} disabled={!activeTab.query.trim()}>
              <Play size={13} /> Run
            </button>
          )}
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => executeQuery({ sqlOverride: `EXPLAIN ${activeTab.query}` })}
            disabled={!activeTab.query.trim() || activeTab.loading}
            title="Show query execution plan (EXPLAIN)"
          >
            <ListTree size={13} /> EXPLAIN
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={formatQuery}
            disabled={!activeTab.query.trim() || activeTab.loading}
            title="Format SQL (⌘/Ctrl+Alt+L)"
          >
            <AlignLeft size={13} /> Format
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setShowSaveModal(true)}
            disabled={!activeTab.query.trim() || activeTab.loading}
          >
            <Save size={13} /> Save
          </button>
        </div>
        <div className="toolbar-right">
          {activeTab.loading && <span className="spinner" />}
          {activeTab.elapsedTimeMs !== null && <span className="elapsed">{activeTab.elapsedTimeMs} ms</span>}
          <div className="mode-toggle">
            <button className={`mode-opt ${!writeMode ? 'active' : ''}`} onClick={() => setWriteMode(false)}>
              <Lock size={11} /> Read-only
            </button>
            <button className={`mode-opt write ${writeMode ? 'active' : ''}`} onClick={() => setWriteMode(true)}>
              <Pencil size={11} /> Write
            </button>
          </div>
        </div>
      </div>

      {/* Policy banner */}
      {prompt && (
        <div className="policy-banner">
          <span className="pb-icon">
            <ShieldAlert size={16} />
          </span>
          <span className="pb-text">
            {prompt.message} {prompt.verb && <strong>({prompt.verb})</strong>}
          </span>
          <span className="pb-actions">
            <button className="btn btn-ghost btn-sm" onClick={dismissPolicy}>
              Dismiss
            </button>
            {prompt.code === 'read_only_blocked' ? (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setWriteMode(true);
                  executeQuery({ allowWrite: true });
                }}
              >
                Enable write & run
              </button>
            ) : (
              <button className="btn btn-danger btn-sm" onClick={() => executeQuery({ allowWrite: true, confirmDestructive: true })}>
                Run anyway
              </button>
            )}
          </span>
        </div>
      )}

      {/* Editable result: a single-table SELECT * opens an editable table view. */}
      {editView ? (
        <div className="results">
          <TableDataView
            key={`edit.${editView.table}.${editView.orderBy?.col ?? ''}.${editView.orderBy?.dir ?? ''}.${editView.limit ?? ''}`}
            profileId={profileId}
            driver={driver as 'mysql' | 'postgres'}
            database={database}
            table={editView.table}
            initialOrderBy={editView.orderBy ?? undefined}
            limit={editView.limit ?? undefined}
            readOnly={!writeMode}
            embedded
          />
        </div>
      ) : (
      <div className="results">
        {activeTab.loading && activeTab.rows.length === 0 && activeTab.resultSets.length === 0 && (
          <div className="load-center">
            <span className="spinner lg" />
            Executing…
          </div>
        )}

        {activeTab.resultSets.length > 0 ? (
          /* Multi-statement: one result set per statement, switchable via the strip. */
          (() => {
            const sets = activeTab.resultSets;
            const idx = Math.min(activeTab.activeResultIndex, sets.length - 1);
            const rs = sets[idx];
            return (
              <>
                <div className="result-strip">
                  {sets.map((s, i) => (
                    <button
                      key={i}
                      className={`result-chip ${i === idx ? 'active' : ''} ${s.error ? 'err' : ''}`}
                      onClick={() => setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, activeResultIndex: i } : t)))}
                      title={s.statement}
                    >
                      Result {i + 1}
                      {s.error
                        ? ' · failed'
                        : s.columns.length > 0
                        ? ` · ${s.rows.length.toLocaleString()} rows`
                        : ` · ${s.rowsAffected ?? 0} affected`}
                    </button>
                  ))}
                  {activeTab.loading && <span className="spinner" style={{ marginLeft: 8 }} />}
                </div>
                {rs.error ? (
                  <div className="alert error">
                    <AlertTriangle size={14} />
                    <span>
                      <strong>Execution failed.</strong> {rs.error}
                    </span>
                  </div>
                ) : rs.columns.length === 0 ? (
                  <div className="alert" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}>
                    Statement executed. Rows affected: {rs.rowsAffected ?? 0}
                  </div>
                ) : (
                  <>
                    {rs.truncated && (
                      <div className="trunc-bar">
                        <span>
                          Showing first {rs.rows.length.toLocaleString()} rows (capped at {rs.rowLimit.toLocaleString()}).
                        </span>
                      </div>
                    )}
                    <ResultGrid columns={rs.columns} rows={rs.rows} />
                  </>
                )}
              </>
            );
          })()
        ) : (
          <>
            {activeTab.error && (
              <div className="alert error">
                <AlertTriangle size={14} />
                <span>
                  <strong>Execution failed.</strong> {activeTab.error}
                </span>
              </div>
            )}

            {!activeTab.loading &&
              !activeTab.error &&
              activeTab.rowsAffected !== null &&
              activeTab.columns.length === 0 && (
                <div className="alert" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}>
                  Statement executed. Rows affected: {activeTab.rowsAffected}
                </div>
              )}

            {(activeTab.columns.length > 0 || activeTab.rows.length > 0) && (
              <>
                {activeTab.truncated && !activeTab.loading && (
                  <div className="trunc-bar">
                    <span>
                      Showing first {activeTab.rows.length.toLocaleString()} rows (capped at{' '}
                      {activeTab.rowLimit.toLocaleString()}).
                    </span>
                    <button
                      className="btn btn-secondary btn-xs"
                      onClick={() => executeQuery({ allowWrite: writeMode, fetchAll: true })}
                    >
                      Fetch all rows
                    </button>
                  </div>
                )}
                <ResultGrid columns={activeTab.columns} rows={activeTab.rows} />
              </>
            )}
          </>
        )}
      </div>
      )}

      {/* Execution status: last query, time, rows (click to expand). */}
      {!editView && <ExecStatusBar info={activeTab.lastExec} />}

      {/* Save modal */}
      {showSaveModal && (
        <div className="modal-overlay" onClick={() => setShowSaveModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Save query</h3>
            <form onSubmit={handleSaveSQL}>
              <div>
                <label>Query name</label>
                <input
                  type="text"
                  placeholder="e.g. Active users"
                  value={saveQueryName}
                  onChange={(e) => setSaveQueryName(e.target.value)}
                  autoFocus
                  required
                />
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowSaveModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary btn-sm" disabled={isSaving || !saveQueryName.trim()}>
                  {isSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
