import React, { useState, useEffect, useRef } from 'react';
import MonacoEditor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { Play, Square, Save, Plus, X, Lock, Pencil, AlertTriangle, ShieldAlert, AlignLeft, ListTree } from 'lucide-react';
import { ResultGrid } from './ResultGrid';
import { SqlAutocomplete } from './SqlAutocomplete';
import { formatSql } from '../lib/formatSql';
import type { SchemaInfo } from '../lib/sqlCompletion';

loader.config({ monaco });

interface PolicyPrompt {
  code: string;
  message: string;
  verb: string;
}

interface QueryTab {
  id: string;
  name: string;
  query: string;
  columns: string[];
  rows: any[][];
  loading: boolean;
  error: string | null;
  rowsAffected: number | null;
  queryId: string | null;
  startTime: number | null;
  elapsedTimeMs: number | null;
  policyPrompt: PolicyPrompt | null;
  truncated: boolean;
  rowLimit: number;
}

interface QueryEditorProps {
  profileId: string;
  driver: 'mysql' | 'postgres' | 'redis';
  database: string;
  connectionName: string;
  onQueryExecuted?: () => void;
  loadTriggerQuery?: string;
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
});

export const QueryEditor: React.FC<QueryEditorProps> = ({ profileId, driver, database, connectionName, onQueryExecuted, loadTriggerQuery, schemaVersion }) => {
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
            updated.columns = chunk.columns;
            updated.rows = [];
          } else if (chunk.type === 'row') {
            updated.rows = [...updated.rows, chunk.data];
          } else if (chunk.type === 'policy') {
            updated.loading = false;
            updated.queryId = null;
            updated.policyPrompt = { code: chunk.code, message: chunk.message, verb: chunk.verb };
          } else if (chunk.type === 'done') {
            updated.loading = false;
            updated.rowsAffected = chunk.rowsAffected;
            updated.truncated = chunk.truncated === true;
            updated.rowLimit = chunk.rowLimit ?? 0;
            updated.elapsedTimeMs = tab.startTime ? Date.now() - tab.startTime : 0;
            updated.queryId = null;

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
              .catch((err: any) => console.error('Failed to log history:', err));
          } else if (chunk.type === 'error') {
            updated.loading = false;
            updated.error = chunk.message;
            updated.elapsedTimeMs = tab.startTime ? Date.now() - tab.startTime : 0;
            updated.queryId = null;

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
              .catch((err: any) => console.error('Failed to log error history:', err));
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
    } catch (e: any) {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId ? { ...t, loading: false, error: e.message || 'Execution request failed', queryId: null } : t
        )
      );
    }
  };

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
    if (!activeTab.loading || !activeTab.queryId) return;
    try {
      await window.electronAPI.cancelQuery(activeTab.queryId);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId ? { ...t, loading: false, error: 'Query cancelled.', queryId: null } : t
        )
      );
    } catch (e: any) {
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
    } catch (err: any) {
      alert('Error saving query: ' + err.message);
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
          height="220px"
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

      {/* Results */}
      <div className="results">
        {activeTab.loading && activeTab.rows.length === 0 && (
          <div className="load-center">
            <span className="spinner lg" />
            Executing…
          </div>
        )}

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
      </div>

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
