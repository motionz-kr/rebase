# 편집 저장 트랜잭션 (Transactional Edit Save) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 인라인 편집 저장의 여러 UPDATE/INSERT/DELETE를 하나의 DB 트랜잭션으로 실행해 "전부 성공 아니면 전부 롤백"을 보장한다.

**Architecture:** 엔진에 트랜잭션 배치 실행 경로(`ExecuteBatch`)를 추가하고, 프론트는 `runBatch`로 그것을 호출한다. `TableDataView.save`만 `runDdl`→`runBatch`로 바꾸고, DDL 다이얼로그는 그대로 둔다. 백엔드(Go) + 프론트(TS) 모두 변경.

**Tech Stack:** Go 1.25 (engine), React/TS (renderer), Electron IPC, vitest, Go testing.

> **도구 경로:** Go는 `/Users/smlee/sdk/go/bin/go` (PATH에 없음). node/pnpm은 `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`. git 저장소(main 브랜치 — **시작 전 feature 브랜치 생성**). Go 모듈: `github.com/smlee/database-local-engine/engine`. 라이브 DB: dev-mysql(root/`password1!`/devdb), verify-pg(postgres/postgres). **엔진 통합 테스트는 라이브 DB가 떠 있어야 한다.**

> **시작 전:** `git checkout -b feat/transactional-edit-save`

---

## File Structure

- **수정** `engine/internal/adapters/mysql/mysql_adapter.go` — `ExecuteBatch` 구현. (+ `mysql_integration_test.go` 테스트)
- **수정** `engine/internal/adapters/postgres/postgres_adapter.go` — `ExecuteBatch` 구현. (+ `postgres_integration_test.go` 신규)
- **수정** `engine/internal/ports/connector.go` — `SQLConnector` 인터페이스에 `ExecuteBatch` 추가.
- **수정** `engine/internal/transport/http/query.go` — `ExecuteBatch()` 핸들러 + 요청 타입.
- **수정** `engine/cmd/app-engine/main.go` — 라우트 `/query/execute-batch`.
- **신규** `apps/renderer/src/lib/runBatch.ts` (+ `.test.ts`) — `mapBatchResult`(TDD) + `runBatch`.
- **수정** `apps/desktop/src/main/index.ts` (IPC), `apps/desktop/src/preload/index.ts`, `apps/renderer/src/global.d.ts` — `executeBatch`.
- **수정** `apps/renderer/src/components/TableDataView.tsx` — `save`가 `runBatch` 사용.
- 변경 없음: DDL 다이얼로그들, `runDdl.ts`.

---

## Task E1: mysql ExecuteBatch (TDD, 통합 테스트)

**Files:**
- Modify: `engine/internal/adapters/mysql/mysql_adapter.go`
- Test: `engine/internal/adapters/mysql/mysql_integration_test.go`

> 사전: dev-mysql 컨테이너가 떠 있어야 한다 (`docker ps | grep dev-mysql`).

- [ ] **Step 1: Write the failing test** — `mysql_integration_test.go` 끝에 추가. (파일 상단 import에 없으면 `"context"`, `"testing"`, `"time"`, `domain`은 이미 있음 — 추가 import 불필요.)

