import React, { useState, useRef, useEffect } from 'react';
import { Bot, CornerDownLeft, X, Wrench, Settings, AlertTriangle, Play, Check, Maximize2, Minimize2 } from 'lucide-react';
import { applyAgentChunk, prettyToolName, type AgentMessage } from '../lib/agentStream';
import { classifyStatement } from '../lib/sqlDanger';

interface Proposal {
  sql: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'dismissed';
  message?: string;
}

interface AgentSettings {
  provider: 'stub' | 'anthropic' | 'cli';
  apiKey: string;
  model: string;
  autonomy: 'approval' | 'autonomous';
  dataExposure: 'metadata' | 'on_request' | 'unrestricted';
}
const SETTINGS_KEY = 'rebase.agent.settings';
const defaultSettings: AgentSettings = {
  provider: 'stub',
  apiKey: '',
  model: 'claude-sonnet-4-6',
  autonomy: 'approval',
  dataExposure: 'metadata',
};

function loadSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultSettings, ...JSON.parse(raw) };
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
}

export const AgentChat: React.FC<AgentChatProps> = ({ profileId, connectionName, onClose, popped, onTogglePopout }) => {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<AgentSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const [cliStatus, setCliStatus] = useState<
    { loading: boolean; installed?: boolean; loggedIn?: boolean; email?: string; subscription?: string; detail?: string } | null
  >(null);

  const refreshCliStatus = async () => {
    setCliStatus({ loading: true });
    const res = await window.electronAPI.agentCliStatus();
    setCliStatus(res.success && res.data ? { loading: false, ...res.data } : { loading: false, detail: res.error || 'status check failed' });
  };
  const runRef = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef(profileId);
  profileRef.current = profileId;

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

  // Check claude login status when the CLI provider is active, and again when
  // the window regains focus (e.g. after completing login in the terminal).
  useEffect(() => {
    if (settings.provider !== 'cli') return;
    void refreshCliStatus();
    const onFocus = () => void refreshCliStatus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      apiKey: settings.apiKey,
      model: settings.model,
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
        <span className="tree-icon">
          <Bot size={15} />
        </span>
        <h2>Agent</h2>
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
            <select
              value={settings.provider}
              onChange={(e) => updateSettings({ provider: e.target.value as AgentSettings['provider'] })}
            >
              <option value="stub">Stub (offline)</option>
              <option value="anthropic">Anthropic API key</option>
              <option value="cli">Local CLI — claude (uses your login)</option>
            </select>
          </label>
          {settings.provider === 'cli' && (
            <div className="agent-cli-status">
              <p className="agent-settings-note">
                Uses your logged-in <code>claude</code> CLI — no API key needed.
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
                  <span>{cliStatus.installed === false ? 'claude CLI not found on PATH.' : 'Not logged in to claude.'}</span>
                </div>
              )}
              <p className="agent-settings-note">
                Already logged in? The stored token can still expire. If a request returns 401, re-authenticate.
              </p>
              <div className="cli-actions">
                {cliStatus?.installed !== false && (
                  <button className="btn btn-primary btn-sm" onClick={() => window.electronAPI.agentCliLogin()}>
                    {cliStatus?.loggedIn ? 'Re-authenticate' : 'Log in to claude'}
                  </button>
                )}
                <button className="btn btn-secondary btn-sm" onClick={() => void refreshCliStatus()} disabled={cliStatus?.loading}>
                  Re-check
                </button>
              </div>
            </div>
          )}
          {settings.provider === 'anthropic' && (
            <>
              <label>
                API key
                <input
                  type="password"
                  value={settings.apiKey}
                  placeholder="sk-ant-…"
                  onChange={(e) => updateSettings({ apiKey: e.target.value })}
                />
              </label>
              <label>
                Model
                <input
                  type="text"
                  value={settings.model}
                  onChange={(e) => updateSettings({ model: e.target.value })}
                />
              </label>
              <p className="agent-settings-note">
                The key is sent to the local engine only and used directly against the Anthropic API.
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
          <div className="agent-hint">
            Ask about the connected database — e.g. <code>how many tables are there?</code>,{' '}
            <code>describe the users table</code>. (Offline stub provider; configure a real model in settings.)
          </div>
        )}
        {!profileId && <div className="alert error">Connect to a database first.</div>}
        {messages.map((m, i) => (
          <div className={`agent-msg ${m.role}`} key={i}>
            <div className="agent-role">{m.role === 'user' ? 'You' : 'Agent'}</div>
            {m.tools.length > 0 && (
              <div className="agent-tools">
                {m.tools.map((t, j) => (
                  <span className="agent-tool" key={j} title={`${t.name} ${JSON.stringify(t.args)}`}>
                    <Wrench size={11} /> {prettyToolName(t.name)}
                  </span>
                ))}
              </div>
            )}
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

      {settings.provider === 'cli' &&
        messages.length > 0 &&
        /401|authentication_error|Failed to authenticate/i.test(messages[messages.length - 1].text) && (
          <div className="agent-authfix">
            <AlertTriangle size={14} />
            <span>claude session expired (401). Re-authenticate, then send again.</span>
            <button className="btn btn-primary btn-sm" onClick={() => window.electronAPI.agentCliLogin()}>
              Re-authenticate
            </button>
          </div>
        )}

      <div className="agent-composer">
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
            onChange={(e) => updateSettings({ provider: e.target.value as AgentSettings['provider'] })}
          >
            <option value="stub">Stub</option>
            <option value="anthropic">Anthropic API</option>
            <option value="cli">claude CLI</option>
          </select>
          {settings.provider === 'anthropic' && (
            <select
              className="agent-pick"
              title="Model"
              value={settings.model}
              onChange={(e) => updateSettings({ model: e.target.value })}
            >
              {modelOptions(settings.model).map((m) => (
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
  );
};

// modelOptions lists a few common Anthropic models plus whatever the user has
// configured (so a custom model typed in settings is never lost from the picker).
function modelOptions(current: string): string[] {
  const common = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-6'];
  const all = current ? [current, ...common] : common;
  return Array.from(new Set(all));
}
