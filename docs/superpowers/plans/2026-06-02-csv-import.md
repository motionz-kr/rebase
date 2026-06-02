# CSV 가져오기 (CSV Import) Implementation Plan

**Goal:** 테이블 우클릭 → "CSV 가져오기…"로 CSV 파일을 기존 테이블에 적재한다(타입 변환·자동 매핑·트랜잭션).

**Architecture:** 순수 `csvParse`(RFC4180)·`buildMultiInsert`·`csvImport`(자동 매핑 + 다중행 INSERT 빌드) — 전부 TDD. `CsvImportDialog`가 렌더러 file input으로 파일을 읽어 미리보기·매핑 후 `runBatch`(트랜잭션)로 적재. 백엔드 변경 없음.

**Tech Stack:** React/TS, vitest, lucide-react.

> 브랜치 `feat/csv-import`. node/pnpm nvm. 값은 컬럼 타입으로 변환(cellTypes), 빈 셀→NULL. 다중행 INSERT를 청크(기본 500)로 묶어 트랜잭션 실행.

---

## Task F2-1: csvParse (TDD)

**Files:** Create `apps/renderer/src/lib/csvParse.ts` (+ `.test.ts`)

- [ ] **Step 1: Test** `csvParse.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseCsv } from './csvParse';

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b\n1,2\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });
  it('handles quoted fields with commas, quotes, and newlines', () => {
    expect(parseCsv('x\n"a,b"\n"he said ""hi"""\n"line\nbreak"')).toEqual([
      ['x'], ['a,b'], ['he said "hi"'], ['line\nbreak'],
    ]);
  });
  it('handles CRLF and a trailing newline without an extra empty row', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('keeps empty fields', () => {
    expect(parseCsv('a,b,c\n1,,3')).toEqual([['a', 'b', 'c'], ['1', '', '3']]);
  });
  it('returns [] for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });
});
```
- [ ] **Step 2: Run → FAIL** (`cd apps/renderer && npx vitest run src/lib/csvParse.test.ts`).
- [ ] **Step 3: Implement** `csvParse.ts`:
```ts
// Parse RFC4180-style CSV into rows of string fields. Handles quoted fields
// (embedded commas, "" escapes, newlines), CRLF, and a trailing newline.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `git add apps/renderer/src/lib/csvParse.* && git commit -m "feat(csv): add RFC4180 csvParse"`.

---

## Task F2-2: dmlBuilder.buildMultiInsert (TDD)

**Files:** Modify `apps/renderer/src/lib/dmlBuilder.ts`, `apps/renderer/src/lib/dmlBuilder.test.ts`

- [ ] **Step 1: Append tests:**
```ts
import { buildMultiInsert } from './dmlBuilder';

describe('buildMultiInsert', () => {
  it('builds a multi-row INSERT (mysql)', () => {
    expect(
      buildMultiInsert('mysql', 'users', ['id', 'name'], [[1, 'Al'], [2, null]])
    ).toBe("INSERT INTO `users` (`id`, `name`) VALUES (1, 'Al'), (2, NULL)");
  });
  it('builds a single-row INSERT (postgres)', () => {
    expect(buildMultiInsert('postgres', 't', ['a'], [['x']])).toBe(`INSERT INTO "t" ("a") VALUES ('x')`);
  });
});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Append impl** to `dmlBuilder.ts`:
```ts
// Build a single multi-row INSERT. Column names are plain strings; values are
// CellValue tuples rendered via sqlLiteral (number/boolean unquoted, null → NULL).
export function buildMultiInsert(driver: Driver, table: string, cols: string[], rows: CellValue[][]): string {
  const names = cols.map((c) => quoteIdent(driver, c)).join(', ');
  const tuples = rows.map((r) => '(' + r.map((v) => sqlLiteral(driver, v)).join(', ') + ')').join(', ');
  return `INSERT INTO ${quoteIdent(driver, table)} (${names}) VALUES ${tuples}`;
}
```
- [ ] **Step 4: Run → PASS** (`npx vitest run src/lib/dmlBuilder.test.ts`).
- [ ] **Step 5: Commit** `git add apps/renderer/src/lib/dmlBuilder.* && git commit -m "feat(dml): add buildMultiInsert"`.

---

## Task F2-3: csvImport (autoMapColumns + buildImportStatements) (TDD)

**Files:** Create `apps/renderer/src/lib/csvImport.ts` (+ `.test.ts`)

