import React, { useEffect, useState } from 'react';
import { Plug, Trash2, AlertTriangle } from 'lucide-react';
import { parseArgs, parseEnv, validateServer } from '../lib/mcpServerForm';
import type { McpServer } from '../global';

const WORKSPACE_ID = 'default';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; tools: string[] }
  | { kind: 'err'; message: string };

// Manages workspace-level external MCP servers that the agent can call.
// External servers run the given command locally, so adding one is gated on
// an explicit trust toggle and a visible warning.
export const McpServersPanel: React.FC = () => {
  const [servers, setServers] = useState<McpServer[]>([]);

  // add-form state
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [formError, setFormError] = useState('');
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    const res = await window.electronAPI.mcpServersList(WORKSPACE_ID);
    setServers(res.data ?? []);
  };

  useEffect(() => {
    void window.electronAPI.mcpServersList(WORKSPACE_ID).then((res) => {
      setServers(res.data ?? []);
    });
  }, []);

  // Toggling enabled/trusted re-saves the existing fields. Listing does not
  // return env (secrets), so a toggle sends env:{} — known v1 limitation; env
  // is only set when first adding the server (see note in the add form).
  const toggle = async (server: McpServer, patch: Partial<Pick<McpServer, 'enabled' | 'trusted'>>) => {
    await window.electronAPI.mcpServersSave({
      id: server.id,
      name: server.name,
      command: server.command,
      args: server.args,
      enabled: patch.enabled ?? server.enabled,
      trusted: patch.trusted ?? server.trusted,
      env: {},
    });
    await refresh();
  };

  const remove = async (id: string) => {
    await window.electronAPI.mcpServersDelete(id);
    await refresh();
  };

  const runTest = async () => {
    setTest({ kind: 'testing' });
    const res = await window.electronAPI.mcpServersTest({
      command,
      args: parseArgs(argsText),
      env: parseEnv(envText),
    });
    if (!res.success) {
      setTest({ kind: 'err', message: res.error || '연결 실패' });
      return;
    }
    const data = res.data;
    if (data?.error) {
      setTest({ kind: 'err', message: data.error });
      return;
    }
    setTest({ kind: 'ok', tools: (data?.tools ?? []).map((t) => t.name) });
  };

  const resetForm = () => {
    setName('');
    setCommand('');
    setArgsText('');
    setEnvText('');
    setTrusted(false);
    setFormError('');
    setTest({ kind: 'idle' });
  };

  const add = async () => {
    const err = validateServer({ name, command });
    if (err) {
      setFormError(err);
      return;
    }
    setFormError('');
    setSaving(true);
    try {
      await window.electronAPI.mcpServersSave({
        name,
        command,
        args: parseArgs(argsText),
        enabled: true,
        trusted,
        env: parseEnv(envText),
      });
      resetForm();
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mcp-srv-panel">
      <div className="mcp-srv-head">
        <Plug size={14} />
        <span>외부 MCP 서버 (에이전트 도구)</span>
      </div>

      <p className="mcp-srv-warn">
        <AlertTriangle size={13} />
        외부 MCP 서버는 지정한 명령을 로컬에서 실행합니다. 신뢰할 수 있는 서버만 추가하세요.
      </p>

      <div className="mcp-srv-list">
        {servers.length === 0 && <div className="mcp-srv-empty">등록된 외부 서버가 없습니다.</div>}
        {servers.map((s) => (
          <div className="mcp-srv-row" key={s.id}>
            <div className="mcp-srv-row-main">
              <div className="mcp-srv-row-name">
                <span className="mcp-srv-name">{s.name}</span>
                <span className="mcp-srv-badge">stdio</span>
              </div>
              <div className="mcp-srv-cmd">{[s.command, ...s.args].join(' ')}</div>
            </div>
            <div className="mcp-srv-row-actions">
              <label className="mcp-srv-toggle">
                <input type="checkbox" checked={s.enabled} onChange={() => void toggle(s, { enabled: !s.enabled })} />
                <span>활성</span>
              </label>
              <label className="mcp-srv-toggle">
                <input type="checkbox" checked={s.trusted} onChange={() => void toggle(s, { trusted: !s.trusted })} />
                <span>신뢰</span>
              </label>
              <button className="btn btn-secondary btn-sm" onClick={() => void remove(s.id)} aria-label="삭제">
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mcp-srv-form">
        <div className="mcp-srv-form-head">서버 추가</div>
        <label className="mcp-srv-field">
          <span>이름</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-tools" />
        </label>
        <label className="mcp-srv-field">
          <span>명령</span>
          <input type="text" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
        </label>
        <label className="mcp-srv-field">
          <span>인자</span>
          <input
            type="text"
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
          />
        </label>
        <label className="mcp-srv-field">
          <span>환경 변수</span>
          <textarea
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            rows={2}
            placeholder={'KEY=value\nTOKEN=...'}
          />
        </label>
        <p className="mcp-srv-note">환경 변수는 추가 시에만 설정됩니다.</p>
        <label className="mcp-srv-check">
          <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} />
          <span>신뢰함 (도구를 제안 없이 바로 실행)</span>
        </label>

        {formError && <div className="mcp-srv-error">{formError}</div>}

        <div className="mcp-srv-form-actions">
          <button className="btn btn-secondary btn-sm" onClick={() => void runTest()} disabled={!command.trim() || test.kind === 'testing'}>
            {test.kind === 'testing' ? '테스트 중…' : '연결 테스트'}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => void add()} disabled={saving}>
            추가
          </button>
        </div>

        {test.kind === 'ok' && (
          <div className="mcp-srv-test ok">
            도구 {test.tools.length}개{test.tools.length > 0 ? `: ${test.tools.join(', ')}` : ''}
          </div>
        )}
        {test.kind === 'err' && <div className="mcp-srv-test err">{test.message}</div>}
      </div>
    </div>
  );
};
