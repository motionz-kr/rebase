# 편집 저장 트랜잭션 (Transactional Edit Save) — 설계

작성일: 2026-06-02

## 1. 목적

인라인 데이터 편집의 "저장"은 여러 UPDATE/INSERT/DELETE 문장을 생성한다. 현재는 `runDdl`이 이를 **하나씩 순차 실행**하고, MySQL/PostgreSQL은 기본 autocommit이라 각 문장이 즉시 커밋된다. 따라서 중간 문장이 실패하면 앞선 문장은 이미 적용된 채 중단되어 **데이터 정합성이 깨진다**.

이 작업은 편집 저장을 **하나의 트랜잭션**으로 묶어 "전부 성공 아니면 전부 취소(롤백)"를 보장한다.

## 2. 범위

- **포함**: 인라인 편집 저장(DML: UPDATE/INSERT/DELETE)을 단일 트랜잭션으로 실행. 대상 방언 MySQL, PostgreSQL.
- **제외**: DDL 다이얼로그(`TableEditDialog`/`CreateTableDialog`/`TableActionDialog`)는 기존 `runDdl`(순차) 유지. MySQL은 DDL이 비트랜잭션(auto-commit)이라 트랜잭션 래핑이 거짓 안전감만 준다. (사용자 결정)
- **제외**: 부분 커밋/세이브포인트, 낙관적 잠금, 충돌 감지 등은 v1 범위 밖.

## 3. 핵심 결정 사항

- 프론트엔드는 트랜잭션을 가로질러 제어할 수 없다(현재 IPC는 호출마다 별도 DB 연결). 따라서 **엔진에 트랜잭션 배치 실행 경로를 새로 추가**한다.
- `BEGIN; ...; COMMIT;`를 한 문자열로 보내는 방식은 제외: 정책 게이트가 다중문장을 `MULTI`로 차단하고, 드라이버가 한 `Exec`에서 다중문장을 지원하지 않는다.
- 배치 실행은 **문장별로** 정책을 분류한다(각 문장은 단일 문장). 이렇게 하면 편집용 DML이 `MULTI`로 오분류되지 않는다.
- 에러는 `failedIndex`(0-based, 성공 시 -1)로 반환해 프론트가 어느 문장에서 실패했는지 표시한다.

## 4. 구성요소

### 4.1 엔진 (Go)

**`internal/ports/connector.go` — `SQLConnector` 인터페이스에 추가**
```go
ExecuteBatch(ctx context.Context, p domain.ConnectionProfile, password string, statements []string) (rowsAffected int64, failedIndex int, err error)
```
- 모든 문장을 하나의 트랜잭션에서 실행.
- 첫 실패 시 `tx.Rollback()` 후 `(누적까지, 실패 인덱스, err)` 반환.
- 전부 성공 시 `tx.Commit()` 후 `(총 rowsAffected, -1, nil)` 반환.

**`internal/adapters/mysql/mysql_adapter.go`, `internal/adapters/postgres/postgres_adapter.go` — 구현**
- 기존 `connectForQuery`(mysql) / `connect`(postgres) 재사용으로 db 열고 `defer db.Close()`.
- `tx, err := db.BeginTx(ctx, nil)`.
- 각 문장 `res, err := tx.ExecContext(ctx, stmt)`; 실패 → `tx.Rollback()`, 실패 인덱스 반환(postgres는 `normalizeError`).
- 성공 → `res.RowsAffected()` 합산, `tx.Commit()`.

**`internal/transport/http/query.go` — 핸들러 `ExecuteBatch()`**
- 요청 `ExecuteBatchRequest { ProfileID string; Statements []string; AllowWrite bool; ConfirmDestructive bool }`.
- `Statements`가 비면 400.
- 각 문장 `domain.ClassifyQuery`로 검사: 하나라도 `!ReadOnly && !AllowWrite` → 403 `read_only_blocked`; `Destructive && !ConfirmDestructive` → 409 `confirmation_required`(기존 `writeQueryPolicyError` 재사용).
- `getConnector(driver).ExecuteBatch(...)` 호출.
- 응답(200) `{ ok: bool, rowsAffected: int64, failedIndex: int, error?: string }`. 실행 에러는 `ok:false`로 본문에 담는다(프론트가 일관 처리).

