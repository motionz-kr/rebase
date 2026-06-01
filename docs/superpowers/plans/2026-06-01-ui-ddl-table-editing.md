# UI 기반 테이블/컬럼 편집 (DataGrip 스타일 DDL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스키마 트리에서 테이블을 우클릭해 컬럼 추가/삭제/수정/이름변경과 테이블 삭제/이름변경/비우기를, 생성 SQL 미리보기 후 실행하는 UI를 추가한다.

**Architecture:** 프론트엔드 전용. 순수 DDL 생성기(`ddlBuilder.ts`, 방언 인식, `string[]` 반환)를 TDD로 만들고, 다이얼로그가 폼 상태로 SQL을 생성해 미리보기 후 `runDdl` 헬퍼로 기존 `executeQueryStream`(allowWrite+confirmDestructive)을 통해 문장을 순차 실행한다. 백엔드(Go) 변경 없음.

**Tech Stack:** React 19 + TypeScript, vitest, monaco(미사용), lucide-react 아이콘, 기존 Electron preload `window.electronAPI`.

> **참고(중요):** 이 작업 디렉터리는 git 저장소가 아니다(`git rev-parse` 실패). 각 Task의 "Commit" 스텝은 **git이 초기화된 경우에만** 실행하고, 아니면 건너뛴다. 검증은 커밋 대신 `npx vitest run`과 CDP 실제 실행으로 한다.

**도구 경로:** node/pnpm은 nvm — 셸에서 먼저 `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`. 테스트/타입체크는 `apps/renderer`에서 실행.

---

## File Structure

- **신규** `apps/renderer/src/lib/ddlBuilder.ts` — 순수 DDL 생성기. 방언별 식별자 인용 + 각 작업의 `string[]` 생성.
- **신규** `apps/renderer/src/lib/ddlBuilder.test.ts` — 위 모듈의 vitest.
- **신규** `apps/renderer/src/lib/runDdl.ts` — 문장 배열을 `executeQueryStream`으로 순차 실행하는 헬퍼.
- **신규** `apps/renderer/src/components/TableEditDialog.tsx` — "테이블 수정/컬럼 추가" 큰 폼 + 실시간 SQL 미리보기 + 실행.
- **신규** `apps/renderer/src/components/TableActionDialog.tsx` — 이름변경/비우기/삭제 작은 다이얼로그(파괴적 작업은 이름 타이핑 확인).
- **수정** `apps/renderer/src/components/SchemaExplorer.tsx` — 컨텍스트 메뉴 항목 추가 + 다이얼로그 마운트 + 성공 후 트리 새로고침 + `onSchemaChanged` prop.
- **수정** `apps/renderer/src/App.tsx` — `SchemaExplorer`에 `onSchemaChanged` 전달, `schemaVersion` 카운터를 `QueryEditor`에 전달.
- **수정** `apps/renderer/src/components/QueryEditor.tsx` — 자동완성 스키마 재조회용 `schemaVersion` prop을 effect deps에 추가.
- **수정** `apps/renderer/src/App.css` — 다이얼로그/폼 스타일.

타입 참고(기존):
- `ColumnInfo` (`apps/renderer/src/global`): `{ name: string; type: string; nullable: boolean; primaryKey: boolean }`.
- `executeQueryStream(queryId, profileId, query, { allowWrite?, confirmDestructive?, maxRows?, fetchAll? })`.
- 스트림 청크: `{type:'meta',columns}` | `{type:'row',data}` | `{type:'policy',code,message,verb}` | `{type:'done',rowsAffected,truncated,rowLimit}` | `{type:'error',message}`.

---

## Task 1: ddlBuilder — 식별자 인용 + 컬럼 추가/삭제/이름변경

**Files:**
- Create: `apps/renderer/src/lib/ddlBuilder.ts`
- Test: `apps/renderer/src/lib/ddlBuilder.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/renderer/src/lib/ddlBuilder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  quoteIdent,
  buildAddColumn,
  buildDropColumn,
  buildRenameColumn,
} from './ddlBuilder';

describe('quoteIdent', () => {
  it('quotes mysql identifiers with backticks', () => {
    expect(quoteIdent('mysql', 'users')).toBe('`users`');
  });
  it('quotes postgres identifiers with double quotes', () => {
    expect(quoteIdent('postgres', 'users')).toBe('"users"');
  });
  it('escapes a backtick in a mysql identifier', () => {
    expect(quoteIdent('mysql', 'we`ird')).toBe('`we``ird`');
  });
  it('escapes a double quote in a postgres identifier', () => {
    expect(quoteIdent('postgres', 'we"ird')).toBe('"we""ird"');
  });
});

