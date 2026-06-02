# 인덱스 관리 UI Implementation Plan

**Goal:** 테이블의 인덱스를 조회하고, 생성·삭제할 수 있는 UI를 추가한다 (DataGrip 기본기).

**Architecture:** 조회는 engine에 read 메서드 `ListIndexes`를 양 adapter(mysql/postgres)에 구현(통합 테스트 포함) → interface/transport/route/IPC로 연결. 생성·삭제는 순수 SQL 빌더(`indexDdl.ts`, TDD)로 만들어 기존 `runBatch`(executeBatch, allowWrite+confirmDestructive)로 실행. UI는 테이블 우클릭 메뉴 → `IndexManagerDialog`(기존 CSV/DDL 다이얼로그 패턴).

**Tech Stack:** Go(engine), TypeScript/React, Electron IPC, vitest/Playwright.

> 브랜치 `feat/index-management`. Go: `/Users/smlee/sdk/go/bin/go`. AGENTS.md 0번 규칙대로 라이브 검증 필수.

---

## IDX-E1: engine `Index` 타입 + 양 adapter `ListIndexes` (통합 테스트 우선)

**Files:** `engine/internal/ports/connector.go`, `engine/internal/adapters/mysql/mysql_adapter.go`, `engine/internal/adapters/postgres/postgres_adapter.go`, 각 `*_integration_test.go`

1. `connector.go`: 타입 추가
```go
// Index describes a table index (one entry per index, columns in order).
type Index struct {
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
	Unique  bool     `json:"unique"`
	Primary bool     `json:"primary"`
}
```
2. mysql `ListIndexes`: `information_schema.statistics`에서 `index_name, column_name, non_unique, seq_in_index`를 `ORDER BY index_name, seq_in_index`로 읽어 index_name별로 컬럼을 모은다. `Unique = non_unique==0`, `Primary = index_name=='PRIMARY'`.
3. postgres `ListIndexes`: `pg_index`/`pg_class`/`pg_attribute`를 join, `unnest(indkey) WITH ORDINALITY`로 컬럼 순서 보존. `Unique = indisunique`, `Primary = indisprimary`, schema `public`.
4. 통합 테스트(라이브 DB): 임시 테이블 생성 → `CREATE INDEX`/`UNIQUE INDEX` → `ListIndexes`가 PK + 생성한 인덱스를 컬럼/Unique/Primary 플래그와 함께 반환하는지 확인 → 임시 테이블 DROP.

Verify: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/adapters/...`

## IDX-E2: interface + transport handler + route

**Files:** `engine/internal/ports/connector.go`, `engine/internal/transport/http/introspection.go`, `engine/cmd/app-engine/main.go`

1. `SQLConnector` 인터페이스에 `ListIndexes(ctx, p, password, database, table) ([]Index, error)` 추가 (양 adapter 구현 후).
2. `introspection.go`: `Indexes()` 핸들러 — `ForeignKeys()` 미러(profileId/database/table 쿼리 파라미터, JSON 인코딩).
3. `main.go`: `mux.Handle("/indexes", introHandler.Indexes())` (`/foreign-keys` 뒤).

Verify: `go build ./...`

## IDX-F1: IPC `listIndexes` + 타입

**Files:** `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `apps/renderer/src/global.d.ts`

- main: `ipcMain.handle('list-indexes', ...)` → GET `/indexes?profileId&database&table` (list-foreign-keys 미러).
- preload: `listIndexes: (profileId, database, table) => ipcRenderer.invoke('list-indexes', ...)`.
- global.d.ts: `IndexInfo { name: string; columns: string[]; unique: boolean; primary: boolean }` + `listIndexes(...) => Promise<ResultWrapper<IndexInfo[]>>`.

Verify: renderer+desktop `tsc --noEmit`.

## IDX-F2: `indexDdl.ts` 순수 빌더 (TDD)

**Files:** Create `apps/renderer/src/lib/indexDdl.ts`, `apps/renderer/src/lib/indexDdl.test.ts`

- `buildCreateIndex(driver, { table, name, columns, unique })` → `CREATE [UNIQUE ]INDEX <q name> ON <q table> (<q col>, ...)` (`quoteIdent` 재사용).
- `buildDropIndex(driver, { table, name })`:
  - mysql: `DROP INDEX <q name> ON <q table>`
  - postgres: `DROP INDEX <q name>`

테스트(실패 먼저): 단일/복합 컬럼, unique on/off, 양 driver 인용(backtick vs double-quote), drop의 driver 차이.

Verify: `npx vitest run src/lib/indexDdl.test.ts`

## IDX-F3: `IndexManagerDialog.tsx`

**Files:** Create `apps/renderer/src/components/IndexManagerDialog.tsx`

- props: `{ profileId, driver, database, table, onClose, onChanged }`.
- 마운트 시 `listIndexes`로 목록 로드. 각 행: 이름, 컬럼(쉼표), `UNIQUE`/`PK` 배지, 삭제 버튼(Primary면 비활성·"PK는 테이블 편집에서").
- 추가 폼: 인덱스명 입력, 테이블 컬럼 다중선택(체크박스; 컬럼은 `describeTable`/기존 컬럼 조회 재사용), `UNIQUE` 체크 → `buildCreateIndex` → `runBatch([sql])` → 목록 재로드 + `onChanged`.
- 삭제: confirm 후 `buildDropIndex` → `runBatch` → 재로드.
- 에러는 다이얼로그 내 alert로 표시. 기존 다이얼로그 스타일 재사용.

> 컬럼 목록 출처: 기존 `window.electronAPI`의 컬럼 조회(describeTable 또는 listColumns)를 확인해 재사용. 없으면 `DESCRIBE`/`information_schema`를 runSelect로 읽는다.

Verify: `tsc --noEmit`.

## IDX-F4: SchemaExplorer 메뉴 + 마운트 + CSS

**Files:** `apps/renderer/src/components/SchemaExplorer.tsx`, `apps/renderer/src/App.css`

- 테이블 컨텍스트 메뉴에 `인덱스 관리…`(`KeyRound`/`ListTree` 아이콘) 추가 → `setIndexMgr({ db, table })`.
- `{indexMgr && <IndexManagerDialog key=... onChanged={() => refreshAfterDdl(indexMgr.db)} />}` 마운트.
- 필요한 최소 CSS(.idx-row 등) 추가.

Verify: `tsc --noEmit && npx vitest run && npm run build`.

## IDX-V: 라이브 검증 (AGENTS.md 0번) + E2E

1. `pnpm build:engine` + desktop tsc + Electron 재시작(새 라우트/IPC).
2. CDP/Playwright: 일회용 테이블 생성 → 우클릭 인덱스 관리 → 인덱스 추가(컬럼 선택, unique) → 목록에 표시 확인 → mysql2로 실제 인덱스 존재 확인 → 삭제 → 사라짐 확인 → 테이블 DROP.
3. 재현 흐름은 `apps/desktop/e2e/index.spec.ts`로 고정(일회용 테이블, skip-if-down).

## IDX-M: 머지

```bash
git checkout main && git merge --no-ff feat/index-management
```
