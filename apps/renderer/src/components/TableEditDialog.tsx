import React, { useEffect, useMemo, useState } from 'react';
import { X, Plus, Trash2, AlertTriangle } from 'lucide-react';
import type { ColumnInfo } from '../global';
import { buildTableChanges, type ColumnSpec, type Driver, type TableChangeSet } from '../lib/ddlBuilder';
import { runDdl } from '../lib/runDdl';

interface Props {
  profileId: string;
  driver: Driver;
  database: string;
  table: string;
  focusNewColumn?: boolean; // open with a fresh column row focused ("컬럼 추가" menu)
  onClose: () => void;
  onApplied: () => void; // success → caller refreshes schema
}

// Editable row model. `original` is the column name as it exists in the DB
// (undefined for newly-added rows); `removed` marks an existing column for DROP.
interface Row {
  key: string;
  original?: string;
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string;
  removed: boolean;
}

let rowSeq = 0;
const newRow = (): Row => ({ key: `r${rowSeq++}`, name: '', type: '', nullable: true, defaultValue: '', removed: false });

export const TableEditDialog: React.FC<Props> = ({
  profileId,
  driver,
  database,
  table,
  focusNewColumn,
  onClose,
  onApplied,
}) => {
  const [rows, setRows] = useState<Row[]>([]);
  // Baseline column specs (by original DB name) captured at load, for diffing.
  const [baseline, setBaseline] = useState<Map<string, ColumnSpec>>(new Map());
  const [tableName, setTableName] = useState(table);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    // Reset the table-name field whenever the target table changes, so a reused
    // instance can never carry a stale name (which would emit a spurious RENAME).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTableName(table);
    (async () => {
      setLoading(true);
      try {
        const res = await window.electronAPI.describeTable(profileId, database, table);
        if (ignore) return;
        const cols: ColumnInfo[] = res.success && res.data ? res.data.columns : [];
        const loaded: Row[] = cols.map((c) => ({
          key: `r${rowSeq++}`,
          original: c.name,
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          defaultValue: '',
          removed: false,
        }));
        const base = new Map<string, ColumnSpec>();
        // describeTable does not return column defaults, so the baseline default
        // is left undefined; a default change is detected only when the user
        // types one. Acceptable for v1.
        for (const c of cols) base.set(c.name, { name: c.name, type: c.type, nullable: c.nullable });
        setBaseline(base);
        setRows(focusNewColumn ? [...loaded, newRow()] : loaded);
      } catch (e) {
        if (!ignore) setError(e instanceof Error ? e.message : 'Failed to load columns');
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [profileId, database, table, focusNewColumn]);

  const patch = (key: string, p: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const toSpec = (r: Row): ColumnSpec => ({
    name: r.name.trim(),
    type: r.type.trim(),
    nullable: r.nullable,
    defaultValue: r.defaultValue.trim() || undefined,
  });

  // Diff the editable rows against the loaded baseline into ordered statements.
  const statements = useMemo(() => {
    const addColumns: ColumnSpec[] = [];
    const dropColumns: string[] = [];
    const renameColumns: { from: string; to: string }[] = [];
    const modifyColumns: { before: ColumnSpec; after: ColumnSpec }[] = [];

    for (const r of rows) {
      if (!r.original) {
        // Newly-added row.
        if (!r.removed && r.name.trim() && r.type.trim()) addColumns.push(toSpec(r));
        continue;
      }
      if (r.removed) {
        dropColumns.push(r.original);
        continue;
      }
      // Rename (name changed vs. its DB name).
      if (r.name.trim() && r.name.trim() !== r.original) {
        renameColumns.push({ from: r.original, to: r.name.trim() });
      }
      // Type / nullability / default change — modify keeps the ORIGINAL name.
      const before = baseline.get(r.original);
      if (before) {
        const after: ColumnSpec = {
          name: r.original,
          type: r.type.trim(),
          nullable: r.nullable,
          defaultValue: r.defaultValue.trim() || undefined,
        };
        const changed =
          before.type.trim() !== after.type.trim() ||
          before.nullable !== after.nullable ||
          (before.defaultValue ?? '') !== (after.defaultValue ?? '');
        if (changed) modifyColumns.push({ before, after });
      }
    }

    const cs: TableChangeSet = {
      renameTo: tableName.trim() !== table ? tableName.trim() : undefined,
      addColumns,
      dropColumns,
      renameColumns,
      modifyColumns,
    };
    return buildTableChanges(driver, table, cs);
  }, [rows, tableName, baseline, driver, table]);

  const preview = statements.join(';\n') + (statements.length ? ';' : '');
  const canRun = statements.length > 0 && !running && !loading;

  const apply = async () => {
    setRunning(true);
    setError(null);
    const res = await runDdl(profileId, statements);
    setRunning(false);
    if (res.ok) {
      onApplied();
      onClose();
    } else {
      setError(`실패: ${res.error}\n문장: ${res.failedStatement ?? ''}`);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>테이블 수정 · <span className="mono">{table}</span></h3>
          <button className="icon-btn" onClick={onClose} title="Close"><X size={15} /></button>
        </div>

        {loading ? (
          <div className="load-center"><span className="spinner" /> 컬럼 로딩…</div>
        ) : (
          <>
            <label className="form-row">
              <span className="form-label">테이블 이름</span>
              <input className="input" value={tableName} onChange={(e) => setTableName(e.target.value)} />
            </label>

            <div className="ddl-cols">
              <div className="ddl-col-head">
                <span>이름</span><span>타입</span><span>NULL</span><span>기본값</span><span />
              </div>
              {rows.map((r) => (
                <div key={r.key} className={`ddl-col-row ${r.removed ? 'removed' : ''}`}>
                  <input className="input" value={r.name} placeholder="column" autoFocus={!r.original}
                    disabled={r.removed} onChange={(e) => patch(r.key, { name: e.target.value })} />
                  <input className="input" value={r.type} placeholder="INT / text…"
                    disabled={r.removed} onChange={(e) => patch(r.key, { type: e.target.value })} />
                  <input type="checkbox" checked={r.nullable} disabled={r.removed}
                    onChange={(e) => patch(r.key, { nullable: e.target.checked })} />
                  <input className="input" value={r.defaultValue} placeholder="(none)"
                    disabled={r.removed} onChange={(e) => patch(r.key, { defaultValue: e.target.value })} />
                  {r.original ? (
                    <button className="icon-btn" title={r.removed ? '되돌리기' : '삭제'}
                      onClick={() => patch(r.key, { removed: !r.removed })}>
                      <Trash2 size={14} />
                    </button>
                  ) : (
                    <button className="icon-btn" title="행 제거"
                      onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}>
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
              <button className="btn btn-secondary btn-xs" onClick={() => setRows((prev) => [...prev, newRow()])}>
                <Plus size={12} /> 컬럼 추가
              </button>
            </div>

            <div className="ddl-preview">
              <div className="ddl-preview-head">생성될 SQL</div>
              <pre className="ddl-block">{preview || '— 변경 사항 없음 —'}</pre>
            </div>

            {error && (
              <div className="alert error"><AlertTriangle size={14} /><span style={{ whiteSpace: 'pre-wrap' }}>{error}</span></div>
            )}

            <div className="modal-foot">
              <button className="btn btn-secondary" onClick={onClose}>취소</button>
              <button className="btn btn-primary" onClick={apply} disabled={!canRun}>
                {running ? <span className="spinner" /> : null} 실행
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
