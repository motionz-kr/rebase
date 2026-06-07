import { useEffect, useMemo, useRef, useState } from 'react';
import {
  NARRATION_PURPOSES, buildNarrationPrompt, deterministicNarration, type NarrationPurpose,
} from '../lib/resultNarration';
import { loadAgentSettings, isOAuthProvider } from '../lib/agentSettings';

const ROW_CAP = 50;

interface Props {
  profileId: string;
  sql: string;
  columns: string[];
  rows: unknown[][];
}

export function ResultNarrator({ profileId, sql, columns, rows }: Props) {
  const [purpose, setPurpose] = useState<NarrationPurpose>('jira');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  const offRef = useRef<(() => void) | null>(null);
  useEffect(() => () => offRef.current?.(), []);

  const settings = useMemo(() => loadAgentSettings(), []);
  // Privacy gate: sending result rows to the LLM contradicts the default
  // dataExposure='metadata'. Require explicit per-use consent unless the user
  // already chose 'unrestricted'. The deterministic fallback never sends data.
  const [consent, setConsent] = useState(false);
  const needsConsent = aiReady && settings.dataExposure !== 'unrestricted';

  useEffect(() => {
    let alive = true;
    (async () => {
      const p = settings.provider;
      // agentKeyStatus returns ResultWrapper<{ present: boolean }>
      // agentOAuthStatus returns ResultWrapper<{ loggedIn: boolean; expiresAt?: number }>
      // Both are accessed via res.data?.present / res.data?.loggedIn respectively.
      const res = isOAuthProvider(p)
        ? await window.electronAPI.agentOAuthStatus(p === 'openai-oauth' ? 'openai' : 'anthropic')
        : await window.electronAPI.agentKeyStatus(p);
      if (!alive) return;
      const data = res?.data as Record<string, unknown> | undefined;
      const ok = !!(res?.success && (data?.['present'] || data?.['loggedIn']));
      setAiReady(ok);
    })();
    return () => { alive = false; };
  }, [settings.provider]);

  const input = useMemo(
    () => ({ sql, columns, rows: rows.slice(0, ROW_CAP), rowCount: rows.length }),
    [sql, columns, rows],
  );

  function generate() {
    if (!aiReady) {
      setOutput(deterministicNarration(purpose, input));
      return;
    }
    if (needsConsent && !consent) return; // privacy gate
    setRunning(true);
    setOutput('');
    const runId = `narr-${Date.now()}`;
    const off = window.electronAPI.onAgentStreamChunk((id, chunk) => {
      if (id !== runId) return;
      if (chunk.kind === 'text') setOutput((o) => o + (chunk.text ?? ''));
      else if (chunk.kind === 'error') { setOutput((o) => o + `\n[오류] ${chunk.err ?? ''}`); setRunning(false); off(); }
      else if (chunk.kind === 'done') { setRunning(false); off(); }
    });
    offRef.current = off;
    const { system, user } = buildNarrationPrompt(purpose, input);
    window.electronAPI
      .generateNarration(runId, profileId, system, [{ role: 'user', text: user }], { provider: settings.provider, model: settings.model })
      .then((res) => { if (!res.success) { setOutput(`[오류] ${res.error ?? '생성 실패'}`); setRunning(false); off(); } });
  }

  const copy = () => navigator.clipboard?.writeText(output);
  const copyPlain = () => navigator.clipboard?.writeText(output.replace(/[#*_`>-]/g, '').replace(/\n{2,}/g, '\n').trim());

  return (
    <div className="narrator">
      <div className="narrator-head">
        <div className="narrator-purposes">
          {NARRATION_PURPOSES.map((p) => (
            <button key={p.id} className={`btn btn-sm ${purpose === p.id ? 'btn-primary' : ''}`} onClick={() => setPurpose(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <button
          className="btn btn-sm btn-primary"
          disabled={running || rows.length === 0 || (needsConsent && !consent)}
          onClick={generate}
        >
          {running ? '생성 중…' : '문장 생성'}
        </button>
      </div>
      {!aiReady && <p className="narrator-hint">AI 미설정 — 기본 요약을 생성합니다. (어시스턴트에서 AI를 설정하면 더 풍부한 문장)</p>}
      {needsConsent && (
        <label className="narrator-consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          결과 데이터(상위 {ROW_CAP}행)를 AI에 전송하여 문장을 생성하는 데 동의합니다.
        </label>
      )}
      {aiReady && !needsConsent && <p className="narrator-hint">결과 데이터가 AI에 전송됩니다 (상위 {ROW_CAP}행).</p>}
      {output && (
        <>
          <pre className="narrator-output">{output}</pre>
          <div className="narrator-actions">
            <button className="btn btn-sm" onClick={copy}>Markdown 복사</button>
            <button className="btn btn-sm" onClick={copyPlain}>Plain 복사</button>
          </div>
        </>
      )}
    </div>
  );
}
