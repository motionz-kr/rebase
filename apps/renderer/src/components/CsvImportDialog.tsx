import React, { useEffect, useMemo, useState } from 'react';
import { X, Upload, AlertTriangle } from 'lucide-react';
import type { ColumnInfo } from '../global';
import type { Driver } from '../lib/ddlBuilder';
import { parseCsv } from '../lib/csvParse';
import { autoMapColumns, buildImportStatements } from '../lib/csvImport';
import { runBatch } from '../lib/runBatch';

interface Props {
  profileId: string;
  driver: Driver;
  database: string;
  table: string;
  onClose: () => void;
  onImported: () => void;
}

const ROW_CAP = 100000;
const SKIP = -1;

export const CsvImportDialog: React.FC<Props> = ({ profileId, driver, database, table, onClose, onImported }) => {
  const [cols, setCols] = useState<ColumnInfo[]>([]);
  const [fileName, setFileName] = useState('');
  const [header, setHeader] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await window.electronAPI.describeTable(profileId, database, table);
        if (!ignore && res.success && res.data) setCols(res.data.columns);
      } catch (e) {
        if (!ignore) setError(e instanceof Error ? e.message : 'Failed to describe table');
      }
    })();
    return () => { ignore = true; };
  }, [profileId, database, table]);

  const onFile = async (file: File) => {
    setError(null);
    setDone(null);
    setFileName(file.name);
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length === 0) { setHeader([]); setDataRows([]); return; }
    const head = rows[0];
    const body = rows.slice(1);
    setHeader(head);
    setDataRows(body);
    setMapping(autoMapColumns(cols.map((c) => c.name), head));
  };

  const colTypes = useMemo(() => Object.fromEntries(cols.map((c) => [c.name, c.type])), [cols]);
  const mapped = useMemo(() => Object.fromEntries(Object.entries(mapping).filter(([, i]) => i >= 0)), [mapping]);
  const tooMany = dataRows.length > ROW_CAP;
  const canImport = Object.keys(mapped).length > 0 && dataRows.length > 0 && !tooMany && !importing;

  const doImport = async () => {
    setImporting(true);
    setError(null);
    const stmts = buildImportStatements(driver, { table, mapping: mapped, colTypes }, dataRows);
    const res = await runBatch(profileId, stmts);
    setImporting(false);
    if (res.ok) {
      setDone(dataRows.length);
      onImported();
    } else {
      setError(`가져오기 실패: ${res.error}`);
    }
  };

  const preview = dataRows.slice(0, 8);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>CSV 가져오기 · <span className="mono">{table}</span></h3>
          <button className="icon-btn" onClick={onClose} title="Close"><X size={15} /></button>
        </div>

        <label className="form-row">
          <span className="form-label">CSV 파일 (첫 행 = 헤더)</span>
          <span className="csv-file">
            <Upload size={13} />
            <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            <span className="mono">{fileName || '선택…'}</span>
          </span>
        </label>

        {header.length > 0 && (
          <>
            <div className="csv-map">
              <div className="csv-map-head"><span>테이블 컬럼</span><span>← CSV 열</span></div>
              {cols.map((c) => (
                <div key={c.name} className="csv-map-row">
                  <span className="mono">{c.name} <span className="muted">{c.type}</span></span>
                  <select
                    className="input"
                    value={mapping[c.name] ?? SKIP}
                    onChange={(e) => setMapping((m) => ({ ...m, [c.name]: Number(e.target.value) }))}
                  >
                    <option value={SKIP}>(건너뜀)</option>
                    {header.map((h, i) => <option key={i} value={i}>{h || `열 ${i + 1}`}</option>)}
                  </select>
                </div>
              ))}
            </div>

            <div className="ddl-preview">
              <div className="ddl-preview-head">미리보기 ({dataRows.length.toLocaleString()} 행)</div>
              <div className="csv-preview">
                <table>
                  <thead><tr>{header.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
                  <tbody>{preview.map((r, ri) => <tr key={ri}>{header.map((_, ci) => <td key={ci}>{r[ci] ?? ''}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </div>
            {tooMany && <div className="alert error"><AlertTriangle size={14} /><span>행이 너무 많습니다(상한 {ROW_CAP.toLocaleString()}). 더 작은 파일로 나눠 가져오세요.</span></div>}
          </>
        )}

        {error && <div className="alert error"><AlertTriangle size={14} /><span style={{ whiteSpace: 'pre-wrap' }}>{error}</span></div>}
        {done !== null && <div className="alert" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}>{done.toLocaleString()} 행 가져오기 완료.</div>}

        <div className="modal-foot">
          <button className="btn btn-secondary" onClick={onClose}>{done !== null ? '닫기' : '취소'}</button>
          <button className="btn btn-primary" disabled={!canImport} onClick={doImport}>
            {importing ? <span className="spinner" /> : null} 가져오기
          </button>
        </div>
      </div>
    </div>
  );
};
