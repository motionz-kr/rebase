import React, { useState, useEffect, useRef, useCallback } from 'react';
import MonacoEditor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { Play, Square, Save, Plus, X, Lock, Pencil, AlertTriangle, ShieldAlert, AlignLeft, ListTree, BookOpen, Check, RotateCcw, Database } from 'lucide-react';
import { ResultGrid } from './ResultGrid';
import { ExplainPlanView } from './ExplainPlanView';
import { SqlAutocomplete } from './SqlAutocomplete';
import { RiskConfirmDialog } from './RiskConfirmDialog';
import { formatSql } from '../lib/formatSql';
import { splitStatementRanges, type SqlStatementRange } from '../lib/splitStatements';
import { resolveSqlExecutionTarget } from '../lib/sqlExecutionTarget';
import { classifyStatement } from '../lib/sqlDanger';
import { analyzeEditableQuery, type EditableQuery } from '../lib/editableQuery';
import { TableDataView } from './TableDataView';
import { ExecStatusBar, type ExecInfo } from './ExecStatusBar';
import { ResultNarrator } from './ResultNarrator';
import type { SchemaInfo } from '../lib/sqlCompletion';
import type { AnalyzeResult } from '../global';
import { clampEditorHeight, EDITOR_DEFAULT, loadNum, saveNum } from '../lib/uiPrefs';
import { useTheme } from '../lib/theme-context';
import { generateQueryTitle } from '../lib/queryTitle';
import type { SqlQueryRequest } from '../lib/queryRequest';
import { formatQueryTabLabel } from '../lib/queryTabLabel';
import { buildExplainSql } from '../lib/explainPlan';
import { getTransactionControls, getTransactionStatusLabel, type QueryTransactionMode, type QueryTransactionState } from '../lib/queryTransaction';
import { getSqlDiagnostics, type SqlDiagnostic } from '../lib/sqlDiagnostics';
import { withExplicitRiskApproval } from '../lib/queryApproval';

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

type StatementExecutionState = 'pending' | 'running' | 'success' | 'error' | 'skipped';

interface StatementExecution {
  start: number;
  end: number;
  state: StatementExecutionState;
  message?: string;
}

interface QueryTab {
  id: string;
  name: string;
  database: string;
  query: string;
  columns: string[];
  rows: unknown[][];
  loading: boolean;
  error: string | null;
  rowsAffected: number | null;
  queryId: string | null;
  lastExecutedSql: string | null;
  startTime: number | null;
  elapsedTimeMs: number | null;
  policyPrompt: PolicyPrompt | null;
  truncated: boolean;
  rowLimit: number;
  // Multi-statement results (empty for single-statement runs).
  resultSets: ResultSet[];
  activeResultIndex: number;
  statementExecutions: StatementExecution[];
  // Compact summary of the last execution (for the status bar).
  lastExec: ExecInfo | null;
  transactionMode: QueryTransactionMode;
  transactionState: QueryTransactionState;
  transactionSessionId: string | null;
  transactionNotice: string | null;
}

interface QueryEditorProps {
  profileId: string;
  driver: 'mysql' | 'postgres' | 'redis' | 'sqlite' | 'sqlserver';
  database: string;
  connectionName: string;
  safeMode?: boolean;
  onQueryExecuted?: () => void;
  loadTriggerQuery?: string;
  // A request to change the active database context; optionally load a SQL into
  // the active tab and run it immediately. The nonce makes repeat requests fire.
  queryRequest?: SqlQueryRequest;
  schemaVersion?: number;
  agentTitlesEnabled?: boolean;
  onOpenLibrary?: () => void;
}

const DRIVER_LABEL: Record<string, string> = { mysql: 'MY', postgres: 'PG', redis: 'RS', sqlite: 'SQ', sqlserver: 'MS' };

const statementExecutionLabel = (execution: StatementExecution): string => {
  if (execution.state === 'running') return '실행 중';
  if (execution.state === 'success') return '실행 완료';
  if (execution.state === 'error') return execution.message ? `실행 실패: ${execution.message}` : '실행 실패';
  if (execution.state === 'skipped') return execution.message ?? '실행되지 않음';
  return '실행 대기';
};

const newTab = (id: string, name: string, database: string, query: string): QueryTab => ({
  id,
  name,
  database,
  query,
  columns: [],
  rows: [],
  loading: false,
  error: null,
  rowsAffected: null,
  queryId: null,
  lastExecutedSql: null,
  startTime: null,
  elapsedTimeMs: null,
  policyPrompt: null,
  truncated: false,
  rowLimit: 0,
  resultSets: [],
  activeResultIndex: 0,
  statementExecutions: [],
  lastExec: null,
  transactionMode: 'auto',
  transactionState: 'idle',
  transactionSessionId: null,
  transactionNotice: null,
});

