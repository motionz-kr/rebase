import React, { useState, useRef, useEffect } from 'react';
import { Bot, CornerDownLeft, X, Wrench, Settings, AlertTriangle, Play, Check, Maximize2, Minimize2 } from 'lucide-react';
import { applyAgentChunk, prettyToolName, asGridResult, type AgentMessage } from '../lib/agentStream';
import { classifyStatement } from '../lib/sqlDanger';

interface Proposal {
  sql: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'dismissed';
  message?: string;
}

interface AgentSettings {
  provider: 'stub' | 'anthropic' | 'anthropic-oauth' | 'openai' | 'cli' | 'codex';
  model: string;
  autonomy: 'approval' | 'autonomous';
  dataExposure: 'metadata' | 'on_request' | 'unrestricted';
}
const SETTINGS_KEY = 'rebase.agent.settings';
const defaultSettings: AgentSettings = {
  provider: 'stub',
  model: 'claude-sonnet-4-6',
  autonomy: 'approval',
  dataExposure: 'metadata',
};

function loadSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Drop any legacy plaintext apiKey: keys now live in the OS keychain.
      delete parsed.apiKey;
      return { ...defaultSettings, ...parsed };
    }
  } catch {
    /* ignore */
  }
  return defaultSettings;
}

interface AgentChatProps {
  profileId: string | null;
  connectionName?: string;
  onClose: () => void;
  popped?: boolean;
  onTogglePopout?: () => void;
  onSendToEditor?: (sql: string) => void;
}

