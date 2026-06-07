import { useMemo, useRef, useState, useEffect } from 'react';
import type { TemplateDef } from '../lib/templateTypes';
import type { Driver } from '../lib/ddlBuilder';
import { renderTemplate } from '../lib/templateRender';
import { buildSummary, formatSummary, type SummaryFormat } from '../lib/templateSummary';
import { toCsv } from '../lib/gridExport';
import { ResultGrid } from './ResultGrid';
import { ResultNarrator } from './ResultNarrator';

interface Props {
  template: TemplateDef;
  profileId: string;
  driver: string;
  tables: string[];
  columns: string[];
  roles: Record<string, string>;
  onOpenInEditor: (sql: string) => void;
  onClose: () => void;
}

export function TemplateRunner({ template, profileId, driver, tables, columns, roles, onOpenInEditor, onClose }: Props) {
  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(template.params.filter((p) => p.default).map((p) => [p.name, p.default as string])),
  );
  const [result, setResult] = useState<{ columns: string[]; rows: unknown[][] } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { offRef.current?.(); }, []);

  const validIdentifiers = useMemo(
    () => new Set([...tables, ...columns].map((s) => s.toLowerCase())),
    [tables, columns],
  );
  const rendered = useMemo(
    () => renderTemplate(template, { driver: driver as Driver, inputs, roles, validIdentifiers }),
    [template, inputs, roles, validIdentifiers, driver],
  );

  async function run() {
    if (rendered.missing.length > 0) return;
    setRunning(true);
    setError(null);
    setResult(null);
    const queryId = `tpl-${Date.now()}`;
    const cols: string[] = [];
    const rows: unknown[][] = [];
    const off = window.electronAPI.onQueryStreamChunk((qid, chunk) => {
      if (qid !== queryId) return;
      if (chunk.type === 'meta') cols.push(...(chunk.columns ?? []));
      else if (chunk.type === 'row') rows.push((chunk.data ?? []) as unknown[]);
      else if (chunk.type === 'policy') {
        setError(`실행이 차단되었습니다 (${chunk.code ?? 'policy'}): ${chunk.message ?? '안전 정책에 의해 차단됨. SQL 에디터에서 확인 후 실행하세요.'}`);
        setRunning(false);
        off();
      } else if (chunk.type === 'error') {
        setError(chunk.message ?? '쿼리 실행 오류');
        setRunning(false);
        off();
      } else if (chunk.type === 'done') {
        setResult({ columns: cols, rows });
        setRunning(false);
        off();
      }
    });
    offRef.current = off;
    const res = await window.electronAPI.executeQueryStream(queryId, profileId, rendered.sql);
    if (!res.success) {
      setError(res.error ?? '실행 실패');
      setRunning(false);
      off();
    }
  }

  function copySummary(fmt: SummaryFormat) {
    if (!result) return;
    const s = buildSummary(template.name, result.columns, result.rows);
    navigator.clipboard?.writeText(formatSummary(s, fmt));
  }

  function downloadCsv() {
    if (!result) return;
    const blob = new Blob([toCsv(result.columns, result.rows)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${template.id}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="template-runner">
      <header className="template-runner-head">
        <button className="btn btn-sm template-back" onClick={onClose}>← 목록</button>
        <h3>{template.name}</h3>
        <p className="template-desc">{template.description}</p>
      </header>
      <div className="template-params">
        {template.params.map((p) => (
          <div key={p.name} className="form-field">
            <label>{p.label}{p.required ? ' *' : ''}</label>
            {p.kind === 'identifier' ? (
              <select
                value={inputs[p.name] ?? ''}
                onChange={(e) => setInputs((s) => ({ ...s, [p.name]: e.target.value }))}
              >
                <option value="">(선택)</option>
                {(p.identifierKind === 'table' ? tables : columns).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            ) : p.kind === 'enum' ? (
              <select
                value={inputs[p.name] ?? ''}
                onChange={(e) => setInputs((s) => ({ ...s, [p.name]: e.target.value }))}
              >
                <option value="">(선택)</option>
                {(p.options ?? []).map((o) => (
                  <option key={o.label} value={o.value ?? o.label}>{o.label}</option>
                ))}
              </select>
            ) : (
              <input
                type={p.valueType === 'number' ? 'number' : p.valueType === 'date' ? 'date' : 'text'}
                value={inputs[p.name] ?? ''}
                onChange={(e) => setInputs((s) => ({ ...s, [p.name]: e.target.value }))}
              />
            )}
          </div>
        ))}
      </div>
      <details className="template-sql-preview">
        <summary>SQL 미리보기</summary>
        <pre className="risk-sql">{rendered.sql}</pre>
      </details>
      <div className="template-actions">
        <button
          className="btn btn-primary"
          disabled={rendered.missing.length > 0 || running}
          onClick={run}
        >
          {running ? '실행 중…' : '실행'}
        </button>
        <button
          className="btn"
          onClick={() => onOpenInEditor(rendered.sql)}
          disabled={rendered.missing.length > 0}
        >
          에디터에서 열기
        </button>
      </div>
      {error && <p className="risk-warn-text">{error}</p>}
      {result && (
        <>
          <div className="template-followups">
            <button className="btn btn-sm" onClick={downloadCsv}>CSV</button>
            <button className="btn btn-sm" onClick={() => copySummary('plain')}>요약 복사</button>
            <button className="btn btn-sm" onClick={() => copySummary('slack')}>Slack</button>
            <button className="btn btn-sm" onClick={() => copySummary('jira')}>Jira</button>
          </div>
          <ResultGrid columns={result.columns} rows={result.rows} />
          <details className="narrator-wrap">
            <summary>업무 문장 생성</summary>
            <ResultNarrator profileId={profileId} sql={rendered.sql} columns={result.columns} rows={result.rows} />
          </details>
        </>
      )}
    </div>
  );
}