describe('buildAddColumn', () => {
  it('adds a nullable column (mysql)', () => {
    expect(buildAddColumn('mysql', 'users', { name: 'age', type: 'INT', nullable: true })).toEqual([
      'ALTER TABLE `users` ADD COLUMN `age` INT',
    ]);
  });
  it('adds a NOT NULL column with default (postgres)', () => {
    expect(
      buildAddColumn('postgres', 'users', { name: 'status', type: 'text', nullable: false, defaultValue: "'active'" })
    ).toEqual(["ALTER TABLE \"users\" ADD COLUMN \"status\" text NOT NULL DEFAULT 'active'"]);
  });
});

describe('buildDropColumn', () => {
  it('drops a column (mysql)', () => {
    expect(buildDropColumn('mysql', 'users', 'age')).toEqual(['ALTER TABLE `users` DROP COLUMN `age`']);
  });
});

describe('buildRenameColumn', () => {
  it('renames a column (postgres)', () => {
    expect(buildRenameColumn('postgres', 'users', 'age', 'years')).toEqual([
      'ALTER TABLE "users" RENAME COLUMN "age" TO "years"',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/renderer && npx vitest run src/lib/ddlBuilder.test.ts`
Expected: FAIL — `Failed to resolve import "./ddlBuilder"` / functions not defined.

- [ ] **Step 3: Write minimal implementation**

`apps/renderer/src/lib/ddlBuilder.ts`:

```ts
// Pure, dialect-aware DDL generator. No DOM/Electron dependency so it can be
// unit-tested directly. Every builder returns a list of statements (string[])
// because some changes (e.g. Postgres column modify) need multiple statements,
// and the engine's policy gate blocks ";"-joined multi-statements — so callers
// execute each statement separately.

export type Driver = 'mysql' | 'postgres';

export interface ColumnSpec {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string; // raw SQL value as typed (e.g. "'active'", "0"); empty = no default
}

// Quote an identifier for the driver, escaping the closing quote char.
export function quoteIdent(driver: Driver, name: string): string {
  if (driver === 'postgres') return '"' + name.replace(/"/g, '""') + '"';
  return '`' + name.replace(/`/g, '``') + '`';
}

function columnClause(col: ColumnSpec): string {
  let s = col.type.trim();
  if (!col.nullable) s += ' NOT NULL';
  if (col.defaultValue && col.defaultValue.trim() !== '') s += ' DEFAULT ' + col.defaultValue.trim();
  return s;
}

export function buildAddColumn(driver: Driver, table: string, col: ColumnSpec): string[] {
  const t = quoteIdent(driver, table);
  const c = quoteIdent(driver, col.name);
  return [`ALTER TABLE ${t} ADD COLUMN ${c} ${columnClause(col)}`];
}

export function buildDropColumn(driver: Driver, table: string, columnName: string): string[] {
  return [`ALTER TABLE ${quoteIdent(driver, table)} DROP COLUMN ${quoteIdent(driver, columnName)}`];
}

export function buildRenameColumn(driver: Driver, table: string, oldName: string, newName: string): string[] {
  const t = quoteIdent(driver, table);
  return [`ALTER TABLE ${t} RENAME COLUMN ${quoteIdent(driver, oldName)} TO ${quoteIdent(driver, newName)}`];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/renderer && npx vitest run src/lib/ddlBuilder.test.ts`
Expected: PASS (all Task 1 tests green).

- [ ] **Step 5: Commit** (git이 초기화된 경우에만)

```bash
git add apps/renderer/src/lib/ddlBuilder.ts apps/renderer/src/lib/ddlBuilder.test.ts
git commit -m "feat(ddl): add identifier quoting + add/drop/rename column builders"
```

---

## Task 2: ddlBuilder — 컬럼 수정 (mysql 단일문장 / postgres 다중문장)

**Files:**
- Modify: `apps/renderer/src/lib/ddlBuilder.ts`
- Test: `apps/renderer/src/lib/ddlBuilder.test.ts`

- [ ] **Step 1: Write the failing test** (테스트 파일에 아래 describe 추가)

```ts
import { buildModifyColumn } from './ddlBuilder';

describe('buildModifyColumn', () => {
  const before = { name: 'age', type: 'INT', nullable: true } as const;

  it('mysql restates the full definition in one MODIFY statement', () => {
    expect(
      buildModifyColumn('mysql', 'users', before, { name: 'age', type: 'BIGINT', nullable: false })
    ).toEqual(['ALTER TABLE `users` MODIFY COLUMN `age` BIGINT NOT NULL']);
  });

  it('mysql returns [] when nothing changed', () => {
    expect(buildModifyColumn('mysql', 'users', before, { ...before })).toEqual([]);
  });

  it('postgres emits one statement per changed attribute', () => {
    expect(
      buildModifyColumn('postgres', 'users', before, {
        name: 'age',
        type: 'bigint',
        nullable: false,
        defaultValue: '0',
      })
    ).toEqual([
      'ALTER TABLE "users" ALTER COLUMN "age" TYPE bigint',
      'ALTER TABLE "users" ALTER COLUMN "age" SET NOT NULL',
      'ALTER TABLE "users" ALTER COLUMN "age" SET DEFAULT 0',
    ]);
  });

  it('postgres uses DROP NOT NULL / DROP DEFAULT when clearing', () => {
    expect(
      buildModifyColumn(
        'postgres',
        'users',
        { name: 'age', type: 'int', nullable: false, defaultValue: '0' },
        { name: 'age', type: 'int', nullable: true }
      )
    ).toEqual([
      'ALTER TABLE "users" ALTER COLUMN "age" DROP NOT NULL',
      'ALTER TABLE "users" ALTER COLUMN "age" DROP DEFAULT',
    ]);
  });

  it('postgres returns [] when nothing changed', () => {
    expect(buildModifyColumn('postgres', 'users', before, { ...before })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/renderer && npx vitest run src/lib/ddlBuilder.test.ts`
Expected: FAIL — `buildModifyColumn` is not exported.

- [ ] **Step 3: Write minimal implementation** (append to `ddlBuilder.ts`)

```ts
function sameDefault(a?: string, b?: string): boolean {
  return (a ?? '').trim() === (b ?? '').trim();
}

// Modify a column's type/nullability/default. `before` and `after` share the
// same column name (renames go through buildRenameColumn). Returns [] if there
// is no effective change.
export function buildModifyColumn(driver: Driver, table: string, before: ColumnSpec, after: ColumnSpec): string[] {
  const t = quoteIdent(driver, table);
  const c = quoteIdent(driver, before.name);

  const typeChanged = before.type.trim() !== after.type.trim();
  const nullChanged = before.nullable !== after.nullable;
  const defChanged = !sameDefault(before.defaultValue, after.defaultValue);
  if (!typeChanged && !nullChanged && !defChanged) return [];

  if (driver === 'mysql') {
    // MySQL MODIFY must restate the whole definition.
    return [`ALTER TABLE ${t} MODIFY COLUMN ${c} ${columnClause(after)}`];
  }

  // Postgres: one statement per changed attribute.
  const out: string[] = [];
  if (typeChanged) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${after.type.trim()}`);
  if (nullChanged) {
    out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} ${after.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`);
  }
  if (defChanged) {
    const hasDef = after.defaultValue && after.defaultValue.trim() !== '';
    out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} ${hasDef ? 'SET DEFAULT ' + after.defaultValue!.trim() : 'DROP DEFAULT'}`);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/renderer && npx vitest run src/lib/ddlBuilder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (git 초기화 시)

```bash
git add apps/renderer/src/lib/ddlBuilder.ts apps/renderer/src/lib/ddlBuilder.test.ts
git commit -m "feat(ddl): add column-modify builder (mysql single / postgres multi)"
```

---

## Task 3: ddlBuilder — 테이블 삭제/이름변경/비우기

**Files:**
- Modify: `apps/renderer/src/lib/ddlBuilder.ts`
- Test: `apps/renderer/src/lib/ddlBuilder.test.ts`

- [ ] **Step 1: Write the failing test** (추가)

```ts
import { buildDropTable, buildRenameTable, buildTruncateTable } from './ddlBuilder';

describe('table-level builders', () => {
  it('drops a table (mysql)', () => {
    expect(buildDropTable('mysql', 'users')).toEqual(['DROP TABLE `users`']);
  });
  it('renames a table (postgres)', () => {
    expect(buildRenameTable('postgres', 'users', 'members')).toEqual([
      'ALTER TABLE "users" RENAME TO "members"',
    ]);
  });
  it('renames a table (mysql) using ALTER ... RENAME TO', () => {
    expect(buildRenameTable('mysql', 'users', 'members')).toEqual([
      'ALTER TABLE `users` RENAME TO `members`',
    ]);
  });
  it('truncates a table (postgres)', () => {
    expect(buildTruncateTable('postgres', 'users')).toEqual(['TRUNCATE TABLE "users"']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/renderer && npx vitest run src/lib/ddlBuilder.test.ts`
Expected: FAIL — three builders not exported.

- [ ] **Step 3: Write minimal implementation** (append)

```ts
export function buildDropTable(driver: Driver, table: string): string[] {
  return [`DROP TABLE ${quoteIdent(driver, table)}`];
}

// ALTER ... RENAME TO works on both MySQL 8 and PostgreSQL.
export function buildRenameTable(driver: Driver, table: string, newName: string): string[] {
  return [`ALTER TABLE ${quoteIdent(driver, table)} RENAME TO ${quoteIdent(driver, newName)}`];
}

export function buildTruncateTable(driver: Driver, table: string): string[] {
  return [`TRUNCATE TABLE ${quoteIdent(driver, table)}`];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/renderer && npx vitest run src/lib/ddlBuilder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (git 초기화 시)

```bash
git add apps/renderer/src/lib/ddlBuilder.ts apps/renderer/src/lib/ddlBuilder.test.ts
git commit -m "feat(ddl): add drop/rename/truncate table builders"
```

---

## Task 4: ddlBuilder — buildTableChanges (폼 변경 묶음 → 문장 목록)

**Files:**
- Modify: `apps/renderer/src/lib/ddlBuilder.ts`
- Test: `apps/renderer/src/lib/ddlBuilder.test.ts`

- [ ] **Step 1: Write the failing test** (추가)

```ts
import { buildTableChanges, type TableChangeSet } from './ddlBuilder';

describe('buildTableChanges', () => {
  const empty: TableChangeSet = {
    addColumns: [],
    dropColumns: [],
    renameColumns: [],
    modifyColumns: [],
  };

  it('returns [] when there are no changes', () => {
    expect(buildTableChanges('mysql', 'users', empty)).toEqual([]);
  });

  it('orders ops: drop, modify, rename-col, add, rename-table last', () => {
    const changes: TableChangeSet = {
      renameTo: 'members',
      dropColumns: ['old'],
      modifyColumns: [
        { before: { name: 'age', type: 'INT', nullable: true }, after: { name: 'age', type: 'BIGINT', nullable: true } },
      ],
      renameColumns: [{ from: 'nm', to: 'name' }],
      addColumns: [{ name: 'email', type: 'VARCHAR(255)', nullable: false }],
    };
    expect(buildTableChanges('mysql', 'users', changes)).toEqual([
      'ALTER TABLE `users` DROP COLUMN `old`',
      'ALTER TABLE `users` MODIFY COLUMN `age` BIGINT',
      'ALTER TABLE `users` RENAME COLUMN `nm` TO `name`',
      'ALTER TABLE `users` ADD COLUMN `email` VARCHAR(255) NOT NULL',
      'ALTER TABLE `users` RENAME TO `members`',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/renderer && npx vitest run src/lib/ddlBuilder.test.ts`
Expected: FAIL — `buildTableChanges` / `TableChangeSet` not exported.

- [ ] **Step 3: Write minimal implementation** (append)

```ts
export interface TableChangeSet {
  renameTo?: string; // new table name if changed
  addColumns: ColumnSpec[];
  dropColumns: string[]; // column names
  renameColumns: { from: string; to: string }[];
  modifyColumns: { before: ColumnSpec; after: ColumnSpec }[]; // same-name type/null/default changes
}

// Flatten a form's change set into ordered statements. Column ops run against
// the ORIGINAL table name; the table rename (if any) runs last so every prior
// statement still references the existing table.
export function buildTableChanges(driver: Driver, table: string, changes: TableChangeSet): string[] {
  const out: string[] = [];
  for (const name of changes.dropColumns) out.push(...buildDropColumn(driver, table, name));
  for (const m of changes.modifyColumns) out.push(...buildModifyColumn(driver, table, m.before, m.after));
  for (const r of changes.renameColumns) out.push(...buildRenameColumn(driver, table, r.from, r.to));
  for (const col of changes.addColumns) out.push(...buildAddColumn(driver, table, col));
  if (changes.renameTo && changes.renameTo.trim() !== '' && changes.renameTo.trim() !== table) {
    out.push(...buildRenameTable(driver, table, changes.renameTo.trim()));
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/renderer && npx vitest run src/lib/ddlBuilder.test.ts`
Expected: PASS (전체 ddlBuilder 스위트 green).

- [ ] **Step 5: Commit** (git 초기화 시)

```bash
git add apps/renderer/src/lib/ddlBuilder.ts apps/renderer/src/lib/ddlBuilder.test.ts
git commit -m "feat(ddl): add buildTableChanges orchestrator"
```

---

## Task 5: runDdl 헬퍼 (문장 순차 실행)

**Files:**
- Create: `apps/renderer/src/lib/runDdl.ts`

> 이 헬퍼는 `window.electronAPI`(Electron IPC) 위에서 동작하는 얇은 IO 어댑터다. 순수 로직(생성기)은 Task 1–4에서 단위 테스트했고, 이 헬퍼는 Task 10의 실제 실행(CDP)으로 검증한다. 단위 테스트 없이 진행한다(IO 경계, 모킹 가치 낮음).

- [ ] **Step 1: Implement**

`apps/renderer/src/lib/runDdl.ts`:

```ts
// Executes a list of DDL statements sequentially against a connection, using
// the existing query-stream IPC with write + destructive flags enabled. Stops
// at the first failure and reports which statement failed. UI-only adapter.

export interface DdlResult {
  ok: boolean;
  ranCount: number; // how many statements succeeded
  failedStatement?: string;
  error?: string;
}

function runOne(profileId: string, sql: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const queryId = `ddl-${crypto.randomUUID()}`;
    let settled = false;
    const cleanup = window.electronAPI.onQueryStreamChunk((id, chunk: any) => {
      if (id !== queryId || settled) return;
      if (chunk.type === 'done') {
        settled = true;
        cleanup();
        resolve({ ok: true });
      } else if (chunk.type === 'error') {
        settled = true;
        cleanup();
        resolve({ ok: false, error: chunk.message || 'Execution error' });
      } else if (chunk.type === 'policy') {
        settled = true;
        cleanup();
        resolve({ ok: false, error: chunk.message || 'Blocked by policy' });
      }
    });

    window.electronAPI
      .executeQueryStream(queryId, profileId, sql, { allowWrite: true, confirmDestructive: true })
      .then((res) => {
        if (!res.success && !settled) {
          settled = true;
          cleanup();
          resolve({ ok: false, error: res.error || 'Failed to start statement' });
        }
      })
      .catch((e: any) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve({ ok: false, error: e?.message || 'Request failed' });
        }
      });
  });
}

export async function runDdl(profileId: string, statements: string[]): Promise<DdlResult> {
  let ran = 0;
  for (const sql of statements) {
    const r = await runOne(profileId, sql);
    if (!r.ok) {
      return { ok: false, ranCount: ran, failedStatement: sql, error: r.error };
    }
    ran += 1;
  }
  return { ok: true, ranCount: ran };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/renderer && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit** (git 초기화 시)

```bash
git add apps/renderer/src/lib/runDdl.ts
git commit -m "feat(ddl): add sequential runDdl IPC executor"
```

---

## Task 6: TableEditDialog (큰 폼 + 미리보기 + 실행)

**Files:**
- Create: `apps/renderer/src/components/TableEditDialog.tsx`

- [ ] **Step 1: Implement**

`apps/renderer/src/components/TableEditDialog.tsx`:

```tsx
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
      } catch (e: any) {
        if (!ignore) setError(e?.message || 'Failed to load columns');
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
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/renderer && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit** (git 초기화 시)

```bash
git add apps/renderer/src/components/TableEditDialog.tsx
git commit -m "feat(ddl): add TableEditDialog (column editor + live SQL preview)"
```

---

## Task 7: TableActionDialog (이름변경 / 비우기 / 삭제)

**Files:**
- Create: `apps/renderer/src/components/TableActionDialog.tsx`

- [ ] **Step 1: Implement**

`apps/renderer/src/components/TableActionDialog.tsx`:

```tsx
import React, { useMemo, useState } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { buildRenameTable, buildTruncateTable, buildDropTable, type Driver } from '../lib/ddlBuilder';
import { runDdl } from '../lib/runDdl';

export type TableAction = 'rename' | 'truncate' | 'drop';

interface Props {
  profileId: string;
  driver: Driver;
  table: string;
  action: TableAction;
  onClose: () => void;
  onApplied: () => void;
}

const TITLE: Record<TableAction, string> = {
  rename: '테이블 이름 변경',
  truncate: '테이블 비우기 (TRUNCATE)',
  drop: '테이블 삭제 (DROP)',
};

export const TableActionDialog: React.FC<Props> = ({ profileId, driver, table, action, onClose, onApplied }) => {
  const [newName, setNewName] = useState(table);
  const [confirmText, setConfirmText] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statements = useMemo(() => {
    if (action === 'rename') {
      return newName.trim() && newName.trim() !== table ? buildRenameTable(driver, table, newName.trim()) : [];
    }
    if (action === 'truncate') return buildTruncateTable(driver, table);
    return buildDropTable(driver, table);
  }, [action, driver, table, newName]);

  const destructive = action === 'truncate' || action === 'drop';
  const confirmed = !destructive || confirmText.trim() === table;
  const canRun = statements.length > 0 && confirmed && !running;

  const apply = async () => {
    setRunning(true);
    setError(null);
    const res = await runDdl(profileId, statements);
    setRunning(false);
    if (res.ok) {
      onApplied();
      onClose();
    } else {
      setError(res.error || '실행 실패');
    }
  };

  const preview = statements.join(';\n') + (statements.length ? ';' : '');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{TITLE[action]} · <span className="mono">{table}</span></h3>
          <button className="icon-btn" onClick={onClose} title="Close"><X size={15} /></button>
        </div>

        {action === 'rename' && (
          <label className="form-row">
            <span className="form-label">새 이름</span>
            <input className="input" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} />
          </label>
        )}

        <div className="ddl-preview">
          <div className="ddl-preview-head">생성될 SQL</div>
          <pre className="ddl-block">{preview || '— 변경 없음 —'}</pre>
        </div>

        {destructive && (
          <label className="form-row">
            <span className="form-label danger">
              되돌릴 수 없습니다. 진행하려면 테이블 이름 <b>{table}</b> 을(를) 입력하세요
            </span>
            <input className="input" autoFocus value={confirmText} placeholder={table}
              onChange={(e) => setConfirmText(e.target.value)} />
          </label>
        )}

        {error && (<div className="alert error"><AlertTriangle size={14} /><span>{error}</span></div>)}

        <div className="modal-foot">
          <button className="btn btn-secondary" onClick={onClose}>취소</button>
          <button className={`btn ${destructive ? 'btn-danger' : 'btn-primary'}`} onClick={apply} disabled={!canRun}>
            {running ? <span className="spinner" /> : null} {action === 'drop' ? '삭제' : action === 'truncate' ? '비우기' : '변경'}
          </button>
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/renderer && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit** (git 초기화 시)

```bash
git add apps/renderer/src/components/TableActionDialog.tsx
git commit -m "feat(ddl): add TableActionDialog (rename/truncate/drop with typed confirm)"
```

---

## Task 8: SchemaExplorer 메뉴 확장 + 다이얼로그 마운트 + 트리 새로고침

**Files:**
- Modify: `apps/renderer/src/components/SchemaExplorer.tsx`

- [ ] **Step 1: Add prop + dialog state + menu items**

`SchemaExplorerProps`에 `onSchemaChanged` 추가:

```tsx
interface SchemaExplorerProps {
  profileId: string;
  driver: 'mysql' | 'postgres' | 'redis';
  onDisconnect: () => void;
  onSchemaChanged?: () => void;
}
```

컴포넌트 시그니처와 import 수정:

```tsx
import { ChevronRight, Database, Table2, KeyRound, AlertTriangle, FileCode, Copy, X, Pencil, PlusSquare, Eraser, Trash2, Type } from 'lucide-react';
import { TableEditDialog } from './TableEditDialog';
import { TableActionDialog, type TableAction } from './TableActionDialog';
```

```tsx
export const SchemaExplorer: React.FC<SchemaExplorerProps> = ({ profileId, driver, onSchemaChanged }) => {
```

다이얼로그 상태(기존 `ddl` 상태 옆에 추가):

```tsx
  const [edit, setEdit] = useState<{ db: string; table: string; focusNewColumn: boolean } | null>(null);
  const [tableAction, setTableAction] = useState<{ db: string; table: string; action: TableAction } | null>(null);
```

성공 후 새로고침: 해당 DB의 테이블 목록을 다시 불러오고(열림 상태 유지), 컬럼 캐시를 비워 다음 확장 시 재조회. 그리고 상위로 통지.

```tsx
  const refreshAfterDdl = async (dbName: string) => {
    onSchemaChanged?.();
    let tables: TableNode[] | undefined;
    try {
      const res = await window.electronAPI.listTables(profileId, dbName);
      if (res.success && res.data) {
        tables = res.data.map((t) => ({ name: t.name, isOpen: false, isLoading: false }));
      }
    } catch (err) {
      console.error(err);
    }
    setDatabases((prev) =>
      prev.map((db) => (db.name === dbName ? { ...db, isOpen: true, isLoading: false, tables: tables ?? db.tables } : db))
    );
  };
```

> 단, `driver`는 `SchemaExplorerProps`상 `'redis'`도 가능하다. 다이얼로그는 SQL 방언(`mysql`/`postgres`)만 받으므로, 메뉴 자체를 redis가 아닐 때만 연다(아래 메뉴는 SQL 커넥션에서만 우클릭됨 — redis는 `SchemaExplorer`가 트리를 그리지 않음). 다이얼로그에 driver를 넘길 때 `driver as 'mysql' | 'postgres'`로 좁힌다.

- [ ] **Step 2: Replace the context menu block** (기존 `{menu && ( … )}` 전체 교체)

```tsx
      {menu && (
        <div className="ctx-menu" style={{ top: menu.y, left: menu.x }} onClick={(e) => e.stopPropagation()}>
          <button className="ctx-item" onClick={() => showDDL(menu.db, menu.table)}>
            <FileCode size={13} /> Show DDL
          </button>
          <div className="ctx-sep" />
          <button className="ctx-item" onClick={() => { setEdit({ db: menu.db, table: menu.table, focusNewColumn: false }); setMenu(null); }}>
            <Pencil size={13} /> 테이블 수정…
          </button>
          <button className="ctx-item" onClick={() => { setEdit({ db: menu.db, table: menu.table, focusNewColumn: true }); setMenu(null); }}>
            <PlusSquare size={13} /> 컬럼 추가…
          </button>
          <button className="ctx-item" onClick={() => { setTableAction({ db: menu.db, table: menu.table, action: 'rename' }); setMenu(null); }}>
            <Type size={13} /> 테이블 이름 변경…
          </button>
          <div className="ctx-sep" />
          <button className="ctx-item" onClick={() => { setTableAction({ db: menu.db, table: menu.table, action: 'truncate' }); setMenu(null); }}>
            <Eraser size={13} /> 테이블 비우기…
          </button>
          <button className="ctx-item danger" onClick={() => { setTableAction({ db: menu.db, table: menu.table, action: 'drop' }); setMenu(null); }}>
            <Trash2 size={13} /> 테이블 삭제…
          </button>
        </div>
      )}

      {edit && (
        <TableEditDialog
          profileId={profileId}
          driver={driver as 'mysql' | 'postgres'}
          database={edit.db}
          table={edit.table}
          focusNewColumn={edit.focusNewColumn}
          onClose={() => setEdit(null)}
          onApplied={() => refreshAfterDdl(edit.db)}
        />
      )}

      {tableAction && (
        <TableActionDialog
          profileId={profileId}
          driver={driver as 'mysql' | 'postgres'}
          table={tableAction.table}
          action={tableAction.action}
          onClose={() => setTableAction(null)}
          onApplied={() => refreshAfterDdl(tableAction.db)}
        />
      )}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/renderer && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit** (git 초기화 시)

```bash
git add apps/renderer/src/components/SchemaExplorer.tsx
git commit -m "feat(ddl): wire DDL menu items + dialogs into SchemaExplorer"
```

---

## Task 9: 자동완성 스키마 재조회 배선 (App ↔ QueryEditor)

**Files:**
- Modify: `apps/renderer/src/App.tsx`
- Modify: `apps/renderer/src/components/QueryEditor.tsx`

- [ ] **Step 1: QueryEditor — `schemaVersion` prop 추가**

QueryEditor의 props 인터페이스에 추가(파일 상단 props 타입):

```tsx
  schemaVersion?: number;
```

컴포넌트 구조분해에 `schemaVersion`를 추가하고, 스키마 로딩 effect의 deps에 포함:

```tsx
  }, [profileId, database, schemaVersion]);
```

(95–111행의 effect. `schemaVersion`이 바뀌면 `getSchemaCompletion`을 다시 불러 자동완성 스키마를 갱신한다.)

- [ ] **Step 2: App — `schemaVersion` 상태 + 전달**

App 컴포넌트 상단 상태 추가:

```tsx
  const [schemaVersion, setSchemaVersion] = useState(0);
```

`SchemaExplorer` 렌더(455행)에 `onSchemaChanged` 전달:

```tsx
                          <SchemaExplorer
                            profileId={p.id!}
                            driver={p.driver}
                            onDisconnect={() => disconnect(p.id!)}
                            onSchemaChanged={() => setSchemaVersion((n) => n + 1)}
                          />
```

`QueryEditor` 렌더(551행)에 `schemaVersion` 전달:

```tsx
                    <QueryEditor
                      profileId={id}
                      driver={profile.driver}
                      database={profile.database}
                      connectionName={profile.name}
                      schemaVersion={schemaVersion}
                      onQueryExecuted={() => setHistoryTrigger((n) => n + 1)}
                      loadTriggerQuery={focused ? selectedQueryText : ''}
                    />
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/renderer && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit** (git 초기화 시)

```bash
git add apps/renderer/src/App.tsx apps/renderer/src/components/QueryEditor.tsx
git commit -m "feat(ddl): refresh autocomplete schema after DDL changes"
```

---

## Task 10: 다이얼로그/폼 CSS

**Files:**
- Modify: `apps/renderer/src/App.css`

- [ ] **Step 1: Append styles** (기존 `.ctx-menu`, `.modal*`, `.ddl-block` 토큰/변수 재사용)

```css
/* DDL editor dialogs */
.ctx-sep { height: 1px; background: var(--border); margin: 4px 0; }
.ctx-item.danger { color: #ff6b6b; }

.modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.form-row { display: flex; flex-direction: column; gap: 4px; margin: 10px 0; }
.form-label { font-size: 12px; color: var(--text-3); }
.form-label.danger { color: #ff6b6b; }

.ddl-cols { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; }
.ddl-col-head,
.ddl-col-row {
  display: grid;
  grid-template-columns: 1.4fr 1.4fr 44px 1.2fr 32px;
  gap: 8px;
  align-items: center;
}
.ddl-col-head { font-size: 11px; color: var(--text-3); padding: 0 2px; }
.ddl-col-row.removed input { text-decoration: line-through; opacity: 0.5; }

.ddl-preview { margin-top: 12px; }
.ddl-preview-head { font-size: 11px; color: var(--text-3); margin-bottom: 4px; }

.btn-danger { background: #c0392b; color: #fff; }
.btn-danger:disabled { opacity: 0.5; }
```

> `--border`, `--text-3`, `.input`, `.btn`, `.btn-primary`, `.btn-secondary`, `.modal`, `.modal-wide`, `.modal-overlay`, `.modal-head`, `.ddl-block`, `.spinner`는 기존에 정의돼 있음. 없으면 해당 파일에서 grep으로 확인 후 누락된 것만 추가.

- [ ] **Step 2: Commit** (git 초기화 시)

```bash
git add apps/renderer/src/App.css
git commit -m "style(ddl): dialog + column-editor styles"
```

---

## Task 11: 전체 단위 테스트 + 빌드 + CDP 실제 검증

**Files:** (없음 — 검증 전용)

- [ ] **Step 1: Unit tests + typecheck + build**

```bash
cd apps/renderer
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run        # ddlBuilder 포함 전체 green 기대
npx tsc --noEmit      # no errors
npm run build         # 빌드 성공
```
Expected: 모든 테스트 통과, 타입 에러 없음, 빌드 성공.

- [ ] **Step 2: 라이브 DB 준비**

```bash
docker ps --format '{{.Names}}' | grep -E 'dev-mysql|verify-pg'
# 없으면 verify-pg 기동(postgres:16, postgres/postgres), dev-mysql은 사용자 것 — 유지
```

- [ ] **Step 3: CDP로 실제 동작 검증** (`--remote-debugging-port=9222`로 실행 중인 인스턴스 대상)

검증 시나리오(메모리의 CDP/`screencapture` 방식 사용 — DOM 측정이 신뢰 신호):
1. mysql 커넥션에서 테이블 우클릭 → 메뉴에 새 항목 6개 노출 확인.
2. **컬럼 추가…** → 새 행에 `note` / `VARCHAR(100)` / nullable 입력 → 미리보기가 ``ALTER TABLE `demo_users` ADD COLUMN `note` VARCHAR(100)`` 인지 확인 → 실행 → 성공 후 트리에서 `note` 컬럼 보이는지 확인.
3. 같은 컬럼 **테이블 수정…** 에서 타입 변경(예: `VARCHAR(200)`) → 미리보기 `MODIFY COLUMN` → 실행 → 반영 확인.
4. **테이블 비우기…** → 이름 오입력 시 버튼 비활성, 정확히 입력 시 활성 → 실행 → 행 수 0 확인.
5. postgres(verify-pg) 커넥션에서 컬럼 수정으로 NOT NULL 토글 → 미리보기에 `SET NOT NULL`/`DROP NOT NULL` 다중문장 → 실행 → 에러 없이 적용.
6. 자동완성: 새 컬럼명이 SQL 자동완성 후보에 뜨는지 확인(스키마 재조회 배선).

- [ ] **Step 4: 정리**

내가 띄운 컨테이너/임시 스크립트만 정리(`dev-mysql`은 사용자 것 — 유지). `/tmp/*.mjs` 제거.

---

## Self-Review (작성자 체크리스트 — 완료)

- **스펙 커버리지:** 컬럼 추가/삭제/수정/이름변경(Task 1–2, 6), 테이블 삭제/이름변경/비우기(Task 3, 7), 미리보기 후 실행(Task 6–7), 한 폼에 컬럼+테이블이름(Task 6), 이름 타이핑 확인(Task 7), 방언 분기(Task 1–4), 순차 실행/다중문장(Task 5), 트리·자동완성 새로고침(Task 8–9), 백엔드 무변경(전체) — 모두 태스크 매핑됨.
- **플레이스홀더:** 없음(모든 코드 블록 완전). Task 6의 설명용 죽은 memo는 Step 2에서 제거하도록 명시.
- **타입 일관성:** `Driver`, `ColumnSpec`, `TableChangeSet`, `DdlResult`, `runDdl`, `buildTableChanges`, `onSchemaChanged`, `schemaVersion` 시그니처가 태스크 간 일치.
