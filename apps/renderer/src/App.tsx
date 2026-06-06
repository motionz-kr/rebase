import React, { useState, useEffect, useCallback, useReducer } from 'react';
import {
  Database,
  Plus,
  Pencil,
  RefreshCw,
  Trash2,
  Unplug,
  X,
  AlertTriangle,
  Server,
  ChevronRight,
  Bot,
  DownloadCloud,
} from 'lucide-react';
import { clampSidebarWidth, SIDEBAR_DEFAULT, clampModalWidth, MODAL_DEFAULT, loadNum, saveNum } from './lib/uiPrefs';
import { loadHidden, saveHidden, type HiddenStore } from './lib/tableVisibility';
import { SchemaExplorer } from './components/SchemaExplorer';
import { ConnectionTablePrefs } from './components/ConnectionTablePrefs';
import { UpdateButton } from './components/UpdateButton';
import { McpConnectPanel } from './components/McpConnectPanel';
import { QueryEditor } from './components/QueryEditor';
import { RedisKeyspaceExplorer } from './components/RedisKeyspaceExplorer';
import { RedisValueInspector } from './components/RedisValueInspector';
import { RedisConsole } from './components/RedisConsole';
import { AgentChat } from './components/AgentChat';
import { SavedQueries } from './components/SavedQueries';
import { QueryHistory } from './components/QueryHistory';
import { TableDataView } from './components/TableDataView';
import { ErDiagram } from './components/ErDiagram';
import { MongoExplorer } from './components/MongoExplorer';
import { MongoDocumentView } from './components/MongoDocumentView';
import { MongoQueryEditor } from './components/MongoQueryEditor';
import { MongoIndexManager } from './components/MongoIndexManager';
import { MongoSchemaPanel } from './components/MongoSchemaPanel';
import { SettingsPopover } from './components/SettingsPopover';
import { connectionsReducer, initialConnectionsState } from './state/connections';
import './App.css';

export interface ConnectionProfile {
  id?: string;
  name: string;
  driver: 'mysql' | 'postgres' | 'redis' | 'sqlite' | 'sqlserver' | 'mongodb';
  host: string;
  port: number;
  database: string;
  username: string;
  connectionUri?: string;
  secretRef?: string;
  tlsMode: 'none' | 'prefer' | 'require';
  readOnly?: boolean;
  mcpEnabled?: boolean;
  mcpDataExposure?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface HealthResult {
  success: boolean;
  port?: number;
  pid?: number;
  error?: string;
}

const DRIVER_LABEL: Record<string, string> = { mysql: 'MY', postgres: 'PG', redis: 'RS', sqlite: 'SQ', sqlserver: 'MS', mongodb: 'MG' };

function App() {
  const [status, setStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking');
  const [engineInfo, setEngineInfo] = useState<{ port?: number; pid?: number } | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const [sidebarWidth, setSidebarWidth] = useState(() => clampSidebarWidth(loadNum('rebase.ui.sidebarWidth', SIDEBAR_DEFAULT)));
  useEffect(() => saveNum('rebase.ui.sidebarWidth', sidebarWidth), [sidebarWidth]);
  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => setSidebarWidth(clampSidebarWidth(startW + (ev.clientX - startX)));
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // Connection form modal width — drag the modal's edge to resize. Centered, so
  // the edge follows the cursor when width grows by 2× the horizontal delta.
  const [modalWidth, setModalWidth] = useState(() => clampModalWidth(loadNum('rebase.ui.connModalWidth', MODAL_DEFAULT)));
  useEffect(() => saveNum('rebase.ui.connModalWidth', modalWidth), [modalWidth]);
  const startModalResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = modalWidth;
    const onMove = (ev: MouseEvent) => setModalWidth(clampModalWidth(startW + (ev.clientX - startX) * 2));
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);

  // Multiple open connections (status + focus). Per-connection editor/results
  // state is preserved by keeping each panel mounted (hidden when not focused).
  const [conns, dispatch] = useReducer(connectionsReducer, initialConnectionsState);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [redisKeys, setRedisKeys] = useState<Record<string, string | null>>({});
  const [redisRefresh, setRedisRefresh] = useState<Record<string, number>>({});
  const [redisTab, setRedisTab] = useState<Record<string, 'inspector' | 'console'>>({});
  const [showAgent, setShowAgent] = useState(false);
  const [agentPopped, setAgentPopped] = useState(false);

  const [showCreateForm, setShowCreateForm] = useState(false);
  // Active tab inside the connection modal: basic info / schema (table visibility) / MCP.
  const [formTab, setFormTab] = useState<'basic' | 'schema' | 'mcp'>('basic');
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Focused connection's secondary sidebar panel (saved/history)
  const [sideTab, setSideTab] = useState<'saved' | 'history'>('saved');
  const [selectedQueryText, setSelectedQueryText] = useState<string>('');
  // One-click "load + run this SQL" request, targeted at a connection's editor.
  const [runReq, setRunReq] = useState<{ profileId: string; sql: string; nonce: number } | null>(null);
  // "Load this command into the input" request for non-SQL editors (redis/mongo).
  // Unlike runReq it does NOT auto-execute — the user presses run.
  const [loadReq, setLoadReq] = useState<{ profileId: string; text: string; nonce: number } | null>(null);
  const [historyTrigger, setHistoryTrigger] = useState(0);
  const [savedTrigger, setSavedTrigger] = useState(0);
  const [schemaVersion, setSchemaVersion] = useState(0);
  const [openTable, setOpenTable] = useState<Record<string, { db: string; table: string; filter?: { col: string; value: string } } | null>>({});
  const [erTab, setErTab] = useState<Record<string, { db: string } | null>>({});
  const [mongoView, setMongoView] = useState<
    Record<string, { database: string; collection: string; mode: 'documents' | 'query' | 'indexes' | 'schema' } | null>
  >({});

  // Create form state
  const [formDriver, setFormDriver] = useState<'mysql' | 'postgres' | 'redis' | 'sqlite' | 'sqlserver' | 'mongodb'>('mysql');
  const [formName, setFormName] = useState('');
  const [formConnectionUri, setFormConnectionUri] = useState('');
  const [formHost, setFormHost] = useState('127.0.0.1');
  const [formPort, setFormPort] = useState(3306);
  const [formDatabase, setFormDatabase] = useState('');
  const [formUsername, setFormUsername] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formTlsMode, setFormTlsMode] = useState<'none' | 'prefer' | 'require'>('none');
  const [formReadOnly, setFormReadOnly] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Per-connection hidden-tables map, lifted here so both the schema explorer
  // (which filters the tree) and the connection Edit dialog (which sets it) stay
  // in sync within the same tab. Persisted to localStorage on every change.
  const [hiddenStore, setHiddenStore] = useState<HiddenStore>(loadHidden);
  const updateHidden = useCallback((next: HiddenStore) => {
    setHiddenStore(next);
    saveHidden(next);
  }, []);