export const QueryEditor: React.FC<QueryEditorProps> = ({ profileId, driver, database, connectionName, safeMode = false, onQueryExecuted, loadTriggerQuery, queryRequest, schemaVersion, agentTitlesEnabled = false, onOpenLibrary }) => {
  const requestedDatabase = queryRequest?.database;
  const requestedNonce = queryRequest?.nonce;
  const requestedSql = queryRequest?.sql;
  const requestedExecute = queryRequest?.execute;
  const [tabs, setTabs] = useState<QueryTab[]>([
    newTab(
      'tab-1',
      'Query 1',
      database,
      driver === 'mysql'
        ? 'SELECT SCHEMA_NAME FROM information_schema.schemata;'
        : driver === 'sqlite'
          ? "SELECT name FROM sqlite_master WHERE type='table';"
          : driver === 'sqlserver'
            ? 'SELECT name FROM sys.databases;'
            : 'SELECT datname FROM pg_database;'
    ),
  ]);
  const [activeTabId, setActiveTabId] = useState('tab-1');
  const { resolved } = useTheme();
  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const activeDatabase = activeTab.database;
  const explainSql = buildExplainSql(driver, activeTab.query);
  const isExplainResult = /^\s*EXPLAIN\b/i.test(activeTab.lastExecutedSql ?? '');
  const activeTabIdRef = useRef(activeTabId);
  // When the run query is a plain single-table SELECT *, the result is shown in
  // an editable table view (add/edit/delete) instead of the read-only grid.
  const [editView, setEditView] = useState<EditableQuery | null>(null);
  const [writeMode, setWriteMode] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveQueryName, setSaveQueryName] = useState('');
  const [saveNameTouched, setSaveNameTouched] = useState(false);
  const [titleSuggesting, setTitleSuggesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Analyze gate: when a risky statement is intercepted, hold the pending
  // continuation here and show the RiskConfirmDialog.
  const [riskResult, setRiskResult] = useState<AnalyzeResult | null>(null);
  const pendingRunRef = useRef<null | (() => void)>(null);

  const previousProfileDatabaseRef = useRef(database);
  useEffect(() => {
    if (previousProfileDatabaseRef.current === database) return;
    previousProfileDatabaseRef.current = database;
    setTabs((prev) => prev.map((t) => ({ ...t, database })));
  }, [database]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    if (loadTriggerQuery) {
      const targetTabId = activeTabIdRef.current;
      setTabs((prev) => prev.map((t) => (t.id === targetTabId ? { ...t, query: loadTriggerQuery, statementExecutions: [] } : t)));
    }
  }, [loadTriggerQuery]);

  const tabsRef = useRef<QueryTab[]>(tabs);
  const transactionSessionsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const updateTabTransaction = (tabId: string, patch: Partial<Pick<QueryTab, 'transactionMode' | 'transactionState' | 'transactionSessionId'>>) => {
    tabsRef.current = tabsRef.current.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab);
    setTabs((prev) => prev.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab));
  };

  const ensureTransactionSession = async (tabId: string, targetDatabase: string, allowWrite: boolean): Promise<string> => {
    const fromRef = transactionSessionsRef.current[tabId];
    const fromTab = tabsRef.current.find((tab) => tab.id === tabId)?.transactionSessionId;
    const existing = fromRef ?? fromTab;
    if (existing) return existing;

    updateTabTransaction(tabId, { transactionState: 'opening' });
    const result = await window.electronAPI.querySession('open', profileId, targetDatabase, '', !allowWrite);
    const sessionId = result.success ? result.data?.sessionId : undefined;
    if (!sessionId) {
      updateTabTransaction(tabId, { transactionState: 'idle', transactionSessionId: null });
      throw new Error(result.error || '수동 트랜잭션 세션을 열지 못했습니다.');
    }
    transactionSessionsRef.current[tabId] = sessionId;
    updateTabTransaction(tabId, { transactionState: 'idle', transactionSessionId: sessionId });
    return sessionId;
  };

  const closeTransactionSession = async (tabId: string): Promise<void> => {
    const tab = tabsRef.current.find((item) => item.id === tabId);
    const sessionId = transactionSessionsRef.current[tabId] ?? tab?.transactionSessionId;
    if (!sessionId) return;
    const result = await window.electronAPI.querySession('close', profileId, '', sessionId);
    if (!result.success) throw new Error(result.error || '트랜잭션 세션을 닫지 못했습니다.');
    delete transactionSessionsRef.current[tabId];
    updateTabTransaction(tabId, { transactionSessionId: null, transactionState: 'idle' });
  };

  const changeWriteMode = async (nextWriteMode: boolean): Promise<boolean> => {
    if (nextWriteMode === writeMode) return true;
    const hasUncommittedTransaction = tabsRef.current.some((tab) =>
      tab.transactionMode === 'manual' && ['opening', 'active', 'failed'].includes(tab.transactionState)
    );
    if (hasUncommittedTransaction) {
      alert('Manual 트랜잭션을 먼저 Commit 또는 Rollback 해주세요.');
      return false;
    }
    try {
      // A session is bound to its read/write permission when it is opened.
      // Close idle sessions so the next query uses the newly selected mode.
      await Promise.all(tabsRef.current
        .filter((tab) => tab.transactionMode === 'manual' && tab.transactionSessionId)
        .map((tab) => closeTransactionSession(tab.id)));
      setWriteMode(nextWriteMode);
      return true;
    } catch (error) {
      alert(error instanceof Error ? error.message : '트랜잭션 세션을 닫지 못했습니다.');
      return false;
    }
  };

  const setTransactionMode = async (tabId: string, mode: QueryTransactionMode) => {
    const target = tabsRef.current.find((tab) => tab.id === tabId);
    if (!target || target.transactionMode === mode) return;
    if (mode === 'auto' && ['opening', 'active', 'failed'].includes(target.transactionState)) {
      const confirmed = window.confirm('Auto-commit으로 전환하면 미커밋 변경 사항을 Rollback 합니다. 계속할까요?');
      if (!confirmed) return;
    }
    try {
      if (target.transactionSessionId) await closeTransactionSession(tabId);
      setTabs((prev) => prev.map((tab) => tab.id === tabId
        ? { ...tab, transactionMode: mode, transactionState: 'idle', transactionSessionId: null, transactionNotice: null }
        : tab));
    } catch (error) {
      alert(error instanceof Error ? error.message : '트랜잭션 세션을 닫지 못했습니다.');
    }
  };

  const finishTransaction = async (action: 'commit' | 'rollback') => {
    const sessionId = transactionSessionsRef.current[activeTab.id] ?? activeTab.transactionSessionId;
    if (!sessionId) return;
    const result = await window.electronAPI.querySession(action, profileId, '', sessionId);
    if (!result.success || result.data?.success === false) {
      const message = result.error || '트랜잭션 작업에 실패했습니다.';
      setTabs((prev) => prev.map((tab) => tab.id === activeTab.id
        ? { ...tab, transactionState: 'failed', transactionNotice: message, error: message }
        : tab));
      return;
    }
    setTabs((prev) => prev.map((tab) => tab.id === activeTab.id
      ? { ...tab, transactionState: 'idle', transactionNotice: action === 'commit' ? 'Committed' : 'Rolled back', error: null }
      : tab));
  };

  useEffect(() => {
    const ownerProfileId = profileId;
    return () => {
      const openSessions = Object.entries(transactionSessionsRef.current);
      transactionSessionsRef.current = {};
      for (const [, sessionId] of openSessions) {
        void window.electronAPI.querySession('close', ownerProfileId, '', sessionId);
      }
    };
  }, [profileId]);

  // The Monaco editor + monaco namespace, exposed for the custom autocomplete.
  const [editorInstance, setEditorInstance] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [schema, setSchema] = useState<SchemaInfo>({ tables: [] });
  const [sqlDiagnostics, setSqlDiagnostics] = useState<SqlDiagnostic[]>([]);
  const statementDecorationsRef = useRef<string[]>([]);
  const [activeStatementRanges, setActiveStatementRanges] = useState<SqlStatementRange[]>([]);

  // Keep the cursor's statement range live as the caret/selection moves. This
  // is independent of execution state: an idle statement is still outlined.
  useEffect(() => {
    if (!editorInstance) return;
    const updateActiveStatement = () => {
      const model = editorInstance.getModel();
      const position = editorInstance.getPosition();
      const selection = editorInstance.getSelection();
      if (!model || !position) {
        setActiveStatementRanges([]);
        return;
      }
      const target = resolveSqlExecutionTarget(model.getValue(), {
        cursorOffset: model.getOffsetAt(position),
        selectionStart: selection ? model.getOffsetAt(selection.getStartPosition()) : undefined,
        selectionEnd: selection ? model.getOffsetAt(selection.getEndPosition()) : undefined,
      });
      setActiveStatementRanges(target?.ranges ?? []);
    };

    updateActiveStatement();
    const cursorListener = editorInstance.onDidChangeCursorPosition(updateActiveStatement);
    const selectionListener = editorInstance.onDidChangeCursorSelection(updateActiveStatement);
    const contentListener = editorInstance.onDidChangeModelContent(updateActiveStatement);
    return () => {
      cursorListener.dispose();
      selectionListener.dispose();
      contentListener.dispose();
    };
  }, [editorInstance, activeTab.id]);

  // Show one DataGrip-like marker per SQL statement. The glyph sits in the
  // editor gutter, while the whole statement gets a subtle state tint and a
  // hover explanation.
  useEffect(() => {
    if (!editorInstance) return;
    const model = editorInstance.getModel();
    if (!model) return;

    const sourceLength = model.getValue().length;
    const decorations: monaco.editor.IModelDeltaDecoration[] = activeTab.statementExecutions.map((execution, index) => {
      const startOffset = Math.min(Math.max(execution.start, 0), sourceLength);
      const endOffset = Math.min(Math.max(execution.end, startOffset + 1), sourceLength);
      const startPosition = model.getPositionAt(startOffset);
      const endPosition = model.getPositionAt(Math.max(startOffset, endOffset - 1));
      const label = statementExecutionLabel(execution);
      return {
        range: new monaco.Range(startPosition.lineNumber, 1, endPosition.lineNumber, 1),
        options: {
          isWholeLine: true,
          className: `query-statement-line query-statement-line-${execution.state}`,
          linesDecorationsClassName: `query-statement-bar query-statement-bar-${execution.state}`,
          glyphMarginClassName: `query-statement-glyph query-statement-glyph-${execution.state}`,
          hoverMessage: { value: `SQL ${index + 1}: ${label}` },
        },
      };
    });

    const activeBlocks: monaco.editor.IModelDeltaDecoration[] = activeStatementRanges.map((range) => {
      const startOffset = Math.min(Math.max(range.start, 0), sourceLength);
      const endOffset = Math.min(Math.max(range.end, startOffset + 1), sourceLength);
      const startPosition = model.getPositionAt(startOffset);
      const endPosition = model.getPositionAt(Math.max(startOffset, endOffset - 1));
      return {
        range: new monaco.Range(startPosition.lineNumber, 1, endPosition.lineNumber, model.getLineMaxColumn(endPosition.lineNumber)),
        options: {
          blockClassName: 'query-statement-active-block',
          blockPadding: [2, 8, 2, 8],
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      };
    });

    statementDecorationsRef.current = editorInstance.deltaDecorations(statementDecorationsRef.current, [...decorations, ...activeBlocks]);
    return () => {
      statementDecorationsRef.current = editorInstance.deltaDecorations(statementDecorationsRef.current, []);
    };
  }, [editorInstance, activeTab.query, activeTab.statementExecutions, activeStatementRanges]);

  const runtimeDiagnostics: SqlDiagnostic[] = activeTab.statementExecutions
    .filter((execution) => execution.state === 'error')
    .map((execution) => ({
      start: execution.start,
      end: Math.max(execution.end, execution.start + 1),
      severity: 'error' as const,
      message: execution.message ? `실행 실패: ${execution.message}` : '실행 실패',
    }));
  const allDiagnostics = [...sqlDiagnostics, ...runtimeDiagnostics];

  useEffect(() => {
    if (!editorInstance) return;
    const model = editorInstance.getModel();
    if (!model) return;
    const diagnostics = getSqlDiagnostics(activeTab.query, schema);
    setSqlDiagnostics(diagnostics);
    const markers = [...diagnostics, ...runtimeDiagnostics].map((diagnostic) => {
      const start = model.getPositionAt(Math.max(0, Math.min(diagnostic.start, model.getValueLength())));
      const end = model.getPositionAt(Math.max(diagnostic.start + 1, Math.min(diagnostic.end, model.getValueLength())));
      return {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: Math.max(end.column, start.column + 1),
        message: diagnostic.message,
        severity: diagnostic.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      };
    });
    monaco.editor.setModelMarkers(model, 'rebase-sql-diagnostics', markers);
    return () => monaco.editor.setModelMarkers(model, 'rebase-sql-diagnostics', []);
    // runtimeDiagnostics is derived from the active tab and intentionally part
    // of the dependency list so server errors become squiggles immediately.
  }, [editorInstance, activeTab.id, activeTab.query, activeTab.statementExecutions, schema]);

  const focusDiagnostic = (diagnostic: SqlDiagnostic) => {
    if (!editorInstance) return;
    const model = editorInstance.getModel();
    if (!model) return;
    const position = model.getPositionAt(Math.max(0, Math.min(diagnostic.start, model.getValueLength())));
    editorInstance.setPosition(position);
    editorInstance.revealLineInCenter(position.lineNumber);
    editorInstance.focus();
  };

  // A database context request comes from the schema explorer. It changes the
  // editor context without replacing or executing the current SQL.
  useEffect(() => {
    if (!requestedDatabase) return;
    const targetTabId = activeTabIdRef.current;
    setTabs((prev) => prev.map((t) => (t.id === targetTabId ? { ...t, database: requestedDatabase, statementExecutions: [] } : t)));
    setEditView(null);
    editorInstance?.focus();
  }, [requestedDatabase, requestedNonce, editorInstance]);

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
  const logQueryHistory = useCallback(async (payload: {
    queryText: string;
    durationMs: number;
    success: boolean;
    errorMessage: string | null | undefined;
    rowCount: number | null | undefined;
  }) => {
    const name = await generateQueryTitle({ profileId, queryText: payload.queryText, agentEnabled: agentTitlesEnabled });
    return window.electronAPI.addQueryHistory({
      workspaceId: 'default',
      profileId,
      name,
      ...payload,
    });
  }, [profileId, agentTitlesEnabled]);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await window.electronAPI.getSchemaCompletion(profileId, activeDatabase);
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
  }, [profileId, activeDatabase, schemaVersion]);

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
            if (updated.transactionMode === 'manual') updated.transactionState = 'active';
          } else if (chunk.type === 'row') {
            updated.rows = [...updated.rows, chunk.data ?? []];
          } else if (chunk.type === 'policy') {
            updated.loading = false;
            updated.queryId = null;
            updated.policyPrompt = { code: chunk.code ?? '', message: chunk.message ?? '', verb: chunk.verb ?? '' };
            if (updated.transactionMode === 'manual' && updated.transactionState === 'opening') updated.transactionState = 'idle';
            const runningIndex = updated.statementExecutions.findIndex((execution) => execution.state === 'running');
            if (runningIndex >= 0) {
              updated.statementExecutions = updated.statementExecutions.map((execution, index) =>
                index === runningIndex ? { ...execution, state: 'skipped', message: '정책 확인 필요' } : execution
              );
            }
          } else if (chunk.type === 'done') {
            updated.loading = false;
            updated.rowsAffected = chunk.rowsAffected ?? null;
            updated.truncated = chunk.truncated === true;
            updated.rowLimit = chunk.rowLimit ?? 0;
            updated.elapsedTimeMs = tab.startTime ? Date.now() - tab.startTime : 0;
            updated.queryId = null;
            if (updated.transactionMode === 'manual') updated.transactionState = 'active';
            updated.lastExec = {
              sql: tab.lastExecutedSql ?? tab.query,
              durationMs: updated.elapsedTimeMs,
              rowCount: updated.columns.length > 0 ? updated.rows.length : null,
              rowsAffected: updated.columns.length > 0 ? null : chunk.rowsAffected ?? null,
              error: null,
            };
            const runningIndex = updated.statementExecutions.findIndex((execution) => execution.state === 'running');
            if (runningIndex >= 0) {
              updated.statementExecutions = updated.statementExecutions.map((execution, index) =>
                index === runningIndex ? { ...execution, state: 'success', message: undefined } : execution
              );
            }

            void logQueryHistory({
                queryText: tab.lastExecutedSql ?? tab.query,
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
            if (updated.transactionMode === 'manual') updated.transactionState = 'failed';
            updated.lastExec = { sql: tab.lastExecutedSql ?? tab.query, durationMs: updated.elapsedTimeMs, error: chunk.message };
            const runningIndex = updated.statementExecutions.findIndex((execution) => execution.state === 'running');
            if (runningIndex >= 0) {
              updated.statementExecutions = updated.statementExecutions.map((execution, index) =>
                index === runningIndex ? { ...execution, state: 'error', message: chunk.message ?? undefined } : execution
              );
            }

            void logQueryHistory({
                queryText: tab.lastExecutedSql ?? tab.query,
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
  }, [logQueryHistory, onQueryExecuted]);

  const handleQueryChange = (value: string | undefined) => {
    if (value === undefined) return;
    setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, query: value, statementExecutions: [] } : t)));
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
    opts: { database: string; allowWrite: boolean; confirmDestructive: boolean; fetchAll: boolean; sessionId?: string; tabId: string }
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
          if (transactionSessionsRef.current[opts.tabId]) updateTabTransaction(opts.tabId, { transactionState: 'active' });
        } else if (chunk.type === 'row') {
          rows.push(chunk.data ?? []);
        } else if (chunk.type === 'policy') {
          if (transactionSessionsRef.current[opts.tabId] && tabsRef.current.find((tab) => tab.id === opts.tabId)?.transactionState === 'opening') {
            updateTabTransaction(opts.tabId, { transactionState: 'idle' });
          }
          finish({ policy: { code: chunk.code ?? '', message: chunk.message ?? '', verb: chunk.verb ?? '' } });
        } else if (chunk.type === 'done') {
          if (transactionSessionsRef.current[opts.tabId]) updateTabTransaction(opts.tabId, { transactionState: 'active' });
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
          if (transactionSessionsRef.current[opts.tabId]) updateTabTransaction(opts.tabId, { transactionState: 'failed' });
          finish({
            result: { statement: stmt, columns, rows, rowsAffected: null, error: chunk.message ?? null, truncated: false, rowLimit: 0 },
          });
        }
      });
      if (opts.sessionId && tabsRef.current.find((tab) => tab.id === opts.tabId)?.transactionState === 'idle') {
        updateTabTransaction(opts.tabId, { transactionState: 'opening' });
      }
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
    statementRanges: ReturnType<typeof splitStatementRanges>,
    opts: { database: string; allowWrite: boolean; confirmDestructive: boolean; fetchAll: boolean }
  ) => {
    const statements = statementRanges.map((range) => range.statement);
    const runTabId = activeTabId;
    const currentTab = tabsRef.current.find((tab) => tab.id === runTabId);
    if (currentTab?.transactionMode === 'manual' && currentTab.transactionState === 'failed') return;
    const startTime = Date.now();
    const manualMode = tabsRef.current.find((tab) => tab.id === runTabId)?.transactionMode === 'manual';
    let sessionId: string | undefined;
    multiAbortRef.current = false;
    setTabs((prev) =>
      prev.map((t) =>
        t.id === runTabId
          ? {
              ...t,
              loading: true,
              transactionNotice: null,
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
              statementExecutions: statementRanges.map((range) => ({ ...range, state: 'pending' as const })),
            }
          : t
      )
    );

    if (manualMode) {
      try {
        sessionId = await ensureTransactionSession(runTabId, opts.database, opts.allowWrite);
      } catch (error) {
        setTabs((prev) => prev.map((tab) => tab.id === runTabId
          ? { ...tab, loading: false, error: error instanceof Error ? error.message : String(error) }
          : tab));
        return;
      }
    }

    const collected: ResultSet[] = [];
    let policy: PolicyPrompt | null = null;
    for (const [statementIndex, stmt] of statements.entries()) {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === runTabId
            ? {
                ...t,
                statementExecutions: t.statementExecutions.map((execution, index) =>
                  index === statementIndex ? { ...execution, state: 'running', message: undefined } : execution
                ),
              }
            : t
        )
      );
      const r = await runSingleStatementCollected(stmt, { ...opts, sessionId, tabId: runTabId });
      if (r.policy) {
        policy = r.policy;
        setTabs((prev) =>
          prev.map((t) =>
            t.id === runTabId
              ? {
                  ...t,
                  statementExecutions: t.statementExecutions.map((execution, index) =>
                    index === statementIndex ? { ...execution, state: 'skipped', message: '정책 확인 필요' } : execution
                  ),
                }
              : t
          )
        );
        break;
      }
      if (r.result) {
        collected.push(r.result);
        void logQueryHistory({
            queryText: stmt,
            durationMs: 0,
            success: !r.result.error,
            errorMessage: r.result.error,
            rowCount: r.result.rows.length || r.result.rowsAffected || 0,
          })
          .then(() => onQueryExecuted?.())
          .catch(() => {});
        const snapshot = [...collected];
        setTabs((prev) =>
          prev.map((t) =>
            t.id === runTabId
              ? {
                  ...t,
                  resultSets: snapshot,
                  statementExecutions: t.statementExecutions.map((execution, index) =>
                    index === statementIndex
                      ? {
                          ...execution,
                          state: r.result?.error ? 'error' : 'success',
                          message: r.result?.error ?? undefined,
                        }
                      : execution
                  ),
                }
              : t
          )
        );
        if (r.result.error) break; // stop the script on the first failure
      } else {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === runTabId
              ? {
                  ...t,
                  statementExecutions: t.statementExecutions.map((execution, index) =>
                    index === statementIndex ? { ...execution, state: 'error', message: '실행 결과를 받지 못했습니다.' } : execution
                  ),
                }
              : t
          )
        );
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
        t.id === runTabId
          ? {
              ...t,
              loading: false,
              elapsedTimeMs: elapsed,
              activeResultIndex: 0,
              policyPrompt: policy ?? t.policyPrompt,
              lastExec,
              statementExecutions: t.statementExecutions.map((execution) =>
                execution.state === 'pending' || execution.state === 'running'
                  ? { ...execution, state: 'skipped', message: '실행되지 않음' }
                  : execution
              ),
            }
          : t
      )
    );
  };

  // Returns true for statements that should go through the analyze gate.
  const isRiskyStatement = (stmt: string): boolean => {
    if (classifyStatement(stmt).risk === 'dangerous') return true;
    return /^\s*(UPDATE|DELETE|INSERT|TRUNCATE|DROP|ALTER|REPLACE|MERGE)\b/i.test(stmt);
  };

  const executeQuery = async (override?: {
    allowWrite?: boolean;
    confirmDestructive?: boolean;
    fetchAll?: boolean;
    sqlOverride?: string;
    acknowledged?: boolean;
    databaseOverride?: string;
    statementRangesOverride?: SqlStatementRange[];
  }) => {
    if (activeTab.loading) return;

    const allowWrite = override?.allowWrite ?? writeMode;
    const confirmDestructive = override?.confirmDestructive ?? false;
    const fetchAll = override?.fetchAll ?? false;
    const acknowledged = override?.acknowledged ?? false;
    const sql = override?.sqlOverride ?? activeTab.query;
    const queryDatabase = override?.databaseOverride ?? activeDatabase;

    // A script of several statements runs sequentially with one result set each
    // (DataGrip-style). A single statement keeps the existing streaming path.
    const statementRanges = override?.statementRangesOverride ?? splitStatementRanges(sql);
    const statements = statementRanges.map((range) => range.statement);
    if (statements.length > 1) {
      setEditView(null);
      await runMultiStatements(statementRanges, { database: queryDatabase, allowWrite, confirmDestructive, fetchAll });
      return;
    }

    // A plain single-table SELECT * → show an editable table view of that table
    // instead of running a read-only result grid.
    const editable = analyzeEditableQuery(sql);
    if (editable && activeTab.transactionMode === 'auto') {
      setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, query: sql, error: null, policyPrompt: null } : t)));
      setEditView(editable);
      return;
    }
    setEditView(null);

    if (activeTab.transactionMode === 'manual' && activeTab.transactionState === 'failed') return;

    // Analyze gate: for risky single statements (DML/DDL), call analyzeQuery and
    // show the RiskConfirmDialog before streaming. If analysis fails, fall through.
    if (!acknowledged && isRiskyStatement(sql)) {
      try {
        const analyzeRes = await window.electronAPI.analyzeQuery(profileId, sql, queryDatabase);
        if (analyzeRes.success && analyzeRes.data) {
          // Capture the run continuation — the explicit dialog confirmation
          // authorizes this execution without changing the persistent mode.
          pendingRunRef.current = () => {
            setRiskResult(null);
            void executeQuery(withExplicitRiskApproval({ ...override, sqlOverride: sql }));
          };
          setRiskResult(analyzeRes.data);
          return; // halt until user acts
        }
        // analyzeQuery failed (engine unreachable, parse error, etc.) → fall through
      } catch {
        // ignore analysis errors — never block execution
      }
    }

    const queryId = `query-${crypto.randomUUID()}`;
    const startTime = Date.now();

    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              loading: true,
              transactionNotice: null,
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
              lastExecutedSql: sql,
              statementExecutions: statementRanges.map((range) => ({ ...range, state: 'running' as const })),
            }
          : t
      )
    );

    try {
      const sessionId = activeTab.transactionMode === 'manual'
        ? await ensureTransactionSession(activeTab.id, queryDatabase, allowWrite)
        : undefined;
      if (sessionId) updateTabTransaction(activeTab.id, { transactionState: 'opening' });
      const res = await window.electronAPI.executeQueryStream(queryId, profileId, sql, {
        database: queryDatabase,
        sessionId,
        allowWrite,
        confirmDestructive,
        fetchAll,
        acknowledged,
      });
      if (!res.success) {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === activeTabId
              ? {
                  ...t,
                  loading: false,
                  error: res.error || 'Failed to start query',
                  queryId: null,
                  transactionState: t.transactionMode === 'manual' ? 'idle' : t.transactionState,
                  statementExecutions: t.statementExecutions.map((execution) =>
                    execution.state === 'running' ? { ...execution, state: 'error', message: res.error || 'Failed to start query' } : execution
                  ),
                }
              : t
          )
        );
      }
    } catch (e) {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId
            ? {
                ...t,
                loading: false,
                error: e instanceof Error ? e.message : 'Execution request failed',
                queryId: null,
                transactionState: t.transactionMode === 'manual' ? 'idle' : t.transactionState,
                statementExecutions: t.statementExecutions.map((execution) =>
                  execution.state === 'running'
                    ? { ...execution, state: 'error', message: e instanceof Error ? e.message : 'Execution request failed' }
                    : execution
                ),
              }
            : t
        )
      );
    }
  };

  // One-click "load this SQL and run it" requests (e.g. table → recent rows).
  useEffect(() => {
    if (!requestedExecute || !requestedSql || !requestedDatabase) return;
    const sql = requestedSql;
    const targetTabId = activeTabIdRef.current;
    setTabs((prev) => prev.map((t) => (t.id === targetTabId ? { ...t, database: requestedDatabase, query: sql } : t)));
    void executeQuery({ sqlOverride: sql, databaseOverride: requestedDatabase });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedExecute, requestedSql, requestedDatabase, requestedNonce]);

  const formatQuery = () => {
    const formatted = formatSql(activeTab.query, driver);
    if (formatted === activeTab.query) return;
    setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, query: formatted } : t)));
  };

  // Keep refs to the latest handlers so Monaco keybindings (registered once on
  // mount) always run the current closures, not stale ones.
  const runCurrentStatementRef = useRef<() => void>(() => {});
  runCurrentStatementRef.current = () => {
    if (activeTab.loading || !activeTab.query.trim() || !editorInstance) return;
    const model = editorInstance.getModel();
    const position = editorInstance.getPosition();
    if (!model || !position) return;
    const selection = editorInstance.getSelection();
    const target = resolveSqlExecutionTarget(model.getValue(), {
      cursorOffset: model.getOffsetAt(position),
      selectionStart: selection ? model.getOffsetAt(selection.getStartPosition()) : undefined,
      selectionEnd: selection ? model.getOffsetAt(selection.getEndPosition()) : undefined,
    });
    if (!target) return;
    void executeQuery({ sqlOverride: target.sql, statementRangesOverride: target.ranges });
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
    setTabs((prev) => [...prev, newTab(id, `Query ${prev.length + 1}`, activeDatabase, 'SELECT * FROM ')]);
    setActiveTabId(id);
  };

  const closeTab = async (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabs.length === 1) return;
    const target = tabs.find((t) => t.id === tabId);
    if (target?.transactionMode === 'manual' && ['opening', 'active', 'failed'].includes(target.transactionState)) {
      if (!window.confirm('이 탭을 닫으면 미커밋 변경 사항이 Rollback 됩니다. 계속할까요?')) return;
    }
    if (target?.loading && target.queryId) {
      await window.electronAPI.cancelQuery(target.queryId);
    }
    try {
      await closeTransactionSession(tabId);
    } catch (error) {
      alert(error instanceof Error ? error.message : '트랜잭션 세션을 닫지 못했습니다.');
      return;
    }
    const filtered = tabs.filter((t) => t.id !== tabId);
    setTabs(filtered);
    if (activeTabId === tabId) setActiveTabId(filtered[filtered.length - 1].id);
  };

  const openSaveModal = () => {
    setSaveQueryName('');
    setSaveNameTouched(false);
    setShowSaveModal(true);
  };

  const closeSaveModal = () => {
    setShowSaveModal(false);
    setSaveQueryName('');
    setSaveNameTouched(false);
    setTitleSuggesting(false);
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
        closeSaveModal();
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

  useEffect(() => {
    if (!showSaveModal || saveNameTouched) return;
    let ignore = false;
    setTitleSuggesting(true);
    generateQueryTitle({ profileId, queryText: activeTab.query, agentEnabled: true })
      .then((title) => {
        if (!ignore) setSaveQueryName(title);
      })
      .finally(() => {
        if (!ignore) setTitleSuggesting(false);
      });
    return () => {
      ignore = true;
    };
  }, [showSaveModal, saveNameTouched, profileId, activeTab.query]);

  const prompt = activeTab.policyPrompt;

  return (
    <div className="editor">
      {/* Tabs */}
      <div className="editor-tabs">
        <div className="editor-conn" title={`${connectionName} · ${driver} · ${activeDatabase}`}>
          <span className={`driver-chip sm ${driver}`}>{DRIVER_LABEL[driver]}</span>
          <span className="editor-conn-name">{connectionName}</span>
          {activeDatabase && <span className="editor-conn-db">{activeDatabase}</span>}
        </div>
        <span className="editor-tabs-sep" />
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`etab ${activeTabId === tab.id ? 'active' : ''}`}
            aria-label={formatQueryTabLabel(tab.name, tab.database)}
            onClick={() => setActiveTabId(tab.id)}
          >
            <span className="etab-name">{tab.name}</span>
            {tab.database && <span className="etab-db" title={`스키마: ${tab.database}`}>{tab.database}</span>}
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
        <span className="editor-tabs-fill" />
        {onOpenLibrary && (
          <button className="btn btn-secondary btn-sm query-library-action" onClick={onOpenLibrary}>
            <BookOpen size={13} /> Query Library
          </button>
        )}
      </div>

      {/* Monaco */}
      <div className="monaco-host">
        <MonacoEditor
          height={`${editorHeight}px`}
          language="sql"
          theme={resolved === 'light' ? 'vs' : 'vs-dark'}
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
                runCurrentStatementRef.current();
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
            glyphMargin: true,
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

      {allDiagnostics.length > 0 && (
        <div className="query-diagnostics" data-testid="sql-diagnostics" role="region" aria-label="SQL diagnostics">
          <div className="query-diagnostics-head">
            <AlertTriangle size={13} />
            <span>{allDiagnostics.length}개 진단 결과</span>
            <span className="query-diagnostics-hint">항목을 클릭하면 해당 위치로 이동합니다</span>
          </div>
          <div className="query-diagnostics-list">
            {allDiagnostics.map((diagnostic, index) => {
              const model = editorInstance?.getModel();
              const line = model ? model.getPositionAt(diagnostic.start).lineNumber : 0;
              return (
                <button
                  key={`${diagnostic.start}-${diagnostic.end}-${index}`}
                  className={`query-diagnostic query-diagnostic-${diagnostic.severity}`}
                  onClick={() => focusDiagnostic(diagnostic)}
                  title="클릭하여 문제 위치로 이동"
                >
                  <span className="query-diagnostic-line">{line > 0 ? `L${line}` : 'SQL'}</span>
                  <span>{diagnostic.message}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

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
            <button className="btn btn-primary btn-sm" onClick={() => executeQuery()} disabled={!activeTab.query.trim() || (activeTab.transactionMode === 'manual' && activeTab.transactionState === 'failed')}>
              <Play size={13} /> Run
            </button>
          )}
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => { if (explainSql) void executeQuery({ sqlOverride: explainSql }); }}
            disabled={!explainSql || activeTab.loading}
            title={explainSql ? 'Show query execution plan (non-executing EXPLAIN)' : 'Visual EXPLAIN is supported for one statement on MySQL, PostgreSQL, and SQLite'}
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
            onClick={openSaveModal}
            disabled={!activeTab.query.trim() || activeTab.loading}
          >
            <Save size={13} /> Save
          </button>
        </div>
        <div className="toolbar-right">
          {activeTab.loading && <span className="spinner" />}
          {activeTab.elapsedTimeMs !== null && <span className="elapsed">{activeTab.elapsedTimeMs} ms</span>}
          <div className="mode-toggle">
            <button className={`mode-opt ${!writeMode ? 'active' : ''}`} onClick={() => void changeWriteMode(false)}>
              <Lock size={11} /> Read-only
            </button>
            <button className={`mode-opt write ${writeMode ? 'active' : ''}`} onClick={() => void changeWriteMode(true)}>
              <Pencil size={11} /> Write
            </button>
          </div>
          {driver !== 'redis' && <div className="transaction-controls" aria-label="Query transaction controls">
            <div className="mode-toggle transaction-mode-toggle">
              <button
                className={`mode-opt ${activeTab.transactionMode === 'auto' ? 'active' : ''}`}
                data-testid="tx-mode-auto"
                aria-pressed={activeTab.transactionMode === 'auto'}
                onClick={() => void setTransactionMode(activeTab.id, 'auto')}
                title="각 쿼리를 자동으로 커밋합니다"
              >Auto</button>
              <button
                className={`mode-opt ${activeTab.transactionMode === 'manual' ? 'active' : ''}`}
                data-testid="tx-mode-manual"
                aria-pressed={activeTab.transactionMode === 'manual'}
                onClick={() => void setTransactionMode(activeTab.id, 'manual')}
                title="명시적으로 Commit 또는 Rollback 할 때까지 변경 사항을 보류합니다"
              >Manual</button>
            </div>
            <span
              className={`transaction-status transaction-status-${activeTab.transactionState}`}
              data-testid="transaction-status"
              role="status"
              title={activeTab.transactionMode === 'manual' ? '이 쿼리 탭 전용 트랜잭션' : '각 쿼리 실행 후 자동 커밋'}
            >
              <Database size={12} /> {getTransactionStatusLabel(activeTab.transactionMode, activeTab.transactionState)}
            </span>
            <button
              className="btn btn-secondary btn-sm transaction-action"
              data-testid="tx-commit"
              onClick={() => void finishTransaction('commit')}
              disabled={!getTransactionControls(activeTab.transactionMode, activeTab.transactionState, activeTab.loading).commit}
              title="현재 탭의 변경 사항을 커밋합니다"
            ><Check size={13} /> Commit</button>
            <button
              className="btn btn-secondary btn-sm transaction-action"
              data-testid="tx-rollback"
              onClick={() => void finishTransaction('rollback')}
              disabled={!getTransactionControls(activeTab.transactionMode, activeTab.transactionState, activeTab.loading).rollback}
              title="현재 탭의 변경 사항을 되돌립니다"
            ><RotateCcw size={13} /> Rollback</button>
            {activeTab.transactionNotice && <span className="transaction-notice" role="status">{activeTab.transactionNotice}</span>}
          </div>}
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
                onClick={async () => {
                  if (await changeWriteMode(true)) await executeQuery({ allowWrite: true });
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
            database={activeDatabase}
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
              isExplainResult ? (
                activeTab.loading ? (
                  <div className="explain-plan-loading"><span className="spinner" /> Building execution plan…</div>
                ) : (
                  <ExplainPlanView
                    key={`${activeTab.id}:${activeTab.lastExecutedSql}`}
                    driver={driver}
                    columns={activeTab.columns}
                    rows={activeTab.rows}
                  />
                )
              ) : (
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
                  {activeTab.columns.length > 0 && (
                    <details className="narrator-wrap">
                      <summary>업무 문장 생성</summary>
                      <ResultNarrator profileId={profileId} sql={activeTab.query} columns={activeTab.columns} rows={activeTab.rows} />
                    </details>
                  )}
                </>
              )
            )}
          </>
        )}
      </div>
      )}

      {/* Execution status: last query, time, rows (click to expand). */}
      {!editView && <ExecStatusBar info={activeTab.lastExec} />}

      {/* Save modal */}
      {showSaveModal && (
        <div className="modal-overlay" onClick={closeSaveModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Save query</h3>
            <form onSubmit={handleSaveSQL}>
              <div>
                <label>Query name</label>
                <input
                  type="text"
                  placeholder={titleSuggesting ? 'AI 제목 생성 중…' : 'e.g. Active users'}
                  value={saveQueryName}
                  onChange={(e) => {
                    setSaveNameTouched(true);
                    setSaveQueryName(e.target.value);
                  }}
                  autoFocus
                  required
                />
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={closeSaveModal}>
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

      {/* Risk confirm dialog — shown before executing a risky statement */}
      {riskResult && (
        <RiskConfirmDialog
          result={riskResult}
          safeMode={safeMode}
          onRun={() => pendingRunRef.current?.()}
          onCancel={() => { setRiskResult(null); pendingRunRef.current = null; }}
        />
      )}
    </div>
  );
};
