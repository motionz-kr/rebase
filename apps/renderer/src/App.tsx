import React, { useState, useEffect, useCallback, useReducer, useRef } from 'react';
import {
  Database,
  Plus,
  Pencil,
  Trash2,
  Unplug,
  X,
  AlertTriangle,
  Server,
  ChevronRight,
  Bot,
  Activity,
  Settings,
  BookOpen,
  History,
  LayoutTemplate,
  Search,
} from 'lucide-react';
import { clampSidebarWidth, SIDEBAR_DEFAULT, clampModalWidth, MODAL_DEFAULT, loadNum, saveNum } from './lib/uiPrefs';
import { loadHidden, saveHidden, type HiddenStore } from './lib/tableVisibility';
import { SchemaExplorer } from './components/SchemaExplorer';
import { ConnectionTablePrefs } from './components/ConnectionTablePrefs';
import { McpConnectPanel } from './components/McpConnectPanel';
import { McpServersPanel } from './components/McpServersPanel';
import { McpActivityPage } from './components/McpActivityPage';
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
import { SettingsPage } from './components/SettingsPage';
import { TemplatesPanel } from './components/TemplatesPanel';
import { TemplateRunner } from './components/TemplateRunner';
import { DomainBindingsDialog } from './components/DomainBindingsDialog';
import { SaveTemplateDialog } from './components/SaveTemplateDialog';
import type { TemplateDef } from './lib/templateTypes';
import { loadAgentSettings } from './lib/agentSettings';
import { createSqlQueryRequest, type SqlQueryRequest } from './lib/queryRequest';
import { connectionsReducer, initialConnectionsState } from './state/connections';
import { connectionRouteFromForm, type SSMConfig, type SSHConfig, type ConnectionMode } from './lib/connectionRoute';
import { connectionDefaultsFromCandidate } from './lib/databaseDiscovery';
import { DatabaseDiscoveryDialog } from './components/DatabaseDiscoveryDialog';
import type { DiscoveredDatabase, McpConnectionProposal } from './global';
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
  connectionMode?: ConnectionMode;
  ssh?: SSHConfig;
  ssm?: SSMConfig;
  readOnly?: boolean;
  safeMode?: boolean;
  tenantColumns?: string;
  domainBindings?: string;
  domainGlossary?: string;
  domainNotes?: string;
  mcpEnabled?: boolean;
  mcpDataExposure?: string;
  mcpWriteMode?: string;
  mcpAllowedDatabases?: string;
  mcpAllowedSchemas?: string;
  mcpAllowedTables?: string;
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
type LibraryView = 'saved' | 'history' | 'templates';

const shouldStartInAgentMode = () => loadAgentSettings().startupView === 'agent';

