import React, { useEffect, useState } from 'react';
import { Copy, Check, Plug } from 'lucide-react';
import { buildJsonSnippet } from '../lib/mcpConfig';

interface Props {
  connId: string;
  connName: string;
  initialEnabled: boolean;
  initialExposure: string;
}

// Per-connection MCP panel: expose toggle, data-exposure level, and a copy-paste
// client config snippet. Auto-connect buttons are added in P3.
export const McpConnectPanel: React.FC<Props> = ({ connId, connName, initialEnabled, initialExposure }) => {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [exposure, setExposure] = useState(initialExposure || 'metadata');
  const [enginePath, setEnginePath] = useState('');
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.electronAPI.mcpEnginePath().then(setEnginePath);
  }, []);

  const save = async (nextEnabled: boolean, nextExposure: string) => {
    setSaving(true);
    await window.electronAPI.mcpSetSettings(connId, nextEnabled, nextExposure);
    setSaving(false);
  };

  const onToggle = () => {
    const next = !enabled;
    setEnabled(next);
    void save(next, exposure);
  };
  const onExposure = (v: string) => {
    setExposure(v);
    void save(enabled, v);
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
          <p className="mcp-note">
            노출하면 로컬 AI 클라이언트가 선택한 노출 수준으로 이 DB를 읽을 수 있습니다. 쓰기 실행 도구는 노출되지 않습니다.
          </p>
        </>
      )}
    </div>
  );
};
