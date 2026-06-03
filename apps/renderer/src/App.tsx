import { useState, useEffect, useCallback, useReducer } from 'react';
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
} from 'lucide-react';
import { SchemaExplorer } from './components/SchemaExplorer';
import { UpdateButton } from './components/UpdateButton';
import { QueryEditor } from './components/QueryEditor';
import { RedisKeyspaceExplorer } from './components/RedisKeyspaceExplorer';
import { RedisValueInspector } from './components/RedisValueInspector';
import { RedisConsole } from './components/RedisConsole';
import { AgentChat } from './components/AgentChat';
import { SavedQueries } from './components/SavedQueries';
import { QueryHistory } from './components/QueryHistory';
import { TableDataView } from './components/TableDataView';
import { connectionsReducer, initialConnectionsState } from './state/connections';
import './App.css';

export interface ConnectionProfile {
  id?: string;
  name: string;
  driver: 'mysql' | 'postgres' | 'redis';
  host: string;
  port: number;
  database: string;
  username: string;
  secretRef?: string;
  tlsMode: 'none' | 'prefer' | 'require';
  createdAt?: string;
  updatedAt?: string;
}

export interface HealthResult {
  success: boolean;
  port?: number;
  pid?: number;
  error?: string;
}

const DRIVER_LABEL: Record<string, string> = { mysql: 'MY', postgres: 'PG', redis: 'RS' };

function App() {
  const [status, setStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking');
  const [engineInfo, setEngineInfo] = useState<{ port?: number; pid?: number } | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

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
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Focused connection's secondary sidebar panel (saved/history)
  const [sideTab, setSideTab] = useState<'saved' | 'history'>('saved');
  const [selectedQueryText, setSelectedQueryText] = useState<string>('');
  // One-click "load + run this SQL" request, targeted at a connection's editor.
  const [runReq, setRunReq] = useState<{ profileId: string; sql: string; nonce: number } | null>(null);
  const [historyTrigger, setHistoryTrigger] = useState(0);
  const [savedTrigger, setSavedTrigger] = useState(0);
  const [schemaVersion, setSchemaVersion] = useState(0);
  const [openTable, setOpenTable] = useState<Record<string, { db: string; table: string; filter?: { col: string; value: string } } | null>>({});

  // Create form state
  const [formDriver, setFormDriver] = useState<'mysql' | 'postgres' | 'redis'>('mysql');
  const [formName, setFormName] = useState('');
  const [formHost, setFormHost] = useState('127.0.0.1');
  const [formPort, setFormPort] = useState(3306);
  const [formDatabase, setFormDatabase] = useState('');
  const [formUsername, setFormUsername] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formTlsMode, setFormTlsMode] = useState<'none' | 'prefer' | 'require'>('none');
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    // Intentional load-on-mount; loadProfiles manages its own state.
    // eslint-disable-next-line react-hooks/immutability
    loadProfiles();
  }, []);

  const loadProfiles = async () => {
    try {
      const res = await window.electronAPI.listProfiles();
      if (res.success && res.data) setProfiles(res.data);
    } catch (e) {
      console.error('Failed to load profiles:', e);
    }
  };

  const handleDriverChange = (driver: 'mysql' | 'postgres' | 'redis') => {
    setFormDriver(driver);
    if (driver === 'mysql') {
      setFormPort(3306);
      setFormDatabase('dev-mysql');
      setFormUsername('root');
    } else if (driver === 'postgres') {
      setFormPort(5432);
      setFormDatabase('postgres');
      setFormUsername('postgres');
    } else {
      setFormPort(6379);
      setFormDatabase('');
      setFormUsername('');
    }
  };

  const resetForm = () => {
    setFormName('');
    handleDriverChange('mysql');
    setFormPassword('');
    setEditingId(null);
  };

  const startEdit = (p: ConnectionProfile, e: React.MouseEvent) => {
    e.stopPropagation();
    setFormDriver(p.driver);
    setFormName(p.name);
    setFormHost(p.host);
    setFormPort(p.port);
    setFormDatabase(p.database);
    setFormUsername(p.username);
    setFormPassword(''); // blank keeps the existing password
    setFormTlsMode(p.tlsMode);
    setEditingId(p.id!);
    setConnectionError(null);
    setShowCreateForm(true);
  };

  const handleTestConnection = async () => {
    setConnectionError(null);
    const profile: ConnectionProfile = {
      name: formName || 'Test Profile',
      driver: formDriver,
      host: formHost,
      port: formPort,
      database: formDatabase,
      username: formUsername,
      tlsMode: formTlsMode,
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
      host: formHost,
      port: formPort,
      database: formDatabase,
      username: formUsername,
      tlsMode: formTlsMode,
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

  const handleSelectQuery = (queryText: string) => {
    setSelectedQueryText(queryText);
    setTimeout(() => setSelectedQueryText(''), 100);
  };

  const focusedProfile = conns.focusedId ? profiles.find((p) => p.id === conns.focusedId) : null;

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
        </div>
      </header>

      <div className="app-body">
        {/* Sidebar: connection tree */}
        <aside className="sidebar">
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

          {showCreateForm ? (
            <form className="conn-form" onSubmit={handleCreateProfile}>
              <div>
                <label>Database type</label>
                <select value={formDriver} onChange={(e) => handleDriverChange(e.target.value as 'mysql' | 'postgres' | 'redis')}>
                  <option value="mysql">MySQL</option>
                  <option value="postgres">PostgreSQL</option>
                  <option value="redis">Redis</option>
                </select>
              </div>
              <div>
                <label>Profile name</label>
                <input type="text" placeholder="e.g. Prod DB" value={formName} onChange={(e) => setFormName(e.target.value)} required />
              </div>
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
          ) : (
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
                          {p.host}:{p.port}
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
                        ) : (
                          <SchemaExplorer profileId={p.id!} driver={p.driver} onDisconnect={() => disconnect(p.id!)} onSchemaChanged={() => setSchemaVersion((n) => n + 1)} onOpenTableData={(db, table) => setOpenTable((prev) => ({ ...prev, [p.id!]: { db, table } }))} onRunQuery={(sql) => { setOpenTable((prev) => ({ ...prev, [p.id!]: null })); setRunReq({ profileId: p.id!, sql, nonce: Date.now() }); }} />
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
          )}

          {/* Focused SQL connection: saved queries / history */}
          {focusedProfile && focusedProfile.driver !== 'redis' && conns.byId[focusedProfile.id!]?.status === 'connected' && !showCreateForm && (
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
                        <RedisConsole profileId={id} />
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
                  ) : openTable[id] ? (
                    <TableDataView
                      key={`${openTable[id]!.db}.${openTable[id]!.table}.${openTable[id]!.filter?.value ?? ''}`}
                      profileId={id}
                      driver={profile.driver as 'mysql' | 'postgres'}
                      database={openTable[id]!.db}
                      table={openTable[id]!.table}
                      onClose={() => setOpenTable((prev) => ({ ...prev, [id]: null }))}
                      initialFilter={openTable[id]!.filter}
                      onOpenRelated={(t, refCol, value) => setOpenTable((prev) => ({ ...prev, [id]: { db: openTable[id]!.db, table: t, filter: { col: refCol, value } } }))}
                    />
                  ) : (
                    <QueryEditor
                      profileId={id}
                      driver={profile.driver}
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