  useEffect(() => {
    // Intentional load-on-mount; loadProfiles manages its own state.
    // eslint-disable-next-line react-hooks/immutability
    loadProfiles();
  }, []);

  // Escape closes the top-most open modal. Every modal overlay closes on its own
  // click handler, so we just trigger that on the last .modal-overlay in the DOM.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const overlays = document.querySelectorAll<HTMLElement>('.modal-overlay');
      const top = overlays[overlays.length - 1];
      if (top) {
        e.preventDefault();
        top.click();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const loadProfiles = async () => {
    try {
      const res = await window.electronAPI.listProfiles();
      if (res.success && res.data) setProfiles(res.data);
    } catch (e) {
      console.error('Failed to load profiles:', e);
    }
  };

  const handleDriverChange = (driver: 'mysql' | 'postgres' | 'redis' | 'sqlite' | 'sqlserver' | 'mongodb') => {
    setFormDriver(driver);
    if (driver === 'mysql') {
      setFormPort(3306);
      setFormDatabase('dev-mysql');
      setFormUsername('root');
    } else if (driver === 'postgres') {
      setFormPort(5432);
      setFormDatabase('postgres');
      setFormUsername('postgres');
    } else if (driver === 'sqlserver') {
      setFormPort(1433);
      setFormDatabase('master');
      setFormUsername('sa');
    } else if (driver === 'mongodb') {
      setFormPort(27017);
      setFormDatabase('');
      setFormUsername('');
    } else if (driver === 'sqlite') {
      setFormPort(0);
      setFormDatabase('');
      setFormUsername('');
    } else {
      setFormPort(6379);
      setFormDatabase('');
      setFormUsername('');
    }
  };

  const resetForm = () => {
    setFormName('');
    handleDriverChange('mysql');
    setFormConnectionUri('');
    setFormPassword('');
    setFormReadOnly(false);
    setEditingId(null);
    setFormTab('basic');
  };

  const startEdit = (p: ConnectionProfile, e: React.MouseEvent) => {
    e.stopPropagation();
    setFormDriver(p.driver);
    setFormName(p.name);
    setFormHost(p.host);
    setFormPort(p.port);
    setFormDatabase(p.database);
    setFormUsername(p.username);
    setFormConnectionUri(p.connectionUri ?? '');
    setFormPassword(''); // blank keeps the existing password
    setFormTlsMode(p.tlsMode);
    setFormReadOnly(p.readOnly ?? false);
    setEditingId(p.id!);
    setConnectionError(null);
    setFormTab('basic');
    setShowCreateForm(true);
  };

  const handleTestConnection = async () => {
    setConnectionError(null);
    const profile: ConnectionProfile = {
      name: formName || 'Test Profile',
      driver: formDriver,
      host: formDriver === 'sqlite' ? '' : formHost,
      port: formDriver === 'sqlite' ? 0 : formPort,
      database: formDatabase,
      username: formDriver === 'sqlite' ? '' : formUsername,
      connectionUri: formConnectionUri,
      tlsMode: formTlsMode,
      readOnly: formReadOnly,
    };
    try {
      const res = await window.electronAPI.testConnection(profile, formPassword);
      if (res.success) alert('Connection test succeeded.');
      else setConnectionError(res.error || 'Connection failed');
    } catch (e) {
      setConnectionError(e instanceof Error ? e.message : 'Error during connection test');
    }
  };

  const handleCreateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName) {
      alert('Please enter a profile name');
      return;
    }
    setConnectionError(null);
    const profile: ConnectionProfile = {
      name: formName,
      driver: formDriver,
      host: formDriver === 'sqlite' ? '' : formHost,
      port: formDriver === 'sqlite' ? 0 : formPort,
      database: formDatabase,
      username: formDriver === 'sqlite' ? '' : formUsername,
      connectionUri: formConnectionUri,
      tlsMode: formTlsMode,
      readOnly: formReadOnly,
    };
    try {
      const res = editingId
        ? await window.electronAPI.updateProfile({ ...profile, id: editingId }, formPassword)
        : await window.electronAPI.createProfile(profile, formPassword);
      if (res.success && res.data) {
        setShowCreateForm(false);
        setEditingId(null);
        resetForm();
        loadProfiles();
      } else {
        setConnectionError(res.error || (editingId ? 'Failed to update profile' : 'Failed to create profile'));
      }
    } catch (e) {
      setConnectionError(e instanceof Error ? e.message : 'Error while saving profile');
    }
  };

  const handleDeleteProfile = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Delete this connection profile?')) return;
    try {
      const res = await window.electronAPI.deleteProfile(id);
      if (res.success) {
        dispatch({ type: 'close', profileId: id });
        loadProfiles();
      } else {
        alert(res.error || 'Failed to delete profile');
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error occurred');
    }
  };

  // Connect (lazy) and focus a profile
  const connect = async (p: ConnectionProfile) => {
    if (!p.id) return;
    dispatch({ type: 'open', profileId: p.id });
    setExpanded((prev) => ({ ...prev, [p.id!]: true }));
    try {
      const res = await window.electronAPI.testConnection(p);
      if (res.success) dispatch({ type: 'ready', profileId: p.id });
      else dispatch({ type: 'failed', profileId: p.id, error: res.error || 'Connection failed' });
    } catch (e) {
      dispatch({ type: 'failed', profileId: p.id, error: e instanceof Error ? e.message : 'Connection error' });
    }
  };

  // Click a connection row: connect+focus if needed, else just focus
  const onClickConnection = (p: ConnectionProfile) => {
    if (!p.id) return;
    const entry = conns.byId[p.id];
    if (!entry || entry.status === 'error') {
      connect(p);
    } else {
      dispatch({ type: 'focus', profileId: p.id });
    }
  };

  const toggleExpand = (p: ConnectionProfile, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!p.id) return;
    const entry = conns.byId[p.id];
    if (!entry || entry.status === 'error') {
      connect(p);
      return;
    }
    setExpanded((prev) => ({ ...prev, [p.id!]: !prev[p.id!] }));
  };

  const disconnect = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    dispatch({ type: 'close', profileId: id });
    setExpanded((prev) => ({ ...prev, [id]: false }));
    setRedisKeys((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const checkHealth = useCallback(async (manual = false) => {
    if (manual) setIsRefreshing(true);
    try {
      if (window.electronAPI && typeof window.electronAPI.checkEngineHealth === 'function') {
        const res: HealthResult = await window.electronAPI.checkEngineHealth();
        if (res.success) {
          setStatus('connected');
          setEngineInfo({ port: res.port, pid: res.pid });
          setEngineError(null);
        } else {
          setStatus('disconnected');
          setEngineInfo(null);
          setEngineError(res.error || 'Engine health check failed');
        }
      } else {
        setStatus('disconnected');
        setEngineError('electronAPI not found. Run inside Electron.');
      }
    } catch (e) {
      setStatus('disconnected');
      setEngineInfo(null);
      setEngineError(e instanceof Error ? e.message : 'Failed to call checkEngineHealth');
    } finally {
      if (manual) setTimeout(() => setIsRefreshing(false), 500);
    }
  }, []);

  useEffect(() => {
    // Intentional health poll on mount; checkHealth manages its own state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    checkHealth();
    const interval = setInterval(() => checkHealth(), 3000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  const focusedProfile = conns.focusedId ? profiles.find((p) => p.id === conns.focusedId) : null;

  const handleSelectQuery = (queryText: string) => {
    // Redis/Mongo: load the command into the focused connection's editor input.
    if (focusedProfile && (focusedProfile.driver === 'redis' || focusedProfile.driver === 'mongodb')) {
      setLoadReq({ profileId: focusedProfile.id!, text: queryText, nonce: Date.now() });
      return;
    }
    // SQL: load into the active SQL editor tab.
    setSelectedQueryText(queryText);
    setTimeout(() => setSelectedQueryText(''), 100);
  };

  if (typeof window.electronAPI === 'undefined') {
    return (
      <div className="boot-screen">
        <div className="boot-card">
          <div className="empty-state">
            <div className="es-icon">
              <AlertTriangle size={22} />
            </div>
            <h2>Electron environment required</h2>
            <p>Launch with the desktop runner:</p>
            <code>pnpm dev</code>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name" aria-label="Rebase">
            {'Rebase'.split('').map((ch, i) => (
              <span
                key={i}
                className="logo-ch"
                aria-hidden="true"
                style={{ animationDelay: `${i * 0.1}s`, ['--rest' as string]: i < 2 ? 'var(--text-2)' : 'var(--text-3)' } as React.CSSProperties}
              >
                {ch}
              </span>
            ))}
          </span>
        </div>
        <div className="topbar-status">
          <UpdateButton />
          <button
            className={`btn btn-secondary btn-sm agent-toggle${showAgent ? ' active' : ''}`}
            onClick={() => setShowAgent((v) => !v)}
            title="Toggle the AI agent panel"
          >
            <Bot size={14} /> Agent
          </button>
          <span className={`status-pill ${status}`}>
            <span className="status-dot" />
            {status === 'connected' ? 'Engine ready' : status === 'checking' ? 'Connecting' : 'Engine down'}
            {engineInfo?.port && <span className="status-port">:{engineInfo.port}</span>}
          </span>
          <button className="icon-btn" onClick={() => checkHealth(true)} title="Refresh engine health" disabled={isRefreshing}>
            <RefreshCw size={14} className={isRefreshing ? 'spin' : ''} />
          </button>
          <button className="icon-btn" onClick={() => window.electronAPI.updateCheck()} title="업데이트 확인">
            <DownloadCloud size={14} />
          </button>
          <SettingsPopover />
        </div>
      </header>

      <div className="app-body">
        {/* Sidebar: connection tree */}
        <aside className="sidebar" style={{ width: sidebarWidth, flexShrink: 0 }}>
          <div className="sidebar-head">
            <h2>Connections</h2>
            <button
              className="btn btn-secondary btn-xs"
              onClick={() => {
                setShowCreateForm(!showCreateForm);
                if (!showCreateForm) resetForm();
              }}
            >
              {showCreateForm ? (
                <>
                  <X size={13} /> Cancel
                </>
              ) : (
                <>
                  <Plus size={13} /> New
                </>
              )}
            </button>
          </div>

          {showCreateForm && (
            <div className="modal-overlay" onClick={() => setShowCreateForm(false)}>
              <div className="modal conn-modal" style={{ width: modalWidth }} onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                  <h3>{editingId ? '연결 수정' : '새 연결'}</h3>
                  <button className="icon-btn" onClick={() => setShowCreateForm(false)} aria-label="닫기">
                    <X size={15} />
                  </button>
                </div>
                {editingId && (formDriver === 'mysql' || formDriver === 'postgres' || formDriver === 'sqlserver') && (
                  <div className="seg-tabs conn-modal-tabs">
                    <button type="button" className={`seg-tab ${formTab === 'basic' ? 'active' : ''}`} onClick={() => setFormTab('basic')}>
                      기본 정보
                    </button>
                    <button type="button" className={`seg-tab ${formTab === 'schema' ? 'active' : ''}`} onClick={() => setFormTab('schema')}>
                      스키마
                    </button>
                    <button type="button" className={`seg-tab ${formTab === 'mcp' ? 'active' : ''}`} onClick={() => setFormTab('mcp')}>
                      MCP
                    </button>
                  </div>
                )}
                <div className={`conn-modal-body${editingId && (formDriver === 'mysql' || formDriver === 'postgres' || formDriver === 'sqlserver') ? ' tabbed' : ''}`}>
                  {formTab === 'basic' && (
                  <form className="conn-form" onSubmit={handleCreateProfile}>
              <div>
                <label>Database type</label>
                <select value={formDriver} onChange={(e) => handleDriverChange(e.target.value as 'mysql' | 'postgres' | 'redis' | 'sqlite' | 'sqlserver' | 'mongodb')}>
                  <option value="mysql">MySQL</option>
                  <option value="postgres">PostgreSQL</option>
                  <option value="sqlserver">SQL Server</option>
                  <option value="mongodb">MongoDB</option>
                  <option value="redis">Redis</option>
                  <option value="sqlite">SQLite</option>
                </select>
              </div>
              <div>
                <label>Profile name</label>
                <input type="text" placeholder="e.g. Prod DB" value={formName} onChange={(e) => setFormName(e.target.value)} required />
              </div>
              {formDriver === 'sqlite' ? (
                <>
                  <div>
                    <label>Database file</label>
                    <div className="field-row">
                      <input
                        className="field-grow"
                        type="text"
                        value={formDatabase}
                        onChange={(e) => setFormDatabase(e.target.value)}
                        placeholder="/path/to/database.db"
                        required
                      />
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={async () => {
                          const path = await window.electronAPI.pickSqliteFile();
                          if (path) setFormDatabase(path);
                        }}
                      >
                        찾아보기
                      </button>
                    </div>
                  </div>
                  <div className="field-check">
                    <label>
                      <input type="checkbox" checked={formReadOnly} onChange={(e) => setFormReadOnly(e.target.checked)} />
                      읽기 전용 (read-only)
                    </label>
                  </div>
                </>
              ) : (
                <>
              <div className="field-row">
                <div className="field-grow">
                  <label>Host</label>
                  <input type="text" value={formHost} onChange={(e) => setFormHost(e.target.value)} required />
                </div>
                <div className="field-shrink">
                  <label>Port</label>
                  <input type="number" value={formPort} onChange={(e) => setFormPort(parseInt(e.target.value))} required />
                </div>
              </div>
              {formDriver !== 'redis' ? (
                <div>
                  <label>Database</label>
                  <input type="text" value={formDatabase} onChange={(e) => setFormDatabase(e.target.value)} required />
                </div>
              ) : (
                <div>
                  <label>DB index (optional)</label>
                  <input
                    type="number"
                    min={0}
                    max={15}
                    placeholder="0"
                    value={formDatabase}
                    onChange={(e) => setFormDatabase(e.target.value)}
                  />
                </div>
              )}
              <div>
                <label>Username</label>
                <input type="text" value={formUsername} onChange={(e) => setFormUsername(e.target.value)} />
              </div>
              <div>
                <label>Password (OS keychain)</label>
                <input type="password" placeholder={editingId ? '(비우면 기존 유지)' : '••••••••'} value={formPassword} onChange={(e) => setFormPassword(e.target.value)} />
              </div>
              <div>
                <label>TLS mode</label>
                <select value={formTlsMode} onChange={(e) => setFormTlsMode(e.target.value as 'none' | 'prefer' | 'require')}>
                  <option value="none">None (plaintext)</option>
                  <option value="prefer">Prefer (opportunistic)</option>
                  <option value="require">Require (encrypted)</option>
                </select>
              </div>
              {formDriver === 'mongodb' && (
                <div>
                  <label>고급: 연결 문자열 (선택)</label>
                  <input
                    type="text"
                    value={formConnectionUri}
                    onChange={(e) => setFormConnectionUri(e.target.value)}
                    placeholder="mongodb+srv://user:pass@cluster.mongodb.net/  (입력 시 host/port보다 우선)"
                  />
                  {formConnectionUri.trim() !== '' && (
                    <p className="dialog-hint">연결 문자열이 설정되어 host/port·인증 정보보다 우선 적용됩니다.</p>
                  )}
                </div>
              )}
                </>
              )}
              <div className="form-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={handleTestConnection}>
                  Test
                </button>
                <button type="submit" className="btn btn-primary btn-sm">
                  {editingId ? 'Update' : 'Save'}
                </button>
              </div>
              {connectionError && (
                <div className="alert error">
                  <AlertTriangle size={14} />
                  <span>{connectionError}</span>
                </div>
              )}
                  </form>
                  )}

                  {formTab === 'mcp' && editingId && (formDriver === 'mysql' || formDriver === 'postgres' || formDriver === 'sqlserver') && (
                    <McpConnectPanel
                      connId={editingId}
                      connName={formName}
                      initialEnabled={profiles.find((p) => p.id === editingId)?.mcpEnabled ?? false}
                      initialExposure={profiles.find((p) => p.id === editingId)?.mcpDataExposure ?? 'metadata'}
                    />
                  )}

                  {formTab === 'schema' && editingId && (formDriver === 'mysql' || formDriver === 'postgres' || formDriver === 'sqlserver') && (
                    <div className="ctp-section">
                      <div className="ctp-head">표시할 테이블</div>
                      <p className="ctp-hint">체크한 테이블만 스키마 트리에 표시됩니다.</p>
                      {conns.byId[editingId]?.status === 'connected' ? (
                        <ConnectionTablePrefs profileId={editingId} store={hiddenStore} onChange={updateHidden} />
                      ) : (
                        <div className="ctp-status muted">먼저 이 연결에 접속하면 테이블 목록이 표시됩니다.</div>
                      )}
                    </div>
                  )}
                </div>
                <div
                  className="conn-modal-resizer"
                  onMouseDown={startModalResize}
                  onDoubleClick={() => setModalWidth(MODAL_DEFAULT)}
                  title="드래그하여 너비 조절 · 더블클릭으로 초기화"
                />
              </div>
            </div>
          )}

          <div className="conn-list">
              {profiles.length === 0 && (
                <div className="empty-state">
                  <div className="es-icon">
                    <Server size={20} />
                  </div>
                  <h3>No connections</h3>
                  <p>
                    Click <strong>New</strong> to add a database.
                  </p>
                </div>
              )}

              {profiles.map((p) => {
                const entry = p.id ? conns.byId[p.id] : undefined;
                const st = entry?.status; // connecting | connected | error | undefined
                const isFocused = conns.focusedId === p.id;
                const isExpanded = !!(p.id && expanded[p.id]);
                return (
                  <div key={p.id} className="conn-tree-node">
                    <div className={`conn-row ${isFocused ? 'focused' : ''}`} onClick={() => onClickConnection(p)}>
                      <span
                        className={`tree-chevron ${isExpanded && st === 'connected' ? 'open' : ''}`}
                        onClick={(e) => toggleExpand(p, e)}
                      >
                        <ChevronRight size={14} />
                      </span>
                      <span className={`conn-dot ${st || 'idle'}`} title={st || 'disconnected'} />
                      <span className={`driver-chip sm ${p.driver}`}>{DRIVER_LABEL[p.driver]}</span>
                      <div className="conn-row-text">
                        <span className="conn-row-name">{p.name}</span>
                        <span className="conn-row-host">
                          {p.driver === 'sqlite' ? (p.database.split('/').pop() || p.database) : `${p.host}:${p.port}`}
                        </span>
                      </div>
                      <span className="conn-row-actions">
                        {st === 'connecting' && <span className="spinner" />}
                        {st === 'connected' && (
                          <button className="icon-btn" title="Disconnect" onClick={(e) => disconnect(p.id!, e)}>
                            <Unplug size={13} />
                          </button>
                        )}
                        <button className="icon-btn" title="Edit profile" onClick={(e) => startEdit(p, e)}>
                          <Pencil size={13} />
                        </button>
                        <button className="icon-btn danger" title="Delete profile" onClick={(e) => handleDeleteProfile(p.id!, e)}>
                          <Trash2 size={13} />
                        </button>
                      </span>
                    </div>

                    {/* Inline schema / keyspace for connected + expanded connections */}
                    {st === 'connected' && isExpanded && (
                      <div className="conn-tree-body">
                        {p.driver === 'redis' ? (
                          <RedisKeyspaceExplorer
                            profileId={p.id!}
                            selectedKey={redisKeys[p.id!] ?? null}
                            refreshToken={redisRefresh[p.id!] ?? 0}
                            onSelectKey={(k) => {
                              setRedisKeys((prev) => ({ ...prev, [p.id!]: k }));
                              dispatch({ type: 'focus', profileId: p.id! });
                            }}
                            onDisconnect={() => disconnect(p.id!)}
                          />
                        ) : p.driver === 'mongodb' ? (
                          <MongoExplorer
                            profileId={p.id!}
                            onOpen={(database, collection, mode) => {
                              setMongoView((prev) => ({ ...prev, [p.id!]: { database, collection, mode } }));
                              dispatch({ type: 'focus', profileId: p.id! });
                            }}
                            onDisconnect={() => disconnect(p.id!)}
                          />
                        ) : (
                          <SchemaExplorer profileId={p.id!} driver={p.driver as 'mysql' | 'postgres' | 'redis' | 'sqlite' | 'sqlserver'} hiddenStore={hiddenStore} onDisconnect={() => disconnect(p.id!)} onSchemaChanged={() => setSchemaVersion((n) => n + 1)} onOpenTableData={(db, table) => { setErTab((prev) => ({ ...prev, [p.id!]: null })); setOpenTable((prev) => ({ ...prev, [p.id!]: { db, table } })); }} onOpenErDiagram={(db) => { setOpenTable((prev) => ({ ...prev, [p.id!]: null })); setErTab((prev) => ({ ...prev, [p.id!]: { db } })); }} onRunQuery={(sql) => { setErTab((prev) => ({ ...prev, [p.id!]: null })); setOpenTable((prev) => ({ ...prev, [p.id!]: null })); setRunReq({ profileId: p.id!, sql, nonce: Date.now() }); }} />
                        )}
                      </div>
                    )}

                    {st === 'error' && isFocused && (
                      <div className="conn-tree-body">
                        <div className="alert error alert-inline">
                          <AlertTriangle size={14} />
                          <span>{entry?.error}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

          {/* Focused connection: saved queries / history (driver-agnostic) */}
          {focusedProfile && conns.byId[focusedProfile.id!]?.status === 'connected' && (
            <div className="sidebar-focused-panel">
              <div className="seg-tabs">
                <button className={`seg-tab ${sideTab === 'saved' ? 'active' : ''}`} onClick={() => setSideTab('saved')}>
                  Saved
                </button>
                <button className={`seg-tab ${sideTab === 'history' ? 'active' : ''}`} onClick={() => setSideTab('history')}>
                  History
                </button>
              </div>
              <div className="sidebar-focused-body">
                {sideTab === 'saved' ? (
                  <SavedQueries
                    profileId={focusedProfile.id!}
                    onSelectQuery={handleSelectQuery}
                    refreshTrigger={savedTrigger}
                    onRefresh={() => setSavedTrigger((n) => n + 1)}
                  />
                ) : (
                  <QueryHistory profileId={focusedProfile.id!} onSelectQuery={handleSelectQuery} refreshTrigger={historyTrigger} />
                )}
              </div>
            </div>
          )}
        </aside>

        <div
          className="app-resizer"
          onMouseDown={startSidebarResize}
          onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
          title="드래그하여 너비 조절 · 더블클릭으로 초기화"
        />

        {/* Main: keep-mounted panel per connected connection, focused one visible */}
        <main className="main" style={showAgent && agentPopped ? { display: 'none' } : undefined}>
          {conns.order.length === 0 ? (
            <div className="empty-state full">
              <div className="es-icon">
                <Database size={22} />
              </div>
              <h2>Open a connection</h2>
              <p>Click a connection in the sidebar to connect. Open as many as you like — dev, prod, qa — and switch between them.</p>
              {engineError && (
                <div className="alert error" style={{ marginTop: 16 }}>
                  <AlertTriangle size={14} />
                  <span>
                    <strong>Engine:</strong> {engineError}
                  </span>
                </div>
              )}
            </div>
          ) : (
            conns.order.map((id) => {
              const profile = profiles.find((p) => p.id === id);
              const entry = conns.byId[id];
              if (!profile || !entry) return null;
              const focused = id === conns.focusedId;

              if (entry.status !== 'connected') {
                if (!focused) return null;
                return (
                  <div key={id} className="conn-panel" style={{ display: 'flex' }}>
                    <div className="load-center">
                      {entry.status === 'connecting' ? (
                        <>
                          <span className="spinner lg" /> Connecting to {profile.name}…
                        </>
                      ) : (
                        <div className="alert error">
                          <AlertTriangle size={14} />
                          <span>{entry.error}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              }

              return (
                <div key={id} className="conn-panel" style={{ display: focused ? 'flex' : 'none' }}>
                  {profile.driver === 'redis' ? (
                    <div className="redis-pane">
                      <div className="redis-tabs">
                        <button
                          className={`redis-tab${(redisTab[id] ?? 'inspector') === 'inspector' ? ' active' : ''}`}
                          onClick={() => setRedisTab((prev) => ({ ...prev, [id]: 'inspector' }))}
                        >
                          Inspector
                        </button>
                        <button
                          className={`redis-tab${redisTab[id] === 'console' ? ' active' : ''}`}
                          onClick={() => setRedisTab((prev) => ({ ...prev, [id]: 'console' }))}
                        >
                          Console
                        </button>
                      </div>
                      {redisTab[id] === 'console' ? (
                        <RedisConsole
                          profileId={id}
                          onRan={() => setHistoryTrigger((n) => n + 1)}
                          onSaved={() => setSavedTrigger((n) => n + 1)}
                          loadRequest={focused && loadReq?.profileId === id ? { text: loadReq.text, nonce: loadReq.nonce } : undefined}
                        />
                      ) : (
                        <RedisValueInspector
                          key={`${id}:${redisKeys[id] ?? '∅'}`}
                          profileId={id}
                          redisKey={redisKeys[id] ?? null}
                          onSelectKey={(k) => setRedisKeys((prev) => ({ ...prev, [id]: k }))}
                          onRefresh={() => setRedisRefresh((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }))}
                        />
                      )}
                    </div>
                  ) : profile.driver === 'mongodb' ? (
                    (() => {
                      const mv = mongoView[id];
                      const setMode = (mode: 'documents' | 'query' | 'indexes' | 'schema') => {
                        if (!mv) return;
                        setMongoView((prev) => ({ ...prev, [id]: { ...mv, mode } }));
                      };
                      return (
                        <div className="mongo-workspace">
                          <div className="mongo-tabs">
                            {mv ? (
                              <span className="mongo-tabs-ctx mono">
                                {mv.database} · {mv.collection}
                              </span>
                            ) : (
                              <span className="mongo-tabs-ctx muted">컬렉션을 선택하세요</span>
                            )}
                            <span className="mongo-spacer" />
                            <button
                              className={`mongo-tab${mv?.mode === 'documents' ? ' active' : ''}`}
                              disabled={!mv}
                              onClick={() => setMode('documents')}
                            >
                              문서
                            </button>
                            <button
                              className={`mongo-tab${!mv || mv.mode === 'query' ? ' active' : ''}`}
                              onClick={() => setMode('query')}
                            >
                              쿼리
                            </button>
                            <button
                              className={`mongo-tab${mv?.mode === 'indexes' ? ' active' : ''}`}
                              disabled={!mv}
                              onClick={() => setMode('indexes')}
                            >
                              인덱스
                            </button>
                            <button
                              className={`mongo-tab${mv?.mode === 'schema' ? ' active' : ''}`}
                              disabled={!mv}
                              onClick={() => setMode('schema')}
                            >
                              스키마
                            </button>
                          </div>
                          <div className="mongo-workspace-body">
                            {mv && mv.mode === 'documents' ? (
                              <MongoDocumentView
                                key={`doc:${mv.database}.${mv.collection}`}
                                profileId={id}
                                database={mv.database}
                                collection={mv.collection}
                              />
                            ) : mv && mv.mode === 'indexes' ? (
                              <MongoIndexManager
                                key={`idx:${mv.database}.${mv.collection}`}
                                profileId={id}
                                database={mv.database}
                                collection={mv.collection}
                              />
                            ) : mv && mv.mode === 'schema' ? (
                              <MongoSchemaPanel
                                key={`schema:${mv.database}.${mv.collection}`}
                                profileId={id}
                                database={mv.database}
                                collection={mv.collection}
                              />
                            ) : (
                              <MongoQueryEditor
                                profileId={id}
                                view={mv ? { database: mv.database, collection: mv.collection } : null}
                                onRan={() => setHistoryTrigger((n) => n + 1)}
                                onSaved={() => setSavedTrigger((n) => n + 1)}
                                loadRequest={focused && loadReq?.profileId === id ? { text: loadReq.text, nonce: loadReq.nonce } : undefined}
                              />
                            )}
                          </div>
                        </div>
                      );
                    })()
                  ) : erTab[id] ? (
                    <ErDiagram
                      key={`er:${erTab[id]!.db}`}
                      profileId={id}
                      database={erTab[id]!.db}
                      onOpenTable={(table) => { setErTab((prev) => ({ ...prev, [id]: null })); setOpenTable((prev) => ({ ...prev, [id]: { db: erTab[id]!.db, table } })); }}
                    />
                  ) : openTable[id] ? (
                    <TableDataView
                      key={`${openTable[id]!.db}.${openTable[id]!.table}.${openTable[id]!.filter?.value ?? ''}`}
                      profileId={id}
                      driver={profile.driver as 'mysql' | 'postgres' | 'sqlite' | 'sqlserver'}
                      readOnly={profile.readOnly ?? false}
                      database={openTable[id]!.db}
                      table={openTable[id]!.table}
                      onClose={() => setOpenTable((prev) => ({ ...prev, [id]: null }))}
                      initialFilter={openTable[id]!.filter}
                      onOpenRelated={(t, refCol, value) => setOpenTable((prev) => ({ ...prev, [id]: { db: openTable[id]!.db, table: t, filter: { col: refCol, value } } }))}
                    />
                  ) : (
                    <QueryEditor
                      profileId={id}
                      driver={profile.driver as 'mysql' | 'postgres' | 'redis' | 'sqlite' | 'sqlserver'}
                      database={profile.database}
                      connectionName={profile.name}
                      onQueryExecuted={() => setHistoryTrigger((n) => n + 1)}
                      loadTriggerQuery={focused ? selectedQueryText : ''}
                      runQueryRequest={focused && runReq?.profileId === id ? { sql: runReq.sql, nonce: runReq.nonce } : undefined}
                      schemaVersion={schemaVersion}
                    />
                  )}
                </div>
              );
            })
          )}
        </main>
        {showAgent && (
          <aside className={`agent-dock${agentPopped ? ' popped' : ''}`}>
            <AgentChat
              profileId={conns.focusedId}
              connectionName={focusedProfile?.name}
              onClose={() => setShowAgent(false)}
              popped={agentPopped}
              onTogglePopout={() => setAgentPopped((v) => !v)}
              onSendToEditor={(sql) => {
                setAgentPopped(false);
                handleSelectQuery(sql);
              }}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

export default App;