```go
func TestMySQLConnector_ExecuteBatch(t *testing.T) {
	connector := NewMySQLConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p := domain.ConnectionProfile{
		ID: "mysql-batch-1", Name: "MySQL Local", Driver: "mysql",
		Host: "127.0.0.1", Port: 3306, Database: "devdb", Username: "root", TLSMode: "none",
	}
	pw := "password1!"

	exec := func(q string) error {
		_, err := connector.ExecuteQueryStream(ctx, p, pw, q, false,
			func(int64) {}, func([]string) error { return nil }, func([]any) error { return nil })
		return err
	}
	_ = exec("DROP TABLE IF EXISTS devdb.batch_test")
	if err := exec("CREATE TABLE devdb.batch_test (id INT PRIMARY KEY, v INT)"); err != nil {
		t.Fatalf("setup: %v", err)
	}
	defer exec("DROP TABLE IF EXISTS devdb.batch_test")

	// rollback: duplicate PK in the 2nd statement rolls the whole batch back
	_, failedIndex, err := connector.ExecuteBatch(ctx, p, pw, []string{
		"INSERT INTO devdb.batch_test (id, v) VALUES (1, 10)",
		"INSERT INTO devdb.batch_test (id, v) VALUES (1, 20)",
	})
	if err == nil {
		t.Fatal("expected a duplicate-key error")
	}
	if failedIndex != 1 {
		t.Errorf("expected failedIndex 1, got %d", failedIndex)
	}
	// rollback proof: id=1 is free again, so inserting it now succeeds
	_, fi2, err2 := connector.ExecuteBatch(ctx, p, pw, []string{
		"INSERT INTO devdb.batch_test (id, v) VALUES (1, 99)",
	})
	if err2 != nil || fi2 != -1 {
		t.Fatalf("rollback did not happen — id=1 still present (err=%v, fi=%d)", err2, fi2)
	}

	// commit: distinct ids → both apply atomically
	affected, fi3, err3 := connector.ExecuteBatch(ctx, p, pw, []string{
		"UPDATE devdb.batch_test SET v = 100 WHERE id = 1",
		"INSERT INTO devdb.batch_test (id, v) VALUES (2, 20)",
	})
	if err3 != nil || fi3 != -1 {
		t.Fatalf("expected success, got err=%v fi=%d", err3, fi3)
	}
	if affected != 2 {
		t.Errorf("expected rowsAffected 2, got %d", affected)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/adapters/mysql/ -run TestMySQLConnector_ExecuteBatch 2>&1 | head`
Expected: BUILD FAIL — `connector.ExecuteBatch undefined (type *MySQLConnector has no field or method ExecuteBatch)`. (Compile error is the RED.)

- [ ] **Step 3: Write minimal implementation** — append to `mysql_adapter.go` (uses existing `connectForQuery`, `normalizeError`; `database/sql` already imported):

```go
// ExecuteBatch runs all statements inside a single transaction. On the first
// failure it rolls back and returns the 0-based index of the failed statement;
// on success it commits and returns the total rows affected with failedIndex -1.
func (c *MySQLConnector) ExecuteBatch(ctx context.Context, p domain.ConnectionProfile, password string, statements []string) (int64, int, error) {
	db, err := c.connectForQuery(p, password)
	if err != nil {
		return 0, -1, err
	}
	defer db.Close()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, -1, c.normalizeError(err)
	}

	var total int64
	for i, stmt := range statements {
		res, execErr := tx.ExecContext(ctx, stmt)
		if execErr != nil {
			_ = tx.Rollback()
			return total, i, c.normalizeError(execErr)
		}
		if n, aerr := res.RowsAffected(); aerr == nil {
			total += n
		}
	}
	if err := tx.Commit(); err != nil {
		return total, -1, c.normalizeError(err)
	}
	return total, -1, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/adapters/mysql/ -run TestMySQLConnector_ExecuteBatch -v 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/smlee/projects/product/database
git add engine/internal/adapters/mysql/
git commit -m "feat(engine): add transactional ExecuteBatch to mysql connector"
```

---

## Task E2: postgres ExecuteBatch (TDD, 통합 테스트)

**Files:**
- Modify: `engine/internal/adapters/postgres/postgres_adapter.go`
- Test: `engine/internal/adapters/postgres/postgres_integration_test.go` (신규)

> 사전: verify-pg 컨테이너가 떠 있어야 한다 (`docker ps | grep verify-pg`). 없으면 기동: `docker run -d --name verify-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`.

- [ ] **Step 1: Write the failing test** — 신규 `postgres_integration_test.go`:

