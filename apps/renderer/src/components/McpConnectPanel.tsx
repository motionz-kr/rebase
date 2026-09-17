import React, { useEffect, useState } from 'react';
import { Copy, Check, Plug, RefreshCw } from 'lucide-react';
import { buildJsonSnippet } from '../lib/mcpConfig';
import { parseScopeList, scopeFromProfile, scopeText, type McpAccessScope } from '../lib/mcpScope';
import type { McpActivityEvent } from '../global';

const activityLabel: Record<string, string> = {
  session_started: 'handshake 시작',
  session_ended: '세션 종료',
  tool_call: '도구 호출',
  test: '연결 테스트',
  connect: '외부 서버 연결',
};

interface Props {
  connId: string;
  connName: string;
  initialEnabled: boolean;
  initialExposure: string;
  initialAllowedDatabases?: string;
  initialAllowedSchemas?: string;
  initialAllowedTables?: string;
  onSaved?: (settings: { enabled: boolean; exposure: string; scope: McpAccessScope }) => void;
}

// Per-connection MCP panel: expose toggle, data-exposure level, and a copy-paste
// client config snippet. Auto-connect buttons are added in P3.
export const McpConnectPanel: React.FC<Props> = ({
  connId,
  connName,
  initialEnabled,
  initialExposure,
  initialAllowedDatabases,
  initialAllowedSchemas,
  initialAllowedTables,
  onSaved,
}) => {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [exposure, setExposure] = useState(initialExposure || 'metadata');
  const [enginePath, setEnginePath] = useState('');
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clients, setClients] = useState<Array<{ id: string; label: string; present: boolean }>>([]);
  const [connectMsg, setConnectMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [scope, setScope] = useState<McpAccessScope>(() =>
    scopeFromProfile(initialAllowedDatabases, initialAllowedSchemas, initialAllowedTables),
  );
  const [scopeSaving, setScopeSaving] = useState(false);
  const [scopeMsg, setScopeMsg] = useState<string | null>(null);
  const [activity, setActivity] = useState<McpActivityEvent[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);

  const refreshActivity = async () => {
    setActivityLoading(true);
    const res = await window.electronAPI.mcpActivityList({ profileId: connId, limit: 30 });
    setActivity(res.data ?? []);
    setActivityLoading(false);
  };

  useEffect(() => {
    void window.electronAPI.mcpEnginePath().then(setEnginePath);
    void window.electronAPI.mcpDetectClients().then(setClients);
    let active = true;
    void window.electronAPI.mcpActivityList({ profileId: connId, limit: 30 }).then((res) => {
      if (!active) return;
      setActivity(res.data ?? []);
      setActivityLoading(false);
    });
    return () => {
      active = false;
    };
  }, [connId]);

  const autoconnect = async (clientId: string, label: string) => {
    setConnectMsg(null);
    const res = await window.electronAPI.mcpAutoconnect(clientId, connId);
    if (res.success) {
      setConnectMsg({ kind: 'ok', text: `${label} 연결 설정을 저장했습니다${res.data?.backup ? ' (기존 설정 백업함)' : ''}. 클라이언트를 재시작하세요.` });
    } else {
      setConnectMsg({ kind: 'err', text: res.error || '연결 실패' });
    }
  };

  const save = async (nextEnabled: boolean, nextExposure: string, nextScope = scope) => {
    setSaving(true);
    const res = await window.electronAPI.mcpSetSettings(connId, nextEnabled, nextExposure, nextScope);
    setSaving(false);
    if (res.success) onSaved?.({ enabled: nextEnabled, exposure: nextExposure, scope: nextScope });
    else setConnectMsg({ kind: 'err', text: res.error || 'MCP 설정 저장 실패' });
  };

  const onToggle = () => {
    const next = !enabled;
    setEnabled(next);
    void save(next, exposure);
  };
  const onExposure = (v: string) => {
    setExposure(v);
    void save(enabled, v, scope);
  };

  const changeScope = (key: keyof McpAccessScope, value: string) => {
    setScope((current) => ({ ...current, [key]: parseScopeList(value) }));
    setScopeMsg(null);
  };

  const saveScope = async () => {
    setScopeSaving(true);
    const res = await window.electronAPI.mcpSetSettings(connId, enabled, exposure, scope);
    setScopeSaving(false);
    setScopeMsg(res.success ? '접근 범위를 저장했습니다.' : res.error || '접근 범위 저장 실패');
    if (res.success) {
      onSaved?.({ enabled, exposure, scope });
      void refreshActivity();
    }
  };

  const snippet = enginePath ? buildJsonSnippet(enginePath, connId) : '';
  const copy = async () => {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mcp-panel">
      <div className="mcp-panel-head">
        <Plug size={14} />
        <span>AI 클라이언트 연결 (MCP){connName ? ` · ${connName}` : ''}</span>
      </div>
      <label className="mcp-toggle">
        <input type="checkbox" checked={enabled} onChange={onToggle} disabled={saving} />
        <span>이 연결을 외부 AI 클라이언트에 노출</span>
      </label>

      {enabled && (
        <>
          <label className="mcp-field">
            <span>데이터 노출</span>
            <select value={exposure} onChange={(e) => onExposure(e.target.value)}>
              <option value="metadata">메타데이터만 (행 값 미전송)</option>
              <option value="on_request">요청 시</option>
              <option value="unrestricted">전체 (행 값 전송)</option>
            </select>
          </label>

          <div className="mcp-snippet-head">
            <span>클라이언트 설정 (Claude Desktop / Cursor)</span>
            <button className="btn btn-secondary btn-xs" onClick={copy} disabled={!snippet}>
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? '복사됨' : '복사'}
            </button>
          </div>
          <pre className="mcp-snippet">{snippet || '엔진 경로 로딩 중…'}</pre>

          <div className="mcp-snippet-head">
            <span>또는 자동 연결</span>
          </div>
          <div className="mcp-clients">
            {clients.map((c) => (
              <button
                key={c.id}
                className="btn btn-secondary btn-sm"
                disabled={!c.present || !snippet}
                title={c.present ? '' : '설치 감지 안 됨'}
                onClick={() => void autoconnect(c.id, c.label)}
              >
                {c.label}
                {!c.present ? ' (미감지)' : ''}
              </button>
            ))}
          </div>
          {connectMsg && (
            <p className={`mcp-note ${connectMsg.kind === 'err' ? 'err' : 'ok'}`}>{connectMsg.text}</p>
          )}

          <p className="mcp-note">
            노출하면 로컬 AI 클라이언트가 선택한 노출 수준으로 이 DB를 읽을 수 있습니다. 쓰기 실행 도구는 노출되지 않습니다.
          </p>

          <div className="mcp-scope">
            <div className="mcp-snippet-head">
              <span>접근 허용 범위</span>
              <button className="btn btn-secondary btn-xs" onClick={() => void saveScope()} disabled={scopeSaving}>
                {scopeSaving ? '저장 중…' : '범위 저장'}
              </button>
            </div>
            <p className="mcp-note">한 줄에 하나씩 입력합니다. 비워두면 해당 항목은 제한하지 않습니다. 이 설정은 스키마 탐색기의 숨김 설정과 별개로 엔진에서 강제됩니다.</p>
            <label className="mcp-field">
              <span>허용 데이터베이스</span>
              <textarea
                rows={2}
                value={scopeText(scope.allowedDatabases)}
                onChange={(e) => changeScope('allowedDatabases', e.target.value)}
                placeholder={connName ? '현재 연결의 database 이름' : 'app_db'}
              />
            </label>
            <label className="mcp-field">
              <span>허용 스키마</span>
              <textarea
                rows={2}
                value={scopeText(scope.allowedSchemas)}
                onChange={(e) => changeScope('allowedSchemas', e.target.value)}
                placeholder="public\ndbo"
              />
            </label>
            <label className="mcp-field">
              <span>허용 테이블</span>
              <textarea
                rows={3}
                value={scopeText(scope.allowedTables)}
                onChange={(e) => changeScope('allowedTables', e.target.value)}
                placeholder="users\npublic.orders"
              />
            </label>
            {scopeMsg && <p className={`mcp-note ${scopeMsg.includes('실패') ? 'err' : 'ok'}`}>{scopeMsg}</p>}
          </div>
        </>
      )}

      <div className="mcp-activity">
        <div className="mcp-snippet-head">
          <span>최근 MCP 활동</span>
          <button className="btn btn-secondary btn-xs" onClick={() => void refreshActivity()} disabled={activityLoading}>
            <RefreshCw size={12} /> {activityLoading ? '새로 고침 중…' : '새로 고침'}
          </button>
        </div>
        {activity.length === 0 ? (
          <p className="mcp-note">아직 기록된 handshake 또는 도구 호출이 없습니다.</p>
        ) : (
              <div className="mcp-activity-list">
                {activity.slice(0, 8).map((event) => (
                  <div className="mcp-activity-row" data-event={event.event} data-tool={event.tool || undefined} key={event.id}>
                <span className={`mcp-activity-status ${event.status}`}>{event.status === 'success' ? '성공' : '실패'}</span>
                <span>{activityLabel[event.event] ?? event.event}{event.tool ? ` · ${event.tool}` : ''}</span>
                <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
                {event.error && <span className="mcp-activity-error">{event.error}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