**`cmd/app-engine/main.go` — 라우트**
```go
mux.Handle("/query/execute-batch", queryHandler.ExecuteBatch())
```

### 4.2 프론트엔드

**IPC (main 프로세스 + preload)**
- `executeBatch(profileId: string, statements: string[]) => Promise<ResultWrapper<{ ok: boolean; rowsAffected: number; failedIndex: number; error?: string }>>` — `/query/execute-batch`에 `allowWrite:true, confirmDestructive:true`로 POST.
- `global.d.ts`에 타입 추가.

**`apps/renderer/src/lib/runBatch.ts` (신규)**
- 순수 매핑 헬퍼 `mapBatchResult(statements, raw)`: 엔진 응답을 `{ ok, rowsAffected, failedStatement?, error? }`로 변환(`failedIndex>=0`이면 `statements[failedIndex]`를 `failedStatement`로). **이 매핑은 TDD.**
- `runBatch(profileId, statements)`: `executeBatch` 호출 후 `mapBatchResult` 적용(IO 얇은 래퍼).

**`apps/renderer/src/components/TableDataView.tsx`**
- `save()`에서 `runDdl(profileId, stmts)` → `runBatch(profileId, stmts)`로 교체. 성공/실패 처리 형태 동일(`.ok`/`.error`/`.failedStatement`).
- DDL 다이얼로그들은 변경하지 않는다.

## 5. 데이터 흐름

```
편집 저장 클릭 → pendingStatements() → 미리보기 → 실행
  → runBatch(profileId, statements)
    → IPC executeBatch → POST /query/execute-batch {statements, allowWrite, confirmDestructive}
      → 엔진: 문장별 정책 검사 → connector.ExecuteBatch
        → BeginTx → 각 문장 ExecContext
          → 실패: Rollback → {ok:false, failedIndex, error}
          → 성공: Commit → {ok:true, rowsAffected, failedIndex:-1}
  → 성공: 보류 비움 + 페이지 재조회 / 실패: 에러 표시(보류 유지) — DB는 롤백되어 무변경
```

## 6. 에러 처리

- 트랜잭션 중 한 문장 실패 → 전체 롤백 → 사용자 데이터 무변경. 프론트는 `실패: <error> / 문장: <failedStatement>` 표시, 보류 변경 유지.
- 정책 위반(쓰기/파괴) → 403/409 구조화 에러(편집은 allowWrite+confirmDestructive를 보내므로 정상 흐름에선 발생하지 않음).
- 연결/네트워크 실패 → `ok:false` + 메시지.

## 7. 테스트

- **엔진 (Go, TDD red→green)**: `ExecuteBatch` 통합 테스트 — dev-mysql 대상.
  - RED: 테스트 작성(메서드 미존재 → 컴파일 실패가 red). 
  - GREEN: 구현 후 통과.
  - 케이스: (a) 유효 INSERT 2개 배치 → 커밋되어 2행 추가; (b) `[유효 INSERT, 잘못된 SQL]` 배치 → 롤백되어 **0행 추가** + `failedIndex==1`. live DB 없으면 `t.Skip`.
- **프론트 (TDD)**: `mapBatchResult` 순수 매핑 단위 테스트(성공/실패+인덱스 매핑/범위 밖 인덱스).
- **CDP 라이브**: 편집 UI에서 (a) 성공 다중 변경 → 원자적 커밋 확인; (b) **일부러 실패하는 배치**(유효 셀 수정 + 중복 PK INSERT) → 에러 표시 + **유효 수정도 롤백되어 변경 0** 확인. **검증 후 dev-mysql `demo_users` 원복.**

## 8. 영향받는 파일

- 엔진: `internal/ports/connector.go`(+메서드), `internal/adapters/mysql/mysql_adapter.go`, `internal/adapters/postgres/postgres_adapter.go`(+구현), `internal/transport/http/query.go`(+핸들러·요청 타입), `cmd/app-engine/main.go`(+라우트), 어댑터 테스트 파일.
- 프론트: `apps/desktop`(main IPC), preload, `apps/renderer/src/global.d.ts`, 신규 `apps/renderer/src/lib/runBatch.ts`(+test), `apps/renderer/src/components/TableDataView.tsx`(save 교체).
- 변경 없음: DDL 다이얼로그들, `runDdl.ts`(계속 DDL 경로에 사용).