- [ ] **Step 1: Test** `csvImport.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { autoMapColumns, buildImportStatements } from './csvImport';

describe('autoMapColumns', () => {
  it('matches table columns to CSV header indices case-insensitively', () => {
    expect(autoMapColumns(['id', 'name', 'extra'], ['Name', 'ID'])).toEqual({ id: 1, name: 0 });
  });
});

describe('buildImportStatements', () => {
  const spec = { table: 't', mapping: { id: 0, name: 1 }, colTypes: { id: 'int', name: 'varchar(50)' } };
  it('builds a typed multi-row insert; empty cell → NULL', () => {
    expect(buildImportStatements('mysql', spec, [['1', 'Al'], ['2', '']])).toEqual([
      "INSERT INTO `t` (`id`, `name`) VALUES (1, 'Al'), (2, NULL)",
    ]);
  });
  it('chunks rows by chunkSize', () => {
    const s = { ...spec, chunkSize: 1 };
    expect(buildImportStatements('mysql', s, [['1', 'a'], ['2', 'b']])).toEqual([
      "INSERT INTO `t` (`id`, `name`) VALUES (1, 'a')",
      "INSERT INTO `t` (`id`, `name`) VALUES (2, 'b')",
    ]);
  });
  it('returns [] when no mapping or no rows', () => {
    expect(buildImportStatements('mysql', { table: 't', mapping: {}, colTypes: {} }, [['1']])).toEqual([]);
    expect(buildImportStatements('mysql', spec, [])).toEqual([]);
  });
});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `csvImport.ts`:
```ts
import type { Driver } from './ddlBuilder';
import type { CellValue } from './dmlBuilder';
import { buildMultiInsert } from './dmlBuilder';
import { classifyColumnType, coerceCellValue } from './cellTypes';

// Auto-map table columns to CSV header indices by case-insensitive name match.
export function autoMapColumns(tableColumns: string[], csvHeader: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  const lower = csvHeader.map((h) => h.trim().toLowerCase());
  for (const col of tableColumns) {
    const idx = lower.indexOf(col.trim().toLowerCase());
    if (idx >= 0) map[col] = idx;
  }
  return map;
}

export interface ImportSpec {
  table: string;
  mapping: Record<string, number>; // tableColumn -> csv column index
  colTypes: Record<string, string>; // tableColumn -> SQL type (for coercion)
  chunkSize?: number;
}

// Build chunked multi-row INSERT statements from CSV data rows. Empty cell → NULL;
// values coerced by the target column's type. Intended to run in one transaction.
export function buildImportStatements(driver: Driver, spec: ImportSpec, dataRows: string[][]): string[] {
  const cols = Object.keys(spec.mapping);
  if (cols.length === 0 || dataRows.length === 0) return [];
  const chunk = spec.chunkSize && spec.chunkSize > 0 ? spec.chunkSize : 500;
  const toVal = (col: string, raw: string | undefined): CellValue => {
    if (raw === undefined || raw === '') return null;
    return coerceCellValue(classifyColumnType(spec.colTypes[col] ?? ''), raw);
  };
  const stmts: string[] = [];
  for (let i = 0; i < dataRows.length; i += chunk) {
    const slice = dataRows.slice(i, i + chunk);
    const tuples: CellValue[][] = slice.map((r) => cols.map((col) => toVal(col, r[spec.mapping[col]])));
    stmts.push(buildMultiInsert(driver, spec.table, cols, tuples));
  }
  return stmts;
}
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `git add apps/renderer/src/lib/csvImport.* && git commit -m "feat(csv): autoMapColumns + buildImportStatements"`.

---

## Task F2-4: CsvImportDialog 컴포넌트

**Files:** Create `apps/renderer/src/components/CsvImportDialog.tsx`

- [ ] **Step 1: Implement** (then `npx tsc --noEmit`):
```tsx
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
      } catch (e: any) {
        if (!ignore) setError(e?.message || 'Failed to describe table');
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
```
- [ ] **Step 2: Typecheck** (`npx tsc --noEmit`) → clean.
- [ ] **Step 3: Commit** `git add apps/renderer/src/components/CsvImportDialog.tsx && git commit -m "feat(csv): CsvImportDialog (file → mapping → transactional import)"`.

---

## Task F2-5: SchemaExplorer 메뉴 배선 + CSS

**Files:** Modify `apps/renderer/src/components/SchemaExplorer.tsx`, `apps/renderer/src/App.css`

