# 편집 값 타입 & NULL 처리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 인라인 편집에서 컬럼 타입에 맞는 SQL 리터럴(숫자/불리언 unquoted)을 생성하고, 셀 에디터의 'NULL' 버튼으로 명시적 NULL을, 빈 입력으로 빈 문자열을 구분한다.

**Architecture:** 순수 `cellTypes.ts`(컬럼 타입 분류 + 값 변환, TDD)를 만들고, `TableDataView`가 컬럼 타입을 보존해 편집 커밋·새 행 INSERT 시 값을 알맞은 타입으로 변환한다. 셀 에디터에 NULL 버튼 추가. `dmlBuilder.sqlLiteral`은 이미 타입 분기를 가지므로 변경 없음. 백엔드 변경 없음.

**Tech Stack:** React 19 + TypeScript, vitest, lucide-react(미사용 — 텍스트 기호 사용).

> git 저장소(main). **시작 전 `git checkout -b feat/edit-value-typing`**. bash 앞에 `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`. 테스트/빌드는 `apps/renderer`. 렌더러는 vite HMR(5173)이라 실행 중인 앱에 자동 반영 — 엔진/앱 재시작 불필요.

---

## File Structure

- **신규** `apps/renderer/src/lib/cellTypes.ts` (+ `.test.ts`) — `classifyColumnType`, `coerceCellValue`.
- **수정** `apps/renderer/src/components/TableDataView.tsx` — `colTypes` 보존, `commitEdit` coerce, `commitNull`, NULL 버튼, insert coerce.
- **수정** `apps/renderer/src/App.css` — NULL 버튼 스타일.
- 변경 없음: `lib/dmlBuilder.ts`, `lib/runBatch.ts`, 엔진.

---

## Task EV-1: cellTypes — classifyColumnType + coerceCellValue (TDD)

**Files:**
- Create: `apps/renderer/src/lib/cellTypes.ts`
- Test: `apps/renderer/src/lib/cellTypes.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/renderer/src/lib/cellTypes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyColumnType, coerceCellValue } from './cellTypes';

describe('classifyColumnType', () => {
  it('classifies number types (case-insensitive, with params)', () => {
    for (const t of ['int', 'INT', 'integer', 'bigint', 'smallint', 'tinyint', 'decimal(10,2)', 'numeric', 'float', 'double', 'double precision', 'real', 'serial', 'bigserial']) {
      expect(classifyColumnType(t)).toBe('number');
    }
  });
  it('classifies boolean types', () => {
    expect(classifyColumnType('bool')).toBe('boolean');
    expect(classifyColumnType('boolean')).toBe('boolean');
  });
  it('classifies everything else as string', () => {
    for (const t of ['varchar(80)', 'char(2)', 'text', 'date', 'datetime', 'timestamp without time zone', 'time', 'json', 'jsonb', 'uuid', 'bytea']) {
      expect(classifyColumnType(t)).toBe('string');
    }
  });
});

describe('coerceCellValue', () => {
  it('coerces valid numbers, passes invalid/empty through as string', () => {
    expect(coerceCellValue('number', '5')).toBe(5);
    expect(coerceCellValue('number', ' 3.14 ')).toBe(3.14);
    expect(coerceCellValue('number', '-2')).toBe(-2);
    expect(coerceCellValue('number', 'abc')).toBe('abc');
    expect(coerceCellValue('number', '')).toBe('');
  });
  it('coerces boolean variants', () => {
    expect(coerceCellValue('boolean', 'true')).toBe(true);
    expect(coerceCellValue('boolean', '1')).toBe(true);
    expect(coerceCellValue('boolean', 'T')).toBe(true);
    expect(coerceCellValue('boolean', 'false')).toBe(false);
    expect(coerceCellValue('boolean', '0')).toBe(false);
    expect(coerceCellValue('boolean', 'maybe')).toBe('maybe');
  });
  it('passes strings through (including empty)', () => {
    expect(coerceCellValue('string', 'hi')).toBe('hi');
    expect(coerceCellValue('string', '')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/renderer && npx vitest run src/lib/cellTypes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`apps/renderer/src/lib/cellTypes.ts`:

```ts
import type { CellValue } from './dmlBuilder';