```go
package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func TestPostgreSQLConnector_ExecuteBatch(t *testing.T) {
	connector := NewPostgreSQLConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p := domain.ConnectionProfile{
		ID: "pg-batch-1", Name: "PG Local", Driver: "postgres",
		Host: "127.0.0.1", Port: 5432, Database: "postgres", Username: "postgres", TLSMode: "none",
	}
	pw := "postgres"

	exec := func(q string) error {
		_, err := connector.ExecuteQueryStream(ctx, p, pw, q, false,
			func(int64) {}, func([]string) error { return nil }, func([]any) error { return nil })
		return err
	}
	_ = exec("DROP TABLE IF EXISTS batch_test")
	if err := exec("CREATE TABLE batch_test (id INT PRIMARY KEY, v INT)"); err != nil {
		t.Fatalf("setup: %v", err)
	}
	defer exec("DROP TABLE IF EXISTS batch_test")

	_, failedIndex, err := connector.ExecuteBatch(ctx, p, pw, []string{
		"INSERT INTO batch_test (id, v) VALUES (1, 10)",
		"INSERT INTO batch_test (id, v) VALUES (1, 20)",
	})
	if err == nil {
		t.Fatal("expected a duplicate-key error")
	}
	if failedIndex != 1 {
		t.Errorf("expected failedIndex 1, got %d", failedIndex)
	}
	_, fi2, err2 := connector.ExecuteBatch(ctx, p, pw, []string{
		"INSERT INTO batch_test (id, v) VALUES (1, 99)",
	})
	if err2 != nil || fi2 != -1 {
		t.Fatalf("rollback did not happen — id=1 still present (err=%v, fi=%d)", err2, fi2)
	}

	affected, fi3, err3 := connector.ExecuteBatch(ctx, p, pw, []string{
		"UPDATE batch_test SET v = 100 WHERE id = 1",
		"INSERT INTO batch_test (id, v) VALUES (2, 20)",
	})
	if err3 != nil || fi3 != -1 {
		t.Fatalf("expected success, got err=%v fi=%d", err3, fi3)
	}
	if affected != 2 {
		t.Errorf("expected rowsAffected 2, got %d", affected)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/adapters/postgres/ -run TestPostgreSQLConnector_ExecuteBatch 2>&1 | head`
Expected: BUILD FAIL — `connector.ExecuteBatch undefined`. (RED.)

- [ ] **Step 3: Write minimal implementation** — append to `postgres_adapter.go` (uses existing `connect`, `normalizeError`):

```go
// ExecuteBatch runs all statements inside a single transaction. On the first
// failure it rolls back and returns the 0-based index of the failed statement;
// on success it commits and returns the total rows affected with failedIndex -1.
func (c *PostgreSQLConnector) ExecuteBatch(ctx context.Context, p domain.ConnectionProfile, password string, statements []string) (int64, int, error) {
	db, err := c.connect(p, password, p.Database)
	if err != nil {
		return 0, -1, err
	}
	defer db.Close()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, -1, c.normalizeError(err)
	}

	var total int64
	for i, stmt := range statements {
		res, execErr := tx.ExecContext(ctx, stmt)
		if execErr != nil {
			_ = tx.Rollback()
			return total, i, c.normalizeError(execErr)
		}
		if n, aerr := res.RowsAffected(); aerr == nil {
			total += n
		}
	}
	if err := tx.Commit(); err != nil {
		return total, -1, c.normalizeError(err)
	}
	return total, -1, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/adapters/postgres/ -run TestPostgreSQLConnector_ExecuteBatch -v 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/smlee/projects/product/database
git add engine/internal/adapters/postgres/
git commit -m "feat(engine): add transactional ExecuteBatch to postgres connector"
```

---

## Task E3: SQLConnector 인터페이스 + 전송 핸들러 + 라우트

**Files:**
- Modify: `engine/internal/ports/connector.go`
- Modify: `engine/internal/transport/http/query.go`
- Modify: `engine/cmd/app-engine/main.go`

- [ ] **Step 1: Add to the `SQLConnector` interface** — in `connector.go`, inside `type SQLConnector interface { ... }`, after the `ExecuteQueryStream(...)` line add:

```go
	ExecuteBatch(ctx context.Context, p domain.ConnectionProfile, password string, statements []string) (rowsAffected int64, failedIndex int, err error)
```

- [ ] **Step 2: Add the request type + handler** — in `query.go`, add near `ExecuteQueryRequest`:

```go
type ExecuteBatchRequest struct {
	ProfileID          string   `json:"profileId"`
	Statements         []string `json:"statements"`
	AllowWrite         bool     `json:"allowWrite"`
	ConfirmDestructive bool     `json:"confirmDestructive"`
}
```