- [ ] **Step 1: SchemaExplorer** — add import `import { CsvImportDialog } from './CsvImportDialog';` and `Upload` to the lucide import. Add state `const [csvImport, setCsvImport] = useState<{ db: string; table: string } | null>(null);` (next to `edit`/`tableAction`). Add a menu item in the table context menu (after "테이블 비우기…", before the danger "테이블 삭제…" or after Show DDL — place after the "컬럼 추가…"/before separator group, e.g. right after "Show DDL" group):
```tsx
          <button className="ctx-item" onClick={() => { setCsvImport({ db: menu.db, table: menu.table }); setMenu(null); }}>
            <Upload size={13} /> CSV 가져오기…
          </button>
```
Mount the dialog next to the other dialog mounts:
```tsx
      {csvImport && (
        <CsvImportDialog
          key={`${csvImport.db}.${csvImport.table}`}
          profileId={profileId}
          driver={driver as 'mysql' | 'postgres'}
          database={csvImport.db}
          table={csvImport.table}
          onClose={() => setCsvImport(null)}
          onImported={() => refreshAfterDdl(csvImport.db)}
        />
      )}
```
- [ ] **Step 2: App.css** — append:
```css
/* CSV import dialog */
.csv-file { display: flex; align-items: center; gap: 8px; }
.csv-file input[type="file"] { font-size: 12px; color: var(--text-2); }
.csv-map { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; max-height: 180px; overflow-y: auto; }
.csv-map-head { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 11px; color: var(--text-3); }
.csv-map-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: center; }
.csv-map-row .input { height: 26px; font-size: 12px; }
.csv-preview { max-height: 180px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius); }
.csv-preview table { border-collapse: collapse; font-size: 11px; width: 100%; }
.csv-preview th, .csv-preview td { border: 1px solid var(--border); padding: 3px 6px; text-align: left; white-space: nowrap; }
.csv-preview th { background: var(--bg-panel-2); position: sticky; top: 0; }
```
> 변수 확인 후 없으면 대체(보고).
- [ ] **Step 3: tsc + build** → clean. **Commit** `git add apps/renderer/src/components/SchemaExplorer.tsx apps/renderer/src/App.css && git commit -m "feat(csv): wire CSV import into table menu + styles"`.

---

## Task F2-6: 전체 테스트 + CDP 라이브 검증

- [ ] **Step 1:** `cd apps/renderer && npx vitest run` (csvParse/dmlBuilder/csvImport 포함 green) + `npx tsc --noEmit` + `npm run build`.
- [ ] **Step 2: CDP 검증** — 렌더러 HMR 반영. dev-mysql에 임시 테이블 생성 후 CSV 적재. **검증 후 임시 테이블 DROP.**
  1. 임시 테이블 준비: `docker exec dev-mysql mysql -uroot -ppassword1! -e "DROP TABLE IF EXISTS devdb.csv_t; CREATE TABLE devdb.csv_t (id INT, name VARCHAR(50), score INT);"`.
  2. 임시 CSV 파일 작성: `/tmp/imp.csv` 내용 `id,name,score\n1,Alice,90\n2,Bob,\n3,Carol,75`.
  3. CDP: devdb 트리에서 `csv_t` 우클릭 → "CSV 가져오기…" → 다이얼로그.
  4. CDP `DOM.setFileInputFiles`로 `/tmp/imp.csv`를 file input에 설정 → change 발생 → 헤더·미리보기·자동매핑(id→id, name→name, score→score) 확인.
  5. "가져오기" 클릭 → 성공 메시지("3 행") 확인.
  6. DB 확인: `SELECT * FROM devdb.csv_t` → 3행(id 1/2/3, Bob score=NULL[빈 셀], score 숫자 unquoted).
  7. **정리**: `DROP TABLE devdb.csv_t`, `/tmp/imp.csv`·`/tmp/*.mjs` 삭제.

---

## Self-Review (완료)
- 커버리지: 파싱(F2-1), 다중행 INSERT(F2-2), 매핑+문장 빌드(F2-3), 다이얼로그(F2-4), 메뉴 배선+CSS(F2-5), 라이브(F2-6). 타입 변환·빈셀 NULL·트랜잭션(runBatch) 반영. 백엔드 무변경.
- 플레이스홀더 없음. 타입 일관(`parseCsv`/`buildMultiInsert`/`autoMapColumns`/`buildImportStatements`/`ImportSpec`/`runBatch`).