export const AgentChat: React.FC<AgentChatProps> = ({
  profileId,
  connectionName,
  onClose,
  popped,
  onTogglePopout,
  onSendToEditor,
}) => {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<AgentSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const [cliStatus, setCliStatus] = useState<
    { loading: boolean; installed?: boolean; loggedIn?: boolean; email?: string; subscription?: string; detail?: string } | null
  >(null);
  // API key lives in the OS keychain, never in component/localStorage state.
  // We hold only the in-progress input and whether a key is already stored.
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [keyPresent, setKeyPresent] = useState<boolean | null>(null);

  const isCliProvider = (p: AgentSettings['provider']) => p === 'cli' || p === 'codex';
  const isOAuthProvider = (p: AgentSettings['provider']) => p === 'anthropic-oauth';
  const cliTool = settings.provider === 'codex' ? 'codex' : 'claude';

  // Subscription OAuth (Claude). Tokens live in the keychain via the engine; here
  // we track only login status + the in-progress paste-code flow.
  const [oauthStatus, setOauthStatus] = useState<{ loading: boolean; loggedIn?: boolean } | null>(null);
  const [oauthAwaitingCode, setOauthAwaitingCode] = useState(false);
  const [oauthCode, setOauthCode] = useState('');
  const [oauthError, setOauthError] = useState<string | null>(null);

  const refreshOAuthStatus = async () => {
    setOauthStatus({ loading: true });
    const res = await window.electronAPI.agentOAuthStatus('anthropic');
    setOauthStatus({ loading: false, loggedIn: res.success && res.data ? res.data.loggedIn : false });
  };
  const startOAuth = async () => {
    setOauthError(null);
    const res = await window.electronAPI.agentOAuthStart('anthropic');
    if (!res.success) {
      setOauthError(res.error || '로그인을 시작하지 못했습니다.');
      return;
    }
    setOauthAwaitingCode(true);
  };
  const completeOAuth = async () => {
    const code = oauthCode.trim();
    if (!code) return;
    setOauthError(null);
    setOauthStatus({ loading: true });
    const res = await window.electronAPI.agentOAuthComplete('anthropic', code);
    if (!res.success) {
      setOauthError(res.error || '인증에 실패했습니다.');
      setOauthStatus({ loading: false, loggedIn: false });
      return;
    }
    setOauthAwaitingCode(false);
    setOauthCode('');
    await refreshOAuthStatus();
  };
  const logoutOAuth = async () => {
    await window.electronAPI.agentOAuthLogout('anthropic');
    setOauthAwaitingCode(false);
    setOauthCode('');
    await refreshOAuthStatus();
  };

  const refreshCliStatus = async () => {
    setCliStatus({ loading: true });
    const res = await window.electronAPI.agentCliStatus(cliTool);
    setCliStatus(res.success && res.data ? { loading: false, ...res.data } : { loading: false, detail: res.error || 'status check failed' });
  };
  const runRef = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef(profileId);
  profileRef.current = profileId;

  const needsApiKey = (p: AgentSettings['provider']) => p === 'anthropic' || p === 'openai';

  const refreshKeyStatus = async () => {
    if (!needsApiKey(settings.provider)) {
      setKeyPresent(null);
      return;
    }
    const res = await window.electronAPI.agentKeyStatus(settings.provider);
    setKeyPresent(res.success && res.data ? res.data.present : false);
  };
  const saveKey = async () => {
    const k = apiKeyInput.trim();
    if (!k) return;
    await window.electronAPI.agentKeySet(settings.provider, k);
    setApiKeyInput('');
    await refreshKeyStatus();
  };
  const clearKey = async () => {
    await window.electronAPI.agentKeyClear(settings.provider);
    await refreshKeyStatus();
  };

  const updateSettings = (patch: Partial<AgentSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // Switch provider, nudging the model to a sensible default for the new one.
  const setProvider = (provider: AgentSettings['provider']) => {
    const patch: Partial<AgentSettings> = { provider };
    if (provider === 'openai' && settings.model.startsWith('claude')) patch.model = 'gpt-4o';
    // The Claude subscription (OAuth) path only accepts Claude 4 dated model ids,
    // so pin a known-good one when switching to it.
    else if (provider === 'anthropic-oauth') patch.model = 'claude-sonnet-4-5-20250929';
    else if (provider === 'anthropic' && settings.model.startsWith('gpt')) patch.model = 'claude-sonnet-4-6';
    updateSettings(patch);
  };

  const runProposal = async (id: string, sql: string) => {
    const pid = profileRef.current;
    if (!pid) return;
    setProposals((prev) => ({ ...prev, [id]: { sql, status: 'running' } }));
    try {
      const res = await window.electronAPI.executeBatch(pid, [sql]);
      const ok = res.success && res.data?.ok;
      setProposals((prev) => ({
        ...prev,
        [id]: {
          sql,
          status: ok ? 'done' : 'error',
          message: ok ? `${res.data?.rowsAffected ?? 0} row(s) affected` : res.data?.error || res.error || 'failed',
        },
      }));
    } catch (e) {
      setProposals((prev) => ({ ...prev, [id]: { sql, status: 'error', message: e instanceof Error ? e.message : 'failed' } }));
    }
  };

  useEffect(() => {
    const off = window.electronAPI.onAgentStreamChunk((rId, chunk) => {
      if (rId !== runRef.current) return;
      setMessages((prev) => applyAgentChunk(prev, chunk));
      if (chunk.kind === 'done' || chunk.kind === 'error') setBusy(false);
    });
    return off;
  }, []);

  // Autonomous mode auto-runs only safe proposals; dangerous ones always wait
  // for an explicit click. Approval mode waits for every write.
  useEffect(() => {
    if (settings.autonomy !== 'autonomous') return;
    messages.forEach((m, i) =>
      m.tools.forEach((t, j) => {
        if (t.name !== 'propose_write') return;
        const key = `${i}:${j}`;
        const sql = String(t.args?.sql ?? '');
        if (!proposals[key] && sql && classifyStatement(sql).risk === 'safe') {
          void runProposal(key, sql);
        }
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, settings.autonomy]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  // One-time migration: move a legacy plaintext key out of localStorage and
  // into the OS keychain, so users who configured a key before this change
  // don't have to re-enter it.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!('apiKey' in parsed)) return;
      const legacy = parsed.apiKey;
      delete parsed.apiKey;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed));
      if (legacy && (parsed.provider === 'anthropic' || parsed.provider === 'openai')) {
        void window.electronAPI.agentKeySet(parsed.provider, legacy).then(() => void refreshKeyStatus());
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect whether an API key is already stored in the keychain for the
  // selected Direct-API provider.
  useEffect(() => {
    setApiKeyInput('');
    void refreshKeyStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.provider]);

  // Check CLI login status when a CLI provider is active, and again when the
  // window regains focus (e.g. after completing login in the terminal).
  useEffect(() => {
    if (!isCliProvider(settings.provider)) return;
    void refreshCliStatus();
    const onFocus = () => void refreshCliStatus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.provider]);

  // Check Claude OAuth login status when that provider is active.
  useEffect(() => {
    if (!isOAuthProvider(settings.provider)) return;
    setOauthAwaitingCode(false);
    setOauthCode('');
    setOauthError(null);
    void refreshOAuthStatus();
  }, [settings.provider]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy || !profileId) return;
    setInput('');
    const convo: AgentMessage[] = [
      ...messages,
      { role: 'user', text, tools: [] },
      { role: 'assistant', text: '', tools: [] },
    ];
    setMessages(convo);
    setBusy(true);

    const runId = `agent-${crypto.randomUUID()}`;
    runRef.current = runId;
    // Send the visible transcript (role + text), excluding the empty placeholder.
    const history = convo
      .filter((m, i) => !(i === convo.length - 1 && m.role === 'assistant' && m.text === ''))
      .map((m) => ({ role: m.role, text: m.text }));

    const res = await window.electronAPI.agentRun(runId, profileId, history, {
      provider: settings.provider,
      // API key is resolved engine-side from the OS keychain (never sent here).
      // CLI providers (claude/codex) use their own logged-in default model.
      model: needsApiKey(settings.provider) ? settings.model : '',
      dataExposure: settings.dataExposure,
    });
    if (!res.success) {
      setMessages((prev) => applyAgentChunk(prev, { kind: 'error', err: res.error || 'agent request failed' }));
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="agent-chat">
      <div className="agent-head">
        <span className="agent-head-icon">
          <Bot size={15} />
        </span>
        <h2>Agent</h2>
        <span className="agent-head-spacer" />
        {connectionName && <span className="agent-conn">{connectionName}</span>}
        <button
          className={`icon-btn${settingsOpen ? ' active' : ''}`}
          title="Agent settings"
          onClick={() => setSettingsOpen((v) => !v)}
        >
          <Settings size={15} />
        </button>
        {onTogglePopout && (
          <button className="icon-btn" title={popped ? 'Dock to side' : 'Open as full tab'} onClick={onTogglePopout}>
            {popped ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        )}
        <button className="icon-btn" title="Close" onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      {settingsOpen && (
        <div className="agent-settings">
          <label>
            Provider
            <select value={settings.provider} onChange={(e) => setProvider(e.target.value as AgentSettings['provider'])}>
              <option value="stub">Stub (offline)</option>
              <option value="anthropic">Anthropic API key</option>
              <option value="anthropic-oauth">Claude (구독 로그인 — API 키 불필요)</option>
              <option value="openai">OpenAI API key</option>
              <option value="cli">Local CLI — claude (uses your login)</option>
              <option value="codex">Local CLI — codex (uses your login)</option>
            </select>
          </label>
          {isCliProvider(settings.provider) && (
            <div className="agent-cli-status">
              <p className="agent-settings-note">
                Uses your logged-in <code>{cliTool}</code> CLI — no API key needed.
              </p>
              {cliStatus?.loading && <div className="cli-line">Checking claude login…</div>}
              {cliStatus && !cliStatus.loading && cliStatus.loggedIn && (
                <div className="cli-line ok">
                  <Check size={13} /> Logged in{cliStatus.email ? ` as ${cliStatus.email}` : ''}
                  {cliStatus.subscription ? ` (${cliStatus.subscription})` : ''}
                </div>
              )}
              {cliStatus && !cliStatus.loading && !cliStatus.loggedIn && (
                <div className="cli-line warn">
                  <AlertTriangle size={13} />
                  <span>
                    {cliStatus.installed === false ? `${cliTool} CLI not found on PATH.` : `Not logged in to ${cliTool}.`}
                  </span>
                </div>
              )}
              <p className="agent-settings-note">
                Already logged in? The stored token can still expire. If a request returns 401, re-authenticate.
              </p>
              <div className="cli-actions">
                {cliStatus?.installed !== false && (
                  <button className="btn btn-primary btn-sm" onClick={() => window.electronAPI.agentCliLogin(cliTool)}>
                    {cliStatus?.loggedIn ? 'Re-authenticate' : 'Log in to claude'}
                  </button>
                )}
                <button className="btn btn-secondary btn-sm" onClick={() => void refreshCliStatus()} disabled={cliStatus?.loading}>
                  Re-check
                </button>
              </div>
            </div>
          )}
          {isOAuthProvider(settings.provider) && (
            <div className="agent-cli-status">
              <p className="agent-settings-note">Claude Pro/Max 구독으로 로그인합니다 — API 키가 필요 없습니다.</p>
              {oauthStatus?.loading && <div className="cli-line">확인 중…</div>}
              {oauthStatus && !oauthStatus.loading && oauthStatus.loggedIn && (
                <div className="cli-line ok">
                  <Check size={13} /> 로그인됨
                </div>
              )}
              {oauthStatus && !oauthStatus.loading && !oauthStatus.loggedIn && !oauthAwaitingCode && (
                <div className="cli-line warn">
                  <AlertTriangle size={13} />
                  <span>로그인이 필요합니다.</span>
                </div>
              )}
              {oauthAwaitingCode && (
                <div className="agent-oauth-paste">
                  <p className="agent-settings-note">브라우저에서 로그인·승인 후 표시되는 인증 코드를 붙여넣으세요.</p>
                  <input
                    type="text"
                    value={oauthCode}
                    onChange={(e) => setOauthCode(e.target.value)}
                    placeholder="인증 코드 (code#state)"
                    autoFocus
                  />
                </div>
              )}
              {oauthError && (
                <div className="cli-line warn">
                  <AlertTriangle size={13} />
                  <span>{oauthError}</span>
                </div>
              )}
              <div className="cli-actions">
                {oauthStatus?.loggedIn ? (
                  <button className="btn btn-secondary btn-sm" onClick={() => void logoutOAuth()}>
                    로그아웃
                  </button>
                ) : oauthAwaitingCode ? (
                  <button className="btn btn-primary btn-sm" onClick={() => void completeOAuth()} disabled={!oauthCode.trim()}>
                    완료
                  </button>
                ) : (
                  <button className="btn btn-primary btn-sm" onClick={() => void startOAuth()}>
                    로그인
                  </button>
                )}
                <button className="btn btn-secondary btn-sm" onClick={() => void refreshOAuthStatus()} disabled={oauthStatus?.loading}>
                  다시 확인
                </button>
              </div>
            </div>
          )}
          {needsApiKey(settings.provider) && (
            <>
              <label>
                API key
                <div className="agent-key-row">
                  <input
                    type="password"
                    value={apiKeyInput}
                    placeholder={
                      keyPresent
                        ? 'Stored — enter a new key to replace'
                        : settings.provider === 'openai'
                        ? 'sk-…'
                        : 'sk-ant-…'
                    }
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void saveKey();
                      }
                    }}
                  />
                  <button className="btn btn-primary btn-sm" onClick={() => void saveKey()} disabled={!apiKeyInput.trim()}>
                    Save
                  </button>
                </div>
              </label>
              {keyPresent !== null && (
                <div className="agent-key-status">
                  {keyPresent ? (
                    <span className="cli-line ok">
                      <Check size={13} /> Key stored in keychain
                      <button className="btn btn-secondary btn-xs" onClick={() => void clearKey()}>
                        Remove
                      </button>
                    </span>
                  ) : (
                    <span className="cli-line warn">
                      <AlertTriangle size={13} /> No key stored for this provider
                    </span>
                  )}
                </div>
              )}
              <label>
                Model
                <input type="text" value={settings.model} onChange={(e) => updateSettings({ model: e.target.value })} />
              </label>
              <p className="agent-settings-note">
                The key is stored in your OS keychain via the local engine, then sent only to the{' '}
                {settings.provider === 'openai' ? 'OpenAI' : 'Anthropic'} API.
              </p>
            </>
          )}
          <label>
            Autonomy
            <select
              value={settings.autonomy}
              onChange={(e) => updateSettings({ autonomy: e.target.value as AgentSettings['autonomy'] })}
            >
              <option value="approval">Approval (you run every write)</option>
              <option value="autonomous">Autonomous (auto-run safe writes)</option>
            </select>
          </label>
          <label>
            Data exposure
            <select
              value={settings.dataExposure}
              onChange={(e) => updateSettings({ dataExposure: e.target.value as AgentSettings['dataExposure'] })}
            >
              <option value="metadata">Metadata only (no row values to model)</option>
              <option value="on_request">On request</option>
              <option value="unrestricted">Unrestricted</option>
            </select>
          </label>
          {settings.autonomy === 'autonomous' && settings.dataExposure === 'unrestricted' && (
            <p className="agent-settings-note warn">
              ⚠️ Autonomous + Unrestricted is the least restrictive combination.
            </p>
          )}
        </div>
      )}

      <div className="agent-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="agent-empty">
            <span className="agent-empty-icon">
              <Bot size={22} />
            </span>
            <p className="agent-empty-title">Ask about your database</p>
            <p className="agent-empty-sub">
              The agent inspects schema, runs read-only queries, and proposes changes for your approval.
            </p>
            <div className="agent-empty-chips">
              {['How many tables are there?', 'Describe the users table', 'Show 10 recent rows'].map((ex) => (
                <button key={ex} className="agent-chip" onClick={() => setInput(ex)} disabled={!profileId}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
        {!profileId && <div className="alert error">Connect to a database first.</div>}
        {messages.map((m, i) => (
          <div className={`agent-msg ${m.role}`} key={i}>
            {m.role === 'assistant' && (
              <div className="agent-msg-head">
                <span className="agent-avatar">
                  <Bot size={12} />
                </span>
                <span className="agent-name">Agent</span>
              </div>
            )}
            {m.tools.length > 0 && (
              <details className="agent-tools-detail">
                <summary>
                  <Wrench size={11} /> {m.tools.length} tool {m.tools.length === 1 ? 'call' : 'calls'}
                </summary>
                <div className="agent-tools">
                  {m.tools.map((t, j) => (
                    <span className="agent-tool" key={j} title={`${t.name} ${JSON.stringify(t.args)}`}>
                      {prettyToolName(t.name)}
                    </span>
                  ))}
                </div>
              </details>
            )}
            {(m.results ?? []).map((r, k) => {
              const grid = asGridResult(r.result);
              if (!grid) return null;
              const call = m.tools.find((t) => t.id === r.toolCallId);
              const sql = call ? String(call.args?.sql ?? '') : '';
              const rows = grid.rows.slice(0, 12);
              return (
                <div className="agent-result" key={`r${k}`}>
                  <div className="agent-result-head">
                    <span>
                      {prettyToolName(r.toolName)} · {grid.rows.length} row{grid.rows.length === 1 ? '' : 's'}
                    </span>
                    {sql && onSendToEditor && (
                      <button className="btn btn-secondary btn-xs" onClick={() => onSendToEditor(sql)}>
                        Send query to editor
                      </button>
                    )}
                  </div>
                  <div className="agent-result-scroll">
                    <table className="agent-result-grid">
                      <thead>
                        <tr>
                          {grid.columns.map((c, ci) => (
                            <th key={ci}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, ri) => (
                          <tr key={ri}>
                            {grid.columns.map((_, ci) => (
                              <td key={ci}>{row[ci] === null ? <span className="cell-null">NULL</span> : String(row[ci])}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {grid.rows.length > rows.length && <div className="agent-result-more">…{grid.rows.length - rows.length} more rows</div>}
                </div>
              );
            })}
            <div className="agent-text">{m.text || (busy && i === messages.length - 1 ? '…' : '')}</div>
            {m.tools.map((t, j) => {
              if (t.name !== 'propose_write') return null;
              const sql = String(t.args?.sql ?? '');
              const key = `${i}:${j}`;
              const cls = classifyStatement(sql);
              const p = proposals[key] ?? { sql, status: 'pending' as const };
              return (
                <div className={`agent-proposal ${cls.risk}`} key={`p${j}`}>
                  <div className="agent-proposal-head">
                    {cls.risk === 'dangerous' ? <AlertTriangle size={13} /> : <Wrench size={13} />}
                    <span>Proposed change{cls.risk === 'dangerous' ? ' — dangerous' : ''}</span>
                  </div>
                  <pre className="agent-proposal-sql">{sql}</pre>
                  {cls.reasons.length > 0 && <div className="agent-proposal-why">{cls.reasons.join('; ')}</div>}
                  {p.status === 'pending' && (
                    <div className="agent-proposal-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => runProposal(key, sql)} disabled={!profileId}>
                        <Play size={12} /> Run
                      </button>
                      {onSendToEditor && (
                        <button className="btn btn-secondary btn-sm" onClick={() => onSendToEditor(sql)}>
                          Send to editor
                        </button>
                      )}
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setProposals((prev) => ({ ...prev, [key]: { sql, status: 'dismissed' } }))}
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                  {p.status === 'running' && <div className="agent-proposal-status">Running…</div>}
                  {p.status === 'done' && (
                    <div className="agent-proposal-status ok">
                      <Check size={12} /> {p.message}
                    </div>
                  )}
                  {p.status === 'error' && <div className="agent-proposal-status err">{p.message}</div>}
                  {p.status === 'dismissed' && <div className="agent-proposal-status">Dismissed</div>}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {isCliProvider(settings.provider) &&
        messages.length > 0 &&
        /401|authentication_error|Failed to authenticate|not logged in|unauthor/i.test(messages[messages.length - 1].text) && (
          <div className="agent-authfix">
            <AlertTriangle size={14} />
            <span>{cliTool} session problem. Re-authenticate, then send again.</span>
            <button className="btn btn-primary btn-sm" onClick={() => window.electronAPI.agentCliLogin(cliTool)}>
              Re-authenticate
            </button>
          </div>
        )}

      <div className="agent-composer">
        <div className="agent-composer-box">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={profileId ? 'Ask the agent…' : 'Connect to a database first'}
            rows={2}
            disabled={busy || !profileId}
          />
          <div className="agent-composer-bar">
          <select
            className="agent-pick"
            title="Provider"
            value={settings.provider}
            onChange={(e) => setProvider(e.target.value as AgentSettings['provider'])}
          >
            <option value="stub">Stub</option>
            <option value="anthropic">Anthropic API</option>
            <option value="openai">OpenAI API</option>
            <option value="cli">claude CLI</option>
            <option value="codex">codex CLI</option>
          </select>
          {needsApiKey(settings.provider) && (
            <select
              className="agent-pick"
              title="Model"
              value={settings.model}
              onChange={(e) => updateSettings({ model: e.target.value })}
            >
              {modelOptions(settings.provider, settings.model).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
          <span className="agent-composer-spacer" />
          <button className="btn btn-primary btn-sm" onClick={send} disabled={busy || !profileId || !input.trim()} title="Send (Enter)">
            <CornerDownLeft size={13} /> Send
          </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// modelOptions lists a few common Anthropic models plus whatever the user has
// configured (so a custom model typed in settings is never lost from the picker).
function modelOptions(provider: string, current: string): string[] {
  let presets: string[];
  if (provider === 'openai') {
    presets = ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'];
  } else if (provider === 'anthropic-oauth') {
    // Claude subscription accepts only Claude 4 dated ids (3.5 ids 404).
    presets = ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-20250514', 'claude-opus-4-1-20250805'];
  } else {
    presets = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-6'];
  }
  return Array.from(new Set(current ? [current, ...presets] : presets));
}