export type CellCategory = 'number' | 'boolean' | 'string';

const NUMBER_TYPES = new Set([
  'int', 'integer', 'smallint', 'mediumint', 'bigint', 'tinyint',
  'decimal', 'numeric', 'dec', 'fixed', 'float', 'double', 'real',
  'serial', 'bigserial', 'smallserial',
]);
const BOOLEAN_TYPES = new Set(['bool', 'boolean']);

// Map a SQL column type to a value category. Strips size/precision params and
// normalizes case. Dates/JSON/text/etc fall through to 'string' (quoted in SQL).
export function classifyColumnType(sqlType: string): CellCategory {
  const base = sqlType.toLowerCase().split('(')[0].trim();
  const head = base.split(/\s+/)[0]; // e.g. "double precision" -> "double"
  if (NUMBER_TYPES.has(head)) return 'number';
  if (BOOLEAN_TYPES.has(head)) return 'boolean';
  return 'string';
}

// Coerce the user's edited text into a typed CellValue for the column category.
// NULL is set separately (via the editor's NULL button), not here.
export function coerceCellValue(category: CellCategory, text: string): CellValue {
  if (category === 'number') {
    const t = text.trim();
    if (t !== '' && Number.isFinite(Number(t))) return Number(t);
    return text;
  }
  if (category === 'boolean') {
    const t = text.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 't' || t === 'yes') return true;
    if (t === 'false' || t === '0' || t === 'f' || t === 'no') return false;
    return text;
  }
  return text;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/renderer && npx vitest run src/lib/cellTypes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/smlee/projects/product/database
git add apps/renderer/src/lib/cellTypes.ts apps/renderer/src/lib/cellTypes.test.ts
git commit -m "feat(grid): add cellTypes (classifyColumnType + coerceCellValue)"
```

---

## Task EV-2: TableDataView — 타입 보존 + coerce + NULL 버튼

**Files:**
- Modify: `apps/renderer/src/components/TableDataView.tsx`

READ the file first. Apply these exact edits.

- [ ] **Step 1: Add the import** (alongside the other `../lib/...` imports near the top):

```tsx
import { classifyColumnType, coerceCellValue } from '../lib/cellTypes';
```

- [ ] **Step 2: Add `colTypes` state** — change:
```tsx
  const [columns, setColumns] = useState<string[]>([]);
  const [pkCols, setPkCols] = useState<string[]>([]);
```
to:
```tsx
  const [columns, setColumns] = useState<string[]>([]);
  const [colTypes, setColTypes] = useState<string[]>([]);
  const [pkCols, setPkCols] = useState<string[]>([]);
```

- [ ] **Step 3: Populate `colTypes` from describeTable** — change:
```tsx
        setColumns(cols.map((c) => c.name));
        setPkCols(cols.filter((c) => c.primaryKey).map((c) => c.name));
```
to:
```tsx
        setColumns(cols.map((c) => c.name));
        setColTypes(cols.map((c) => c.type));
        setPkCols(cols.filter((c) => c.primaryKey).map((c) => c.name));
```

- [ ] **Step 4: Type-aware commit + commitNull** — change:
```tsx
  const commitEdit = () => {
    if (!editing) return;
    const { r, c } = editing;
    const value: CellValue = editText === '' ? null : editText;
    setEdits((prev) => ({ ...prev, [r]: { ...(prev[r] ?? {}), [c]: value } }));
    setEditing(null);
  };