function App() {
  const [engineError, setEngineError] = useState<string | null>(null);

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
  const disconnectGuardsRef = useRef<Record<string, () => Promise<boolean>>>({});
  const disconnectingRef = useRef(new Set<string>());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [redisKeys, setRedisKeys] = useState<Record<string, string | null>>({});
  const [redisRefresh, setRedisRefresh] = useState<Record<string, number>>({});
  const [redisTab, setRedisTab] = useState<Record<string, 'inspector' | 'console'>>({});
  const [showAgent, setShowAgent] = useState(shouldStartInAgentMode);
  const [agentPopped, setAgentPopped] = useState(shouldStartInAgentMode);
  const [showSettings, setShowSettings] = useState(false);
  const [showMcpActivity, setShowMcpActivity] = useState(false);
  const [pendingMcpConnectionProposal, setPendingMcpConnectionProposal] = useState<McpConnectionProposal | null>(null);
  const [requiresConnectionTest, setRequiresConnectionTest] = useState(false);
  const [discoveredConnectionDraft, setDiscoveredConnectionDraft] = useState(false);
  const [mcpActivitySummary, setMcpActivitySummary] = useState({ total: 0, errors: 0 });

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showDatabaseDiscovery, setShowDatabaseDiscovery] = useState(false);
  // Active tab inside the connection modal: basic info / schema (table visibility) / MCP.
  const [formTab, setFormTab] = useState<'basic' | 'schema' | 'mcp'>('basic');
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const [libraryView, setLibraryView] = useState<LibraryView | null>(null);

  // Template integration state
  const [templateView, setTemplateView] = useState<Record<string, TemplateDef | null>>({});
  const [domainDialogOpen, setDomainDialogOpen] = useState(false);
  const [saveTplOpen, setSaveTplOpen] = useState(false);
  const [tplReload, setTplReload] = useState(0);
  const [tplSchema, setTplSchema] = useState<{ tables: string[]; columns: string[] }>({ tables: [], columns: [] });
  const [tplColumnsByTable, setTplColumnsByTable] = useState<Record<string, string[]>>({});

  // Helper: parse domainBindings JSON → roles map
  const parseRoles = (profile: ConnectionProfile): Record<string, string> => {
    try { return JSON.parse(profile.domainBindings || '{}'); } catch { return {}; }
  };
  const [selectedQueryText, setSelectedQueryText] = useState<string>('');
  // SQL editor context request, targeted at a connection. It carries the
  // selected database so schema actions cannot fall back to the profile DB.
  const [queryRequest, setQueryRequest] = useState<SqlQueryRequest | null>(null);
  // "Load this command into the input" request for non-SQL editors (redis/mongo).
  // Unlike queryRequest it does NOT auto-execute — the user presses run.
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
  const [formConnectionMode, setFormConnectionMode] = useState<ConnectionMode>('direct');
  const [formSSH, setFormSSH] = useState<SSHConfig>({ host: '', port: 22, username: 'ec2-user', identityFile: '', knownHostsFile: '' });
  const [formSSM, setFormSSM] = useState<SSMConfig>({ profile: '', region: '', instanceId: '' });
  const formUsesDocumentDestination = formConnectionMode === 'ssm' && (formDriver === 'mysql' || formDriver === 'postgres') && formSSM.destinationMode === 'document';
  const [testingConnection, setTestingConnection] = useState(false);
  const connectionTestSettings = JSON.stringify([formDriver, formHost, formPort, formDatabase, formUsername, formPassword, formTlsMode, formConnectionMode, formSSM, formSSH]);
  const [testedConnectionSettings, setTestedConnectionSettings] = useState<string | null>(null);
  const connectionTestSuccess = testedConnectionSettings === connectionTestSettings;
  const connectionFeedbackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (connectionError || connectionTestSuccess) connectionFeedbackRef.current?.scrollIntoView({ block: 'nearest' });
  }, [connectionError, connectionTestSuccess]);
  const [formReadOnly, setFormReadOnly] = useState(false);
  const [formSafeMode, setFormSafeMode] = useState(false);
  const [formTenantColumns, setFormTenantColumns] = useState('');
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

  // Load schema (tables + columns) for TemplateRunner when templates tab active
  useEffect(() => {
    if (libraryView !== 'templates') return;
    const fp = conns.focusedId ? profiles.find((p) => p.id === conns.focusedId) : null;
    if (!fp || fp.driver === 'redis' || fp.driver === 'mongodb') return;
    if (conns.byId[fp.id!]?.status !== 'connected') return;
    window.electronAPI.getSchemaCompletion(fp.id!, fp.database).then((res) => {
      if (res.success && res.data) {
        const cols = new Set<string>();
        res.data.tables.forEach((t) => t.columns.forEach((c) => cols.add(c.name)));
        setTplSchema({ tables: res.data.tables.map((t) => t.name), columns: Array.from(cols) });
        setTplColumnsByTable(Object.fromEntries(res.data.tables.map((t) => [t.name, t.columns.map((c) => c.name)])));
      }
    }).catch(() => { /* ignore */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryView, conns.focusedId]);

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

  const refreshMcpActivitySummary = useCallback(async () => {
    if (typeof window.electronAPI === 'undefined') return;
    try {
      const res = await window.electronAPI.mcpActivityList({ limit: 100 });
      const events = res.data ?? [];
      setMcpActivitySummary({ total: events.length, errors: events.filter((event) => event.status === 'error').length });
    } catch {
      // The bottom bar is an optional status surface; keep the rest of the app usable.
    }
  }, []);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refreshMcpActivitySummary(), 0);
    const timer = window.setInterval(() => void refreshMcpActivitySummary(), 30_000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
    };
  }, [refreshMcpActivitySummary]);

  const handleDriverChange = (driver: 'mysql' | 'postgres' | 'redis' | 'sqlite' | 'sqlserver' | 'mongodb') => {
    setFormDriver(driver);
    if (driver !== 'mysql' && driver !== 'postgres') setFormConnectionMode('direct');
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

  const handleDiscoveredDatabase = (candidate: DiscoveredDatabase) => {
    const defaults = connectionDefaultsFromCandidate(candidate);
    resetForm();
    handleDriverChange(defaults.driver);
    setFormName(defaults.name);
    setFormHost(defaults.host);
    setFormPort(defaults.port);
    setFormDatabase(defaults.database);
    setFormUsername(defaults.username);
    setFormTlsMode('none');
    setConnectionError(null);
    setRequiresConnectionTest(true);
    setDiscoveredConnectionDraft(true);
    setShowDatabaseDiscovery(false);
    setShowCreateForm(true);
  };

  const resetForm = () => {
    setFormName('');
    setFormConnectionMode('direct');
    setFormSSM({ profile: '', region: '', instanceId: '' });
    setFormSSH({ host: '', port: 22, username: 'ec2-user', identityFile: '', knownHostsFile: '' });
    setTestedConnectionSettings(null);
    handleDriverChange('mysql');
    setFormConnectionUri('');
    setFormPassword('');
    setFormReadOnly(false);
    setFormSafeMode(false);
    setFormTenantColumns('');
    setEditingId(null);
    setPendingMcpConnectionProposal(null);
    setRequiresConnectionTest(false);
    setDiscoveredConnectionDraft(false);
    setFormTab('basic');
  };

  const handleReviewMcpConnectionProposal = (proposal: McpConnectionProposal) => {
    const current = proposal.operation === 'update'
      ? profiles.find((profile) => profile.id === proposal.targetProfileId)
      : undefined;
    if (proposal.operation === 'update' && (!current || current.updatedAt !== proposal.targetUpdatedAt)) {
      setShowMcpActivity(false);
      alert('이 연결은 제안 이후 변경되었거나 삭제되었습니다. 최신 연결 상태를 확인한 뒤 다시 제안해 주세요.');
      return;
    }

    setShowMcpActivity(false);
    setPendingMcpConnectionProposal(proposal);
    setRequiresConnectionTest(true);
    setDiscoveredConnectionDraft(false);
    setFormDriver(proposal.driver);
    setFormName(proposal.name);
    setFormConnectionUri('');
    setFormHost(proposal.host);
    setFormPort(proposal.port);
    setFormDatabase(proposal.database ?? '');
    setFormUsername(proposal.username ?? '');
    setFormPassword('');
    setFormTlsMode(proposal.tlsMode);
    setFormConnectionMode('direct');
    setFormSSM({ profile: '', region: '', instanceId: '' });
    setFormSSH({ host: '', port: 22, username: 'ec2-user', identityFile: '', knownHostsFile: '' });
    setTestedConnectionSettings(null);
    setFormReadOnly(current?.readOnly ?? false);
    setFormSafeMode(current?.safeMode ?? false);
    setFormTenantColumns(current?.tenantColumns ?? '');
    setEditingId(current?.id ?? null);
    setConnectionError(null);
    setFormTab('basic');
    setShowCreateForm(true);
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
    setFormConnectionMode(p.connectionMode === 'ssm' || p.connectionMode === 'ssh' ? p.connectionMode : 'direct');
    setFormSSH(p.ssh ?? { host: '', port: 22, username: 'ec2-user', identityFile: '', knownHostsFile: '' });
    setFormSSM(p.ssm ?? { profile: '', region: '', instanceId: '' });
    setTestedConnectionSettings(null);
    setFormReadOnly(p.readOnly ?? false);
    setFormSafeMode(p.safeMode ?? false);
    setFormTenantColumns(p.tenantColumns ?? '');
    setEditingId(p.id!);
    setPendingMcpConnectionProposal(null);
    setRequiresConnectionTest(false);
    setDiscoveredConnectionDraft(false);
    setConnectionError(null);
    setFormTab('basic');
    setShowCreateForm(true);
  };

  const handleTestConnection = async () => {
    setConnectionError(null);
    setTestedConnectionSettings(null);
    setTestingConnection(true);
    const profile: ConnectionProfile = {
      ...(editingId ? profiles.find((p) => p.id === editingId) : {}),
      secretRef: undefined, // The engine owns this reference; the edit form never sends it.
      ...connectionRouteFromForm(formDriver, formConnectionMode, formSSM, formSSH),
      name: formName || 'Test Profile',
      driver: formDriver,
      host: formDriver === 'sqlite' || formUsesDocumentDestination ? '' : formHost,
      port: formDriver === 'sqlite' || formUsesDocumentDestination ? 0 : formPort,
      database: formDatabase,
      username: formDriver === 'sqlite' ? '' : formUsername,
      connectionUri: formConnectionUri,
      tlsMode: formTlsMode,
      readOnly: formReadOnly,
      safeMode: formSafeMode,
      tenantColumns: formTenantColumns,
    };
    try {
      const res = await window.electronAPI.testConnection(profile, formPassword);
      if (res.success) setTestedConnectionSettings(connectionTestSettings);
      else setConnectionError(res.error || 'Connection failed');
    } catch (e) {
      setConnectionError(e instanceof Error ? e.message : 'Error during connection test');
    } finally { setTestingConnection(false); }
  };

  const handleCreateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName) {
      alert('Please enter a profile name');
      return;
    }
    if (requiresConnectionTest && !connectionTestSuccess) {
      setConnectionError('저장하기 전에 현재 연결 정보로 연결 테스트를 성공시켜 주세요.');
      return;
    }
    setConnectionError(null);
    const profile: ConnectionProfile = {
      ...(editingId ? profiles.find((p) => p.id === editingId) : {}),
      secretRef: undefined, // The engine owns this reference; the edit form never sends it.
      ...connectionRouteFromForm(formDriver, formConnectionMode, formSSM, formSSH),
      name: formName,
      driver: formDriver,
      host: formDriver === 'sqlite' || formUsesDocumentDestination ? '' : formHost,
      port: formDriver === 'sqlite' || formUsesDocumentDestination ? 0 : formPort,
      database: formDatabase,
      username: formDriver === 'sqlite' ? '' : formUsername,
      connectionUri: formConnectionUri,
      tlsMode: formTlsMode,
      readOnly: formReadOnly,
      safeMode: formSafeMode,
      tenantColumns: formTenantColumns,
    };
    if (pendingMcpConnectionProposal?.operation === 'create') {
      if (!pendingMcpConnectionProposal.resultProfileId) {
        setConnectionError('MCP 제안에 연결 ID가 없습니다. 다시 요청해 주세요.');
        return;
      }
      profile.id = pendingMcpConnectionProposal.resultProfileId;
      profile.mcpEnabled = false;
      profile.mcpWriteMode = 'disabled';
      profile.mcpAllowedDatabases = formDatabase ? JSON.stringify([formDatabase]) : '';
      profile.mcpAllowedSchemas = '';
      profile.mcpAllowedTables = '';
    } else if (pendingMcpConnectionProposal?.operation === 'update') {
      if (!pendingMcpConnectionProposal.targetUpdatedAt) {
        setConnectionError('MCP 제안에 수정 기준 정보가 없습니다. 다시 요청해 주세요.');
        return;
      }
      profile.updatedAt = pendingMcpConnectionProposal.targetUpdatedAt;
    } else if (discoveredConnectionDraft && !editingId) {
      profile.mcpEnabled = false;
      profile.mcpWriteMode = 'disabled';
      profile.mcpAllowedDatabases = formDatabase ? JSON.stringify([formDatabase]) : '';
      profile.mcpAllowedSchemas = '';
      profile.mcpAllowedTables = '';
    }
    try {
      const res = editingId
        ? await window.electronAPI.updateProfile({ ...profile, id: editingId }, formPassword)
        : await window.electronAPI.createProfile(profile, formPassword);
      if (res.success && res.data) {
        if (pendingMcpConnectionProposal) {
          const resolved = await window.electronAPI.mcpConnectionProposalAction(pendingMcpConnectionProposal.id, 'applied');
          if (!resolved.success) {
            setConnectionError(`연결은 저장했지만 MCP 제안 상태를 갱신하지 못했습니다: ${resolved.error || '오류'}`);
            loadProfiles();
            return;
          }
        }
        setShowCreateForm(false);
        setEditingId(null);
        setPendingMcpConnectionProposal(null);
        setRequiresConnectionTest(false);
        setDiscoveredConnectionDraft(false);
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

  const registerDisconnectGuard = useCallback((id: string, handler: () => Promise<boolean>) => {
    disconnectGuardsRef.current[id] = handler;
    return () => {
      if (disconnectGuardsRef.current[id] === handler) delete disconnectGuardsRef.current[id];
    };
  }, []);

  const disconnect = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (disconnectingRef.current.has(id)) return;
    disconnectingRef.current.add(id);
    try {
      const guard = disconnectGuardsRef.current[id];
      if (guard && !(await guard())) return;
      dispatch({ type: 'close', profileId: id });
      setExpanded((prev) => ({ ...prev, [id]: false }));
      setRedisKeys((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } finally {
      disconnectingRef.current.delete(id);
    }
  };

  const checkHealth = useCallback(async () => {
    try {
      if (window.electronAPI && typeof window.electronAPI.checkEngineHealth === 'function') {
        const res: HealthResult = await window.electronAPI.checkEngineHealth();
        if (res.success) {
          setEngineError(null);
        } else {
          setEngineError(res.error || 'Engine health check failed');
        }
      } else {
        setEngineError('electronAPI not found. Run inside Electron.');
      }
    } catch (e) {
      setEngineError(e instanceof Error ? e.message : 'Failed to call checkEngineHealth');
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
    if (conns.focusedId) {
      setTemplateView((m) => ({ ...m, [conns.focusedId!]: null }));
    }
    // Redis/Mongo: load the command into the focused connection's editor input.
    if (focusedProfile && (focusedProfile.driver === 'redis' || focusedProfile.driver === 'mongodb')) {
      setLoadReq({ profileId: focusedProfile.id!, text: queryText, nonce: Date.now() });
      return;
    }
    // SQL: load into the active SQL editor tab.
    setSelectedQueryText(queryText);
    setTimeout(() => setSelectedQueryText(''), 100);
  };

  const handleSelectLibraryQuery = (queryText: string) => {
    setLibraryView(null);
    handleSelectQuery(queryText);
  };

  const openSchemaQuery = (profileId: string, database: string) => {
    dispatch({ type: 'focus', profileId });
    setTemplateView((m) => ({ ...m, [profileId]: null }));
    setErTab((prev) => ({ ...prev, [profileId]: null }));
    setOpenTable((prev) => ({ ...prev, [profileId]: null }));
    setQueryRequest(createSqlQueryRequest(profileId, database, '', false, Date.now(), true));
  };

  const openLibrary = (view: LibraryView = 'saved') => {
    setLibraryView(view);
  };

  const renderLibraryPanel = () => {
    if (!focusedProfile || conns.byId[focusedProfile.id!]?.status !== 'connected' || !libraryView) return null;
    const libraryMeta: Record<LibraryView, { title: string; description: string; icon: React.ReactNode }> = {
      saved: {
        title: 'Saved Queries',
        description: '자주 쓰는 쿼리를 빠르게 찾아 현재 에디터로 불러옵니다.',
        icon: <BookOpen size={17} />,
      },
      history: {
        title: 'Query History',
        description: '최근 실행 결과와 SQL을 확인하고 필요한 쿼리를 다시 불러옵니다.',
        icon: <History size={17} />,
      },
      templates: {
        title: 'Templates',
        description: '업무 목적별 SQL 템플릿을 선택하고 파라미터를 채워 실행합니다.',
        icon: <LayoutTemplate size={17} />,
      },
    };
    const activeMeta = libraryMeta[libraryView];

    return (
      <div className="modal-overlay library-modal-overlay" onClick={() => setLibraryView(null)}>
        <div
          className="library-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Query library"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="library-modal-head">
            <div className="library-modal-title">
              <span className="library-modal-icon">{activeMeta.icon}</span>
              <div>
                <h2>{activeMeta.title}</h2>
                <p>{activeMeta.description}</p>
              </div>
            </div>
            <div className="library-modal-context">
              <span className={`driver-chip sm ${focusedProfile.driver}`}>{DRIVER_LABEL[focusedProfile.driver]}</span>
              <span>{focusedProfile.name}</span>
            </div>
            <button className="icon-btn" onClick={() => setLibraryView(null)} aria-label="닫기">
              <X size={15} />
            </button>
          </div>

          <div className="library-modal-tabs" role="tablist" aria-label="Query library sections">
            <button
              className={`library-tab${libraryView === 'saved' ? ' active' : ''}`}
              onClick={() => setLibraryView('saved')}
              role="tab"
              aria-selected={libraryView === 'saved'}
            >
              <BookOpen size={14} /> Saved
            </button>
            <button
              className={`library-tab${libraryView === 'history' ? ' active' : ''}`}
              onClick={() => setLibraryView('history')}
              role="tab"
              aria-selected={libraryView === 'history'}
            >
              <History size={14} /> History
            </button>
            <button
              className={`library-tab${libraryView === 'templates' ? ' active' : ''}`}
              onClick={() => setLibraryView('templates')}
              role="tab"
              aria-selected={libraryView === 'templates'}
            >
              <LayoutTemplate size={14} /> Templates
            </button>
          </div>

          <div className="library-modal-body">
            {libraryView === 'saved' ? (
              <SavedQueries
                profileId={focusedProfile.id!}
                onSelectQuery={handleSelectLibraryQuery}
                refreshTrigger={savedTrigger}
                onRefresh={() => setSavedTrigger((n) => n + 1)}
              />
            ) : libraryView === 'history' ? (
              <QueryHistory profileId={focusedProfile.id!} onSelectQuery={handleSelectLibraryQuery} refreshTrigger={historyTrigger} />
            ) : (
              <TemplatesPanel
                onSelectTemplate={(t) => {
                  setLibraryView(null);
                  setTemplateView((m) => ({ ...m, [focusedProfile.id!]: t }));
                  setErTab((prev) => ({ ...prev, [focusedProfile.id!]: null }));
                  setOpenTable((prev) => ({ ...prev, [focusedProfile.id!]: null }));
                }}
                onOpenDomainSettings={() => setDomainDialogOpen(true)}
                onNewTemplate={() => setSaveTplOpen(true)}
                reloadKey={tplReload}
              />
            )}
          </div>
        </div>
      </div>
    );
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
          <div className="topbar-toggle-group" role="group" aria-label="Header panels">
            <button
              className={`topbar-toggle agent-toggle${showAgent ? ' active' : ''}`}
              onClick={() => setShowAgent((v) => !v)}
              aria-pressed={showAgent}
              title="Toggle the AI agent panel"
            >
              <Bot size={14} /> Agent
            </button>
          </div>
          <button
            className={`icon-btn${showSettings ? ' active' : ''}`}
            onClick={() => setShowSettings(true)}
            title="설정"
          >
            <Settings size={14} />
          </button>
        </div>
      </header>

      {showSettings && <SettingsPage onClose={() => setShowSettings(false)} />}
      {showDatabaseDiscovery && (
        <DatabaseDiscoveryDialog
          onSelect={handleDiscoveredDatabase}
          onClose={() => setShowDatabaseDiscovery(false)}
        />
      )}
      {showMcpActivity && (
        <McpActivityPage
          profiles={profiles}
          onReviewConnectionProposal={handleReviewMcpConnectionProposal}
          onClose={() => {
            setShowMcpActivity(false);
            void refreshMcpActivitySummary();
          }}
        />
      )}
      {renderLibraryPanel()}
      {engineError && (
        <div className="engine-error-bar" role="status">
          <AlertTriangle size={14} />
          <strong>Connection error</strong>
          <span>{engineError}</span>
        </div>
      )}

      <div className="app-body">
        {/* Sidebar: connection tree */}
        <aside className="sidebar" style={{ width: sidebarWidth, flexShrink: 0 }}>
          <div className="sidebar-head">
            <h2>Connections</h2>
            <div className="sidebar-head-actions">
              <button className="btn btn-secondary btn-xs" onClick={() => setShowDatabaseDiscovery(true)} title="내 PC의 데이터베이스 찾기">
                <Search size={12} /> 찾기
              </button>
              <button
                className="btn btn-secondary btn-xs"
                onClick={() => {
                  setShowCreateForm(!showCreateForm);
                  if (!showCreateForm) resetForm();
                }}
              >
                {showCreateForm ? <><X size={13} /> 취소</> : <><Plus size={13} /> 새 연결</>}
              </button>
            </div>
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
                {editingId && (formDriver === 'mysql' || formDriver === 'postgres' || formDriver === 'sqlite' || formDriver === 'sqlserver') && (
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
                <div className={`conn-modal-body${editingId && (formDriver === 'mysql' || formDriver === 'postgres' || formDriver === 'sqlite' || formDriver === 'sqlserver') ? ' tabbed' : ''}`}>
                  {pendingMcpConnectionProposal && (
                    <div className="dialog-hint" role="note">
                      MCP 연결 제안 검토 중입니다. 비밀번호는 이 화면에서 입력하고, 연결 테스트가 성공한 뒤에만 저장됩니다. 새 연결은 MCP 비활성화와 쓰기 금지로 생성됩니다.
                    </div>
                  )}
                  {discoveredConnectionDraft && !pendingMcpConnectionProposal && (
                    <div className="dialog-hint" role="note">
                      검색된 데이터베이스입니다. 정확한 데이터베이스 이름과 사용자 정보를 입력하고 연결 테스트를 성공시킨 뒤 저장할 수 있습니다.
                    </div>
                  )}
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
                  <div className="field-check">
                    <label>
                      <input type="checkbox" checked={formSafeMode} onChange={(e) => setFormSafeMode(e.target.checked)} />
                      안전 모드 (운영 DB)
                    </label>
                  </div>
                  {formSafeMode && (
                    <div>
                      <label>tenant 스코프 컬럼 (쉼표 구분)</label>
                      <input
                        type="text"
                        placeholder="hospitalId,tenantId"
                        value={formTenantColumns}
                        onChange={(e) => setFormTenantColumns(e.target.value)}
                      />
                    </div>
                  )}
                </>
              ) : (
                <>
              {(formDriver === 'mysql' || formDriver === 'postgres') && (
                <div>
                  <label htmlFor="connection-mode">접속 경로</label>
                  <select id="connection-mode" value={formConnectionMode} onChange={(e) => { setFormConnectionMode(e.target.value as ConnectionMode); setTestedConnectionSettings(null); }}>
                    <option value="direct">직접 연결</option>
                    <option value="ssm">AWS SSM (EC2 경유)</option>
                    <option value="ssh">SSH (Bastion 경유)</option>
                  </select>
                </div>
              )}
              {formConnectionMode === 'ssh' && (formDriver === 'mysql' || formDriver === 'postgres') && (
                <fieldset className="ssm-settings">
                  <legend>SSH Bastion</legend>
                  <div><label htmlFor="ssh-host">Bastion Host</label>
                    <input type="text" id="ssh-host" value={formSSH.host} placeholder="ec2-….compute.amazonaws.com" onChange={(e) => setFormSSH({ ...formSSH, host: e.target.value })} required />
                  </div>
                  <div className="field-row">
                    <div className="field-grow"><label htmlFor="ssh-port">SSH Port</label>
                      <input id="ssh-port" type="number" min={1} max={65535} value={formSSH.port} onChange={(e) => setFormSSH({ ...formSSH, port: Number(e.target.value) })} required />
                    </div>
                    <div className="field-grow"><label htmlFor="ssh-user">SSH User</label>
                      <input type="text" id="ssh-user" value={formSSH.username} onChange={(e) => setFormSSH({ ...formSSH, username: e.target.value })} required />
                    </div>
                  </div>
                  <div><label htmlFor="ssh-identity">SSH 개인 키 파일</label>
                    <div className="field-row"><input type="text" id="ssh-identity" className="field-grow" value={formSSH.identityFile} placeholder="/path/to/Bastion_Host.pem" onChange={(e) => setFormSSH({ ...formSSH, identityFile: e.target.value })} required />
                      <button type="button" className="btn btn-secondary btn-sm" onClick={async () => { const file = await window.electronAPI.pickSSHFile('identity'); if (file) setFormSSH({ ...formSSH, identityFile: file }); }}>키 파일 선택</button>
                    </div>
                  </div>
                  <div><label htmlFor="ssh-known-hosts">known_hosts 파일 (선택)</label>
                    <div className="field-row"><input type="text" id="ssh-known-hosts" className="field-grow" value={formSSH.knownHostsFile ?? ''} placeholder="~/.ssh/known_hosts" onChange={(e) => setFormSSH({ ...formSSH, knownHostsFile: e.target.value })} />
                      <button type="button" className="btn btn-secondary btn-sm" onClick={async () => { const file = await window.electronAPI.pickSSHFile('known-hosts'); if (file) setFormSSH({ ...formSSH, knownHostsFile: file }); }}>호스트 키 파일 선택</button>
                    </div>
                  </div>
                  <p className="ssm-note">아래 Host·Port에는 bastion에서 접근할 실제 DB 주소를 입력하세요. 로컬 터널은 자동으로 연결합니다.</p>
                  <p className="ssm-note">암호가 없는 PEM·OpenSSH 키를 지원합니다. known_hosts에 신뢰할 수 있는 bastion 호스트 키가 등록되어 있어야 합니다. 키 본문은 저장하지 않습니다.</p>
                </fieldset>
              )}
              {formConnectionMode === 'ssm' && (formDriver === 'mysql' || formDriver === 'postgres') && (
                <fieldset className="ssm-settings">
                  <legend>AWS SSM</legend>
                  <div><label htmlFor="ssm-profile">AWS profile (선택)</label>
                    <input type="text" id="ssm-profile" value={formSSM.profile} placeholder="예: production" onChange={(e) => setFormSSM({ ...formSSM, profile: e.target.value })} />
                  </div>
                  <div className="field-row">
                    <div className="field-grow"><label htmlFor="ssm-region">AWS region</label>
                      <input type="text" id="ssm-region" value={formSSM.region} placeholder="ap-northeast-2" onChange={(e) => setFormSSM({ ...formSSM, region: e.target.value })} required />
                    </div>
                    <div className="field-grow"><label htmlFor="ssm-instance">EC2 instance ID</label>
                      <input type="text" id="ssm-instance" value={formSSM.instanceId} placeholder="i-0123456789abcdef0" onChange={(e) => setFormSSM({ ...formSSM, instanceId: e.target.value })} required />
                    </div>
                  </div>
                  <div><label htmlFor="ssm-document">{formUsesDocumentDestination ? 'SSM document' : 'SSM document (선택)'}</label>
                    <input type="text" id="ssm-document" value={formSSM.documentName ?? ''} placeholder="AWS-StartPortForwardingSessionToRemoteHost" maxLength={128} onChange={(e) => setFormSSM({ ...formSSM, documentName: e.target.value })} required={formUsesDocumentDestination} />
                  </div>
                  <div><label htmlFor="ssm-destination-mode">DB 목적지 설정</label>
                    <select id="ssm-destination-mode" value={formSSM.destinationMode ?? 'remote-host'} onChange={(e) => setFormSSM({ ...formSSM, destinationMode: e.target.value as 'remote-host' | 'document' })}>
                      <option value="remote-host">DB Host·Port 직접 지정</option>
                      <option value="document">SSM 문서에서 지정</option>
                    </select>
                  </div>
                  <p className="ssm-note">{formUsesDocumentDestination ? 'DB 목적지는 선택한 SSM 문서에서 가져옵니다. localPortNumber만 전달하며, 로컬 포트는 자동으로 할당합니다.' : '아래 Host·Port에는 EC2에서 접근할 DB 주소를 입력하세요. 문서를 비우면 AWS 표준 문서를 사용합니다. 로컬 포트는 자동으로 할당합니다.'}</p>
                  <p className="ssm-note">AWS CLI와 Session Manager 플러그인이 필요합니다. 기존 AWS profile·SSO를 사용하며, profile을 비우면 기본 AWS 인증 설정을 사용합니다.</p>
                </fieldset>
              )}
              {!formUsesDocumentDestination && <div className="field-row">
                <div className="field-grow">
                  <label>Host</label>
                  <input type="text" value={formHost} onChange={(e) => setFormHost(e.target.value)} required />
                </div>
                <div className="field-shrink">
                  <label>Port</label>
                  <input type="number" value={formPort} onChange={(e) => setFormPort(parseInt(e.target.value))} required />
                </div>
              </div>}
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
              <div className="field-check">
                <label>
                  <input type="checkbox" checked={formReadOnly} onChange={(e) => setFormReadOnly(e.target.checked)} />
                  읽기 전용 (read-only)
                </label>
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
              <div className="field-check">
                <label>
                  <input type="checkbox" checked={formSafeMode} onChange={(e) => setFormSafeMode(e.target.checked)} />
                  안전 모드 (운영 DB)
                </label>
              </div>
              {formSafeMode && (
                <div>
                  <label>tenant 스코프 컬럼 (쉼표 구분)</label>
                  <input
                    type="text"
                    placeholder="hospitalId,tenantId"
                    value={formTenantColumns}
                    onChange={(e) => setFormTenantColumns(e.target.value)}
                  />
                </div>
              )}
                </>
              )}
              <div className="form-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={handleTestConnection} disabled={testingConnection}>
                  {testingConnection ? '연결 중…' : 'Test'}
                </button>
                <button type="submit" className="btn btn-primary btn-sm" disabled={testingConnection}>
                  {editingId ? 'Update' : 'Save'}
                </button>
              </div>
              {(connectionTestSuccess || connectionError) && <div ref={connectionFeedbackRef} aria-live="polite">
                {connectionTestSuccess && <div className="ssm-test-success" role="status">연결 테스트에 성공했습니다.</div>}
                {connectionError && <div className="alert error"><AlertTriangle size={14} /><span>{connectionError}</span></div>}
              </div>}
                  </form>
                  )}

                  {formTab === 'mcp' && editingId && (formDriver === 'mysql' || formDriver === 'postgres' || formDriver === 'sqlite' || formDriver === 'sqlserver') && (
                    <>
                      <McpConnectPanel
                        connId={editingId}
                        connName={formName}
                        initialEnabled={profiles.find((p) => p.id === editingId)?.mcpEnabled ?? false}
                        initialWriteMode={profiles.find((p) => p.id === editingId)?.mcpWriteMode}
                        initialAllowedDatabases={profiles.find((p) => p.id === editingId)?.mcpAllowedDatabases}
                        initialAllowedSchemas={profiles.find((p) => p.id === editingId)?.mcpAllowedSchemas}
                        initialAllowedTables={profiles.find((p) => p.id === editingId)?.mcpAllowedTables}
                        onOpenActivity={() => setShowMcpActivity(true)}
                        onSaved={({ enabled, exposure, scope, writeMode }) => {
                          setProfiles((current) => current.map((profile) => profile.id === editingId ? {
                            ...profile,
                            mcpEnabled: enabled,
                            mcpDataExposure: exposure,
                            mcpWriteMode: writeMode,
                            mcpAllowedDatabases: scope.allowedDatabases.length ? JSON.stringify(scope.allowedDatabases) : '',
                            mcpAllowedSchemas: scope.allowedSchemas.length ? JSON.stringify(scope.allowedSchemas) : '',
                            mcpAllowedTables: scope.allowedTables.length ? JSON.stringify(scope.allowedTables) : '',
                          } : profile));
                          void loadProfiles();
                        }}
                      />
                      <McpServersPanel onOpenActivity={() => setShowMcpActivity(true)} />
                    </>
                  )}

                  {formTab === 'schema' && editingId && (formDriver === 'mysql' || formDriver === 'postgres' || formDriver === 'sqlite' || formDriver === 'sqlserver') && (
                    <div className="ctp-section">
                      <div className="ctp-head">표시할 스키마 및 테이블</div>
                      <p className="ctp-hint">새 연결은 기본적으로 모든 스키마가 숨겨집니다. 상단 전체 체크로 한 번에 선택하거나 해제한 뒤, 필요한 스키마만 켤 수 있습니다.</p>
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
                          {p.driver === 'sqlite' ? (p.database.split('/').pop() || p.database) : p.connectionMode === 'ssm' && p.ssm?.destinationMode === 'document' ? `SSM · ${p.ssm.documentName}` : `${p.connectionMode === 'ssm' ? 'SSM · ' : p.connectionMode === 'ssh' ? 'SSH · ' : ''}${p.host}:${p.port}`}
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
                          <SchemaExplorer
                            profileId={p.id!}
                            profiles={profiles}
                            driver={p.driver as 'mysql' | 'postgres' | 'redis' | 'sqlite' | 'sqlserver'}
                            hiddenStore={hiddenStore}
                            onHiddenStoreChange={updateHidden}
                            onDisconnect={() => disconnect(p.id!)}
                            onSchemaChanged={() => setSchemaVersion((n) => n + 1)}
                            onOpenQuery={(db) => openSchemaQuery(p.id!, db)}
                            onOpenTableData={(db, table) => {
                              setTemplateView((m) => ({ ...m, [p.id!]: null }));
                              setErTab((prev) => ({ ...prev, [p.id!]: null }));
                              setOpenTable((prev) => ({ ...prev, [p.id!]: { db, table } }));
                            }}
                            onOpenErDiagram={(db) => {
                              setTemplateView((m) => ({ ...m, [p.id!]: null }));
                              setOpenTable((prev) => ({ ...prev, [p.id!]: null }));
                              setErTab((prev) => ({ ...prev, [p.id!]: { db } }));
                            }}
                            onRunQuery={({ database, sql }) => {
                              dispatch({ type: 'focus', profileId: p.id! });
                              setTemplateView((m) => ({ ...m, [p.id!]: null }));
                              setErTab((prev) => ({ ...prev, [p.id!]: null }));
                              setOpenTable((prev) => ({ ...prev, [p.id!]: null }));
                              setQueryRequest(createSqlQueryRequest(p.id!, database, sql, true, Date.now(), true));
                            }}
                          />
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
                  <div className="conn-panel-body">
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
                        <span className="redis-tabs-fill" />
                        <button className="btn btn-secondary btn-sm query-library-action" onClick={() => openLibrary()}>
                          <BookOpen size={13} /> Query Library
                        </button>
                      </div>
                      {redisTab[id] === 'console' ? (
	                        <RedisConsole
	                          profileId={id}
	                          onRan={() => setHistoryTrigger((n) => n + 1)}
	                          onSaved={() => setSavedTrigger((n) => n + 1)}
	                          loadRequest={focused && loadReq?.profileId === id ? { text: loadReq.text, nonce: loadReq.nonce } : undefined}
	                          agentTitlesEnabled={showAgent}
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
                            <button className="btn btn-secondary btn-sm query-library-action" onClick={() => openLibrary()}>
                              <BookOpen size={13} /> Query Library
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
	                                agentTitlesEnabled={showAgent}
	                              />
                            )}
                          </div>
                        </div>
                      );
                    })()
                  ) : templateView[id] ? (
                    <TemplateRunner
                      key={templateView[id]!.id}
                      template={templateView[id]!}
                      profileId={id}
                      driver={profile.driver}
                      tables={tplSchema.tables}
                      columns={tplSchema.columns}
                      roles={parseRoles(profile)}
                      onClose={() => setTemplateView((m) => ({ ...m, [id]: null }))}
                      onOpenInEditor={(sql) => {
                        setTemplateView((m) => ({ ...m, [id]: null }));
                        handleSelectQuery(sql);
                      }}
                    />
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
                      profileReadOnly={profile.readOnly ?? false}
                      safeMode={profile.safeMode ?? false}
                      onQueryExecuted={() => setHistoryTrigger((n) => n + 1)}
                      loadTriggerQuery={focused ? selectedQueryText : ''}
                      queryRequest={queryRequest?.profileId === id ? queryRequest : undefined}
                      schemaVersion={schemaVersion}
                      agentTitlesEnabled={showAgent}
                      onOpenLibrary={() => openLibrary()}
                      onRegisterDisconnect={(handler) => registerDisconnectGuard(id, handler)}
                    />
                  )}
                  </div>
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

      <footer className="statusbar">
        <div className="statusbar-left">
          <button
            className={`statusbar-action${mcpActivitySummary.errors > 0 ? ' has-alert' : ''}`}
            onClick={() => setShowMcpActivity(true)}
            aria-label="MCP 활동 열기"
          >
            <Activity size={13} />
            <span>MCP 활동</span>
            {mcpActivitySummary.total > 0 && <span className="statusbar-count">{mcpActivitySummary.total}</span>}
            {mcpActivitySummary.errors > 0 && <span className="statusbar-alert">{mcpActivitySummary.errors} 실패</span>}
          </button>
        </div>
        <span className="statusbar-hint">호출·핸드셰이크·연결 상태 보기</span>
      </footer>

      {/* Template dialogs */}
      {domainDialogOpen && focusedProfile && (
        <DomainBindingsDialog
          profile={focusedProfile}
          columns={tplSchema.columns}
          tables={tplSchema.tables}
          columnsByTable={tplColumnsByTable}
          onClose={() => setDomainDialogOpen(false)}
          onSaved={() => loadProfiles()}
        />
      )}
      {saveTplOpen && (
        <SaveTemplateDialog
          initialSql={selectedQueryText || ''}
          profileId={conns.focusedId ?? ''}
          onClose={() => setSaveTplOpen(false)}
          onSaved={() => setTplReload((n) => n + 1)}
        />
      )}
    </div>
  );
}

export default App;
