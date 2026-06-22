import React, { useState, useRef, useEffect } from 'react';
import { Bot, CornerDownLeft, X, Wrench, AlertTriangle, Play, Check, Maximize2, Minimize2 } from 'lucide-react';
import { applyAgentChunk, prettyToolName, asGridResult, type AgentMessage } from '../lib/agentStream';
import { classifyStatement } from '../lib/sqlDanger';
import { AgentMarkdown } from './AgentMarkdown';
import {
  AGENT_SETTINGS_EVENT,
  loadAgentSettings,
  modelOptionsForProvider,
  saveAgentSettings,
  type AgentSettings,
} from '../lib/agentSettings';

interface Proposal {
  sql: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'dismissed';
  message?: string;
}

// An untrusted external MCP tool result asks the user to confirm before the
// tool actually runs. The engine emits this shape as the tool "result".
interface ExtProposal {
  proposed: true;
  server: string;
  serverId: string;
  tool: string;
  args: Record<string, unknown>;
  trusted: false;
}

function asExtProposal(result: unknown): ExtProposal | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (r.proposed !== true || typeof r.serverId !== 'string' || typeof r.tool !== 'string') return null;
  return {
    proposed: true,
    server: String(r.server ?? ''),
    serverId: r.serverId,
    tool: r.tool,
    args: (r.args && typeof r.args === 'object' ? (r.args as Record<string, unknown>) : {}),
    trusted: false,
  };
}

interface ExtRun {
  status: 'running' | 'done' | 'error';
  output?: string;
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
  const [settings, setSettings] = useState<AgentSettings>(loadAgentSettings);
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  // Per external-tool proposal run state, keyed by a stable id (message:result).
  const [extRuns, setExtRuns] = useState<Record<string, ExtRun>>({});

  const runRef = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef(profileId);
  profileRef.current = profileId;

  const updateSettings = (patch: Partial<AgentSettings>) => {
    setSettings(saveAgentSettings(patch));
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

  // Run an untrusted external MCP tool after the user confirms its proposal.
  const runExtProposal = async (id: string, p: ExtProposal) => {
    setExtRuns((prev) => ({ ...prev, [id]: { status: 'running' } }));
    try {
      const res = await window.electronAPI.mcpServersCall({ serverId: p.serverId, tool: p.tool, toolArgs: p.args });
      if (!res.success || res.data?.error) {
        setExtRuns((prev) => ({ ...prev, [id]: { status: 'error', output: res.data?.error || res.error || 'failed' } }));
        return;
      }
      const out = typeof res.data?.result === 'string' ? res.data.result : JSON.stringify(res.data?.result, null, 2);
      setExtRuns((prev) => ({ ...prev, [id]: { status: 'done', output: out } }));
    } catch (e) {
      setExtRuns((prev) => ({ ...prev, [id]: { status: 'error', output: e instanceof Error ? e.message : 'failed' } }));
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

  useEffect(() => {
    const onSettings = (event: Event) => {
      setSettings((event as CustomEvent<AgentSettings>).detail ?? loadAgentSettings());
    };
    window.addEventListener(AGENT_SETTINGS_EVENT, onSettings);
    return () => window.removeEventListener(AGENT_SETTINGS_EVENT, onSettings);
  }, []);

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
      // API key / OAuth token is resolved engine-side from the OS keychain.
      model: settings.model,
      dataExposure: settings.dataExposure,
      responseLanguage: settings.responseLanguage,
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
        {onTogglePopout && (
          <button className="icon-btn" title={popped ? 'Dock to side' : 'Open as full tab'} onClick={onTogglePopout}>
            {popped ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        )}
        <button className="icon-btn" title="Close" onClick={onClose}>
          <X size={15} />
        </button>
      </div>

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
              const ext = asExtProposal(r.result);
              if (ext) {
                const id = `${i}:${k}`;
                const run = extRuns[id];
                return (
                  <div className="agent-ext-proposal" key={`x${k}`}>
                    <div className="agent-ext-proposal-head">
                      <Wrench size={13} />
                      <span>
                        [외부:{ext.server}] {ext.tool}
                      </span>
                    </div>
                    <pre className="agent-ext-proposal-args">{JSON.stringify(ext.args)}</pre>
                    {!run && (
                      <div className="agent-ext-proposal-actions">
                        <button className="btn btn-primary btn-sm" onClick={() => void runExtProposal(id, ext)}>
                          <Play size={12} /> 실행
                        </button>
                      </div>
                    )}
                    {run?.status === 'running' && <div className="agent-ext-proposal-status">실행 중…</div>}
                    {run?.status === 'done' && (
                      <>
                        <div className="agent-ext-proposal-status ok">
                          <Check size={12} /> 완료
                        </div>
                        {run.output && <pre className="agent-ext-proposal-out">{run.output}</pre>}
                      </>
                    )}
                    {run?.status === 'error' && <div className="agent-ext-proposal-status err">{run.output}</div>}
                  </div>
                );
              }
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
            <div className="agent-text">
              {m.role === 'assistant' ? (
                m.text ? <AgentMarkdown text={m.text} /> : busy && i === messages.length - 1 ? '…' : ''
              ) : (
                m.text
              )}
            </div>
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
          {/* Provider/LLM is chosen in Settings; here you only pick the model. */}
          <select
            className="agent-pick"
            title="Model"
            value={settings.model}
            onChange={(e) => updateSettings({ model: e.target.value })}
          >
            {modelOptionsForProvider(settings.provider, settings.model).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
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