```
to:
```tsx
  const commitEdit = () => {
    if (!editing) return;
    const { r, c } = editing;
    // Coerce the typed text to the column's value category (number/boolean →
    // unquoted literal). Empty text is an empty string, NOT null — use the NULL
    // button to set null explicitly.
    const value: CellValue = coerceCellValue(classifyColumnType(colTypes[c] ?? ''), editText);
    setEdits((prev) => ({ ...prev, [r]: { ...(prev[r] ?? {}), [c]: value } }));
    setEditing(null);
  };
  const commitNull = () => {
    if (!editing) return;
    const { r, c } = editing;
    setEdits((prev) => ({ ...prev, [r]: { ...(prev[r] ?? {}), [c]: null } }));
    setEditing(null);
  };
```

- [ ] **Step 5: Coerce new-row INSERT values by type** — change:
```tsx
    for (const nr of newRows) {
      const cols = Object.keys(nr)
        .filter((cStr) => nr[Number(cStr)] !== '')
        .map((cStr) => ({ col: columns[Number(cStr)], value: nr[Number(cStr)] as CellValue }));
      if (cols.length === 0) continue;
      stmts.push(buildInsert(driver, table, cols));
    }
```
to:
```tsx
    for (const nr of newRows) {
      const cols = Object.keys(nr)
        .filter((cStr) => nr[Number(cStr)] !== '')
        .map((cStr) => {
          const c = Number(cStr);
          return { col: columns[c], value: coerceCellValue(classifyColumnType(colTypes[c] ?? ''), nr[c]) };
        });
      if (cols.length === 0) continue;
      stmts.push(buildInsert(driver, table, cols));
    }
```

- [ ] **Step 6: Add the NULL button to the cell editor** — change the editing-cell render block:
```tsx
                          <div key={c} className="grid-cell editing">
                            <input
                              className="input tdv-edit-input"
                              autoFocus
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitEdit();
                                else if (e.key === 'Escape') setEditing(null);
                              }}
                              onBlur={commitEdit}
                            />
                          </div>
```
to:
```tsx
                          <div key={c} className="grid-cell editing">
                            <input
                              className="input tdv-edit-input"
                              autoFocus
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitEdit();
                                else if (e.key === 'Escape') setEditing(null);
                              }}
                              onBlur={commitEdit}
                            />
                            <button
                              className="tdv-null-btn"
                              title="NULL로 설정"
                              onMouseDown={(e) => {
                                e.preventDefault(); // keep input focus so onBlur->commitEdit doesn't fire first
                                commitNull();
                              }}
                            >
                              ∅
                            </button>
                          </div>
```

- [ ] **Step 7: Typecheck + build + tests**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
cd /Users/smlee/projects/product/database/apps/renderer
npx tsc --noEmit 2>&1 | grep -iE 'error TS' | head || echo "tsc clean"
npx vitest run 2>&1 | tail -3
npm run build 2>&1 | grep -iE 'built in|error' | tail -1
```
Expected: tsc clean (note: `CellValue` is still imported/used in the file — leave its import), tests pass, build success.

- [ ] **Step 8: Commit**

```bash
cd /Users/smlee/projects/product/database
git add apps/renderer/src/components/TableDataView.tsx
git commit -m "feat(grid): type-aware edit values + explicit NULL button"
```

---

## Task EV-3: NULL 버튼 CSS

**Files:**
- Modify: `apps/renderer/src/App.css`

- [ ] **Step 1: Append** to `App.css`:

```css
/* Cell editor NULL button */
.grid-cell.editing {
  display: flex;
  align-items: stretch;
}
.grid-cell.editing .tdv-edit-input {
  flex: 1;
  min-width: 0;
}
.tdv-null-btn {
  flex-shrink: 0;
  width: 24px;
  border: none;
  border-left: 1px solid var(--border);
  background: var(--bg-panel-2);
  color: var(--text-3);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
}
.tdv-null-btn:hover {
  color: var(--accent);
  background: var(--bg-hover);
}
```
> 변수(`--border`, `--bg-panel-2`, `--text-3`, `--accent`, `--bg-hover`)가 App.css에 있는지 grep으로 확인하고 없으면 가까운 토큰으로 대체(보고). (앞 단계에서 `.grid-cell.editing { padding: 0; }`가 이미 있다 — 이 새 규칙이 뒤에 와서 display:flex를 더한다. padding:0은 유지됨.)

