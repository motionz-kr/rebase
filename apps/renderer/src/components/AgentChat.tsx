import React, { useState, useRef, useEffect } from 'react';
import { Bot, CornerDownLeft, X, Wrench, Settings } from 'lucide-react';
import { applyAgentChunk, type AgentMessage } from '../lib/agentStream';

interface AgentSettings {
  provider: 'stub' | 'anthropic';
  apiKey: string;
  model: string;
}
const SETTINGS_KEY = 'rebase.agent.settings';
const defaultSettings: AgentSettings = { provider: 'stub', apiKey: '', model: 'claude-sonnet-4-6' };

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
}

export const AgentChat: React.FC<AgentChatProps> = ({ profileId, connectionName, onClose }) => {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<AgentSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const runRef = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    const off = window.electronAPI.onAgentStreamChunk((rId, chunk) => {
      if (rId !== runRef.current) return;
      setMessages((prev) => applyAgentChunk(prev, chunk));
      if (chunk.kind === 'done' || chunk.kind === 'error') setBusy(false);
    });
    return off;
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

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
              <option value="anthropic">Anthropic API</option>
            </select>
          </label>
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
                  <span className="agent-tool" key={j} title={JSON.stringify(t.args)}>
                    <Wrench size={11} /> {t.name}
                  </span>
                ))}
              </div>
            )}
            <div className="agent-text">{m.text || (busy && i === messages.length - 1 ? '…' : '')}</div>
          </div>
        ))}
      </div>

      <div className="agent-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={profileId ? 'Ask the agent…' : 'Connect to a database first'}
          rows={2}
          disabled={busy || !profileId}
        />
        <button className="icon-btn" onClick={send} disabled={busy || !profileId || !input.trim()} title="Send (Enter)">
          <CornerDownLeft size={15} />
        </button>
      </div>
    </div>
  );
};