and add this handler method (mirrors `ExecuteQuery`'s token/policy/profile pattern, but non-streaming):

```go
func (h *QueryHandler) ExecuteBatch() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		var req ExecuteBatchRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.ProfileID == "" || len(req.Statements) == 0 {
			http.Error(w, "profileId and statements are required", http.StatusBadRequest)
			return
		}

		// Per-statement policy gate (each entry is a single statement).
		for _, stmt := range req.Statements {
			class := domain.ClassifyQuery(stmt)
			if !class.ReadOnly && !req.AllowWrite {
				writeQueryPolicyError(w, http.StatusForbidden, "read_only_blocked",
					"This statement may modify data and is blocked in read-only mode.", class.Verb)
				return
			}
			if class.Destructive && !req.ConfirmDestructive {
				writeQueryPolicyError(w, http.StatusConflict, "confirmation_required",
					"This is a destructive statement. Confirm to run it.", class.Verb)
				return
			}
		}

		profile, password, err := h.service.GetProfile(r.Context(), req.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		connector, err := h.getConnector(profile.Driver)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		rowsAffected, failedIndex, execErr := connector.ExecuteBatch(r.Context(), *profile, password, req.Statements)
		resp := map[string]any{
			"ok":           execErr == nil,
			"rowsAffected": rowsAffected,
			"failedIndex":  failedIndex,
		}
		if execErr != nil {
			resp["error"] = execErr.Error()
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
}
```

- [ ] **Step 3: Register the route** — in `cmd/app-engine/main.go`, after `mux.Handle("/query/execute", ...)`:

```go
	mux.Handle("/query/execute-batch", queryHandler.ExecuteBatch())
```

- [ ] **Step 4: Build the engine + run adapter tests**

Run:
```bash
cd /Users/smlee/projects/product/database/engine
/Users/smlee/sdk/go/bin/go build ./... 2>&1 | head
/Users/smlee/sdk/go/bin/go test ./internal/adapters/... ./internal/transport/... ./internal/domain/... 2>&1 | tail -15
```
Expected: build clean (no output); tests pass (mysql/postgres ExecuteBatch + existing).

- [ ] **Step 5: Commit**

```bash
cd /Users/smlee/projects/product/database
git add engine/internal/ports/connector.go engine/internal/transport/http/query.go engine/cmd/app-engine/main.go
git commit -m "feat(engine): expose ExecuteBatch via SQLConnector + /query/execute-batch route"
```

---

## Task F1: runBatch.ts — mapBatchResult (TDD) + runBatch

**Files:**
- Create: `apps/renderer/src/lib/runBatch.ts`
- Test: `apps/renderer/src/lib/runBatch.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/renderer/src/lib/runBatch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapBatchResult } from './runBatch';

const stmts = ['UPDATE t SET a=1 WHERE id=1', 'INSERT INTO t VALUES (2)'];

describe('mapBatchResult', () => {
  it('maps a successful batch', () => {
    expect(mapBatchResult(stmts, { success: true, data: { ok: true, rowsAffected: 2, failedIndex: -1 } })).toEqual({
      ok: true,
      rowsAffected: 2,
    });
  });
  it('maps a failed batch to the failing statement text', () => {
    expect(
      mapBatchResult(stmts, { success: true, data: { ok: false, rowsAffected: 0, failedIndex: 1, error: 'dup key' } })
    ).toEqual({ ok: false, rowsAffected: 0, failedStatement: 'INSERT INTO t VALUES (2)', error: 'dup key' });
  });
  it('handles an out-of-range failedIndex (no failedStatement)', () => {
    expect(mapBatchResult(stmts, { success: true, data: { ok: false, rowsAffected: 0, failedIndex: 9, error: 'x' } })).toEqual({
      ok: false,
      rowsAffected: 0,
      error: 'x',
    });
  });
  it('maps an IPC-level failure (no data)', () => {
    expect(mapBatchResult(stmts, { success: false, error: 'Engine not started' })).toEqual({
      ok: false,
      rowsAffected: 0,
      error: 'Engine not started',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/renderer && npx vitest run src/lib/runBatch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`apps/renderer/src/lib/runBatch.ts`:

```ts
// Executes a list of statements in a single DB transaction via the engine's
// batch endpoint (all-or-nothing). UI-only adapter + a pure result mapper.

export interface BatchResult {
  ok: boolean;
  rowsAffected: number;
  failedStatement?: string;
  error?: string;
}

interface EngineBatch {
  ok: boolean;
  rowsAffected: number;
  failedIndex: number;
  error?: string;
}

// Map the IPC response (or an IPC-level failure) into a uniform BatchResult.
export function mapBatchResult(
  statements: string[],
  res: { success: boolean; error?: string; data?: EngineBatch }
): BatchResult {
  if (!res.success || !res.data) {
    return { ok: false, rowsAffected: 0, error: res.error || 'Request failed' };
  }
  const d = res.data;
  if (d.ok) return { ok: true, rowsAffected: d.rowsAffected };
  const failedStatement =
    d.failedIndex >= 0 && d.failedIndex < statements.length ? statements[d.failedIndex] : undefined;
  return { ok: false, rowsAffected: d.rowsAffected, failedStatement, error: d.error };
}

export async function runBatch(profileId: string, statements: string[]): Promise<BatchResult> {
  const res = await window.electronAPI.executeBatch(profileId, statements);
  return mapBatchResult(statements, res);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/renderer && npx vitest run src/lib/runBatch.test.ts`
Expected: PASS. (`window.electronAPI.executeBatch` is added in Task F2; tsc for this file runs in F3's typecheck after the type exists. The vitest run only exercises `mapBatchResult`, which is pure.)

- [ ] **Step 5: Commit**

```bash
cd /Users/smlee/projects/product/database
git add apps/renderer/src/lib/runBatch.ts apps/renderer/src/lib/runBatch.test.ts
git commit -m "feat(grid): add runBatch + mapBatchResult"
```

---

## Task F2: IPC — executeBatch (main + preload + types)

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/renderer/src/global.d.ts`

- [ ] **Step 1: main process IPC handler** — in `apps/desktop/src/main/index.ts`, next to the other `ipcMain.handle(...)` handlers (e.g. after `describe-table`), add:

```ts
  ipcMain.handle('execute-batch', async (event, profileId, statements) => {
    try {
      const data = await requestEngine({
        method: 'POST',
        path: '/query/execute-batch',
        body: { profileId, statements, allowWrite: true, confirmDestructive: true },
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
```

- [ ] **Step 2: preload bridge** — in `apps/desktop/src/preload/index.ts`, add to the `electronAPI` object (e.g. after `cancelQuery`):

```ts
  executeBatch: (profileId: string, statements: string[]) =>
    ipcRenderer.invoke('execute-batch', profileId, statements),
```

- [ ] **Step 3: renderer type** — in `apps/renderer/src/global.d.ts`, add to the `electronAPI` interface (near `executeQueryStream`):

```ts
      executeBatch: (
        profileId: string,
        statements: string[]
      ) => Promise<ResultWrapper<{ ok: boolean; rowsAffected: number; failedIndex: number; error?: string }>>;
```

- [ ] **Step 4: Typecheck (renderer) + desktop build**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
cd /Users/smlee/projects/product/database/apps/renderer && npx tsc --noEmit 2>&1 | grep -iE 'error TS' | head || echo "renderer tsc clean"
cd /Users/smlee/projects/product/database/apps/desktop && npx tsc --noEmit 2>&1 | grep -iE 'error TS' | head || echo "desktop tsc clean"
```
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/smlee/projects/product/database
git add apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/renderer/src/global.d.ts
git commit -m "feat(ipc): add executeBatch bridge to engine batch endpoint"
```

---

## Task F3: TableDataView.save → runBatch

**Files:**
- Modify: `apps/renderer/src/components/TableDataView.tsx`

- [ ] **Step 1: Swap the import + save call**

READ the file. Change the import:
```tsx
import { runDdl } from '../lib/runDdl';
```
to:
```tsx
import { runBatch } from '../lib/runBatch';
```
In `save()`, change:
```tsx
    const res = await runDdl(profileId, stmts);
```
to:
```tsx
    const res = await runBatch(profileId, stmts);
```
(Everything else in `save()` stays — `res.ok`, `res.error`, `res.failedStatement` all exist on `BatchResult`.)

- [ ] **Step 2: Typecheck + build + full renderer tests**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
cd /Users/smlee/projects/product/database/apps/renderer
npx tsc --noEmit 2>&1 | grep -iE 'error TS' | head || echo "tsc clean"
npx vitest run 2>&1 | tail -4
npm run build 2>&1 | grep -iE 'built in|error' | tail -1
```
Expected: tsc clean, all tests pass (incl. runBatch), build success.

- [ ] **Step 3: Commit**

```bash
cd /Users/smlee/projects/product/database
git add apps/renderer/src/components/TableDataView.tsx
git commit -m "feat(grid): save inline edits in a single transaction (runBatch)"
```

---

## Task F4: 전체 빌드 + CDP 라이브 검증 (원자성)

**Files:** (없음 — 검증 전용)

- [ ] **Step 1: 엔진 재빌드 + 전체 테스트**

```bash
cd /Users/smlee/projects/product/database
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
pnpm build:engine                      # apps/desktop/bin/app-engine 재생성
/Users/smlee/sdk/go/bin/go test ./engine/... 2>&1 | tail -8   # 또는 cd engine && go test ./...
cd apps/renderer && npx vitest run 2>&1 | tail -3
```
Expected: 엔진 빌드 성공, Go 테스트 green, 렌더러 테스트 green.

> **중요:** 엔진 바이너리가 바뀌었으므로 앱을 **재시작**해야 새 `/query/execute-batch`가 로드된다. 기존 `--remote-debugging-port=9222` 인스턴스 종료 후 새로 기동(개발 실행).

- [ ] **Step 2: CDP 라이브 검증** — dev-mysql `demo_users`로. **검증 후 원복.**

원자성 핵심 시나리오:
1. `demo_users` 더블클릭 → 데이터 뷰.
2. **성공 배치(원자적 커밋)**: 한 셀 수정(예: Carol email → 'c2@x.com') + 행 추가(name='Tx', email='tx@x.com') → 저장 → 미리보기에 UPDATE+INSERT 2문장 → 실행 → 성공, DB에 둘 다 반영 확인. → 원복(추가행 DELETE, email 되돌리기).
3. **실패 배치(원자적 롤백, 핵심)**: 한 셀 수정(예: Alice email → 'rollback-test@x.com') + 행 추가에 **이미 존재하는 PK**를 강제(편집 UI로는 PK가 auto라 어려우니, name 수정 1건 + email 수정 1건을 만든 뒤, 저장 직전 외부에서 무결성 위반을 유발하거나, 더 간단히: **NOT NULL 컬럼에 NULL을 넣는 수정**으로 실패 유도 — 예: `name`을 비워 NULL로 만들면 `name`은 NOT NULL이라 UPDATE 실패). 저장 → 실행 → **에러 표시 + 다른 정상 수정도 롤백되어 DB 무변경** 확인(예: 같은 배치의 다른 행 email 수정이 적용되지 않았는지 DB로 확인).
   - 구체안: 행 A(Alice)의 `email`을 'should-not-apply@x.com'으로 수정 + 행 B(Bob)의 `name`을 빈 값(→NULL, NOT NULL 위반)으로 수정 → 저장 → 배치 실패 → **Alice email이 DB에서 그대로**(롤백됨) 확인.
4. **원복**: dev-mysql `demo_users`를 원래 3행/값으로 복구. 직접 `docker exec dev-mysql mysql ...`로 정리.
5. `/tmp/*.mjs` 정리.

- [ ] **Step 3: 사용자 DB 원상복구 최종 확인**

```bash
docker exec dev-mysql mysql -uroot -ppassword1! -e "SELECT * FROM devdb.demo_users ORDER BY id;" 2>/dev/null
# 원래의 3행/값(Alice/a@x.com, Bob/NULL, Carol/c@x.com)이어야 한다.
```

---

## Self-Review (작성자 체크리스트 — 완료)

- **스펙 커버리지:** 엔진 ExecuteBatch(E1,E2) + 인터페이스/핸들러/라우트(E3) + IPC(F2) + runBatch/mapBatchResult(F1) + save 교체(F3) + 원자성 라이브 검증(F4). DDL 다이얼로그 무변경(F3에서 runDdl 유지). 모두 매핑.
- **플레이스홀더:** 없음.
- **타입 일관성:** `ExecuteBatch(...) (int64, int, error)`(엔진), 응답 `{ok, rowsAffected, failedIndex, error?}`, `mapBatchResult`/`BatchResult`/`runBatch`, IPC `executeBatch` 시그니처가 태스크 간 일치. `save()`는 `BatchResult.ok/error/failedStatement` 사용(기존과 호환).
- **TDD:** E1/E2(Go 통합, red=컴파일 실패→green), F1(`mapBatchResult` red→green). E3/F2/F3은 빌드+CDP로 검증(인터페이스/IPC/와이어링).