- [ ] **Step 2: Build**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && cd /Users/smlee/projects/product/database/apps/renderer && npm run build 2>&1 | grep -iE 'built in|error' | tail -1`
Expected: build success.

- [ ] **Step 3: Commit**

```bash
cd /Users/smlee/projects/product/database
git add apps/renderer/src/App.css
git commit -m "style(grid): cell-editor NULL button"
```

---

## Task EV-4: 전체 테스트 + CDP 라이브 검증

**Files:** (없음 — 검증 전용)

- [ ] **Step 1: Unit tests + build**

```bash
cd /Users/smlee/projects/product/database/apps/renderer
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run 2>&1 | tail -3        # cellTypes 포함 전체 green
npx tsc --noEmit 2>&1 | grep -iE 'error TS' | head || echo "tsc clean"
npm run build
```

- [ ] **Step 2: CDP 실제 검증** (`--remote-debugging-port=9222`, 렌더러는 HMR로 자동 반영). dev-mysql `demo_users`(id int PK, name varchar NOT NULL, email varchar nullable, active tinyint nullable). **검증 후 원복.**

먼저 원본 캡처: `docker exec dev-mysql mysql -uroot -ppassword1! -e "SELECT * FROM devdb.demo_users ORDER BY id;"`.

1. `demo_users` 더블클릭 → 데이터 뷰.
2. **숫자 unquoted**: `active` 셀(현재 1) 더블클릭 → '0' 입력 → Enter → 저장 → **미리보기에 `SET \`active\` = 0`(따옴표 없음)** 확인 → 실행 → DB `active=0` 확인. → 원복(active=1).
3. **명시적 NULL**: `email` 셀 더블클릭 → **∅ 버튼** 클릭 → 셀이 NULL 표시 → 저장 → 미리보기 **`SET \`email\` = NULL`** → 실행 → DB email NULL 확인. → 원복(원래 값).
4. **빈 문자열**: `email` 셀 더블클릭 → 내용 모두 지우고 Enter(빈 입력) → 저장 → 미리보기 **`SET \`email\` = ''`**(NULL 아님) → 실행 → DB email = '' 확인. → 원복.
5. **숫자 INSERT**: 행 추가 → name='NumTest', active='1' → 저장 → 미리보기 INSERT의 active가 **`1`(unquoted)** 확인 → 실행 → 추가 확인 → DELETE로 원복.
6. **DB 원복** 최종 확인 + `/tmp/*.mjs` 정리.

- [ ] **Step 3: 사용자 DB 원상복구 최종 확인**

```bash
docker exec dev-mysql mysql -uroot -ppassword1! -e "SELECT * FROM devdb.demo_users ORDER BY id;" 2>/dev/null
# 원래 3행/값으로 복구되어야 한다.
```

---

## Self-Review (작성자 체크리스트 — 완료)

- **스펙 커버리지:** 타입 분류/변환(EV-1), 타입 보존+commit coerce+insert coerce(EV-2), NULL 버튼+빈문자열(EV-2,3), CDP 검증(EV-4). `sqlLiteral`/`dmlBuilder` 무변경(이미 분기 보유). 엔진 무변경. 모두 매핑.
- **플레이스홀더:** 없음.
- **타입 일관성:** `classifyColumnType`/`coerceCellValue`/`CellCategory`/`CellValue`, `colTypes`/`commitNull` 시그니처가 태스크 간 일치. NULL 버튼은 `onMouseDown`+`preventDefault`로 input blur(commitEdit)보다 먼저 commitNull 실행되도록 보장.
