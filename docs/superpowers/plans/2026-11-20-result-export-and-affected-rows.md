# 결과 내보내기 실패 · 반영 행 수 안 보이는 문제 수정 (2026-11-20)

브랜치: `fix/rebase-excel-download-affected-rows`

## 사용자 증상

1. 쿼리 결과(응답)를 파일(엑셀)로 내려받지 못한다.
2. UPDATE·COMMIT 등을 실행하면 `Statement executed. Rows affected: 0` 만 보여 실제 반영 행 수를 알 수 없다.

## 조사 결과 (2026-11-20 사용자 실행 이력 기준)

`~/.antigravity/metadata.db` 의 `query_history` 를 보면 16:58 에 한 번에 실행한 묶음은 아래와 같다.

| 순서 | 문장 | 엔진이 돌려준 값 |
|---|---|---|
| 1 | `-- 주석 … START TRANSACTION` | 0 |
| 2 | `UPDATE … (116건)` | **116** |
| 3 | `SELECT ROW_COUNT() AS changed_rows` | 1행 |
| 4 | `-- 116 이어야 한다 / -- COMMIT; / -- ROLLBACK;` (주석만 있는 조각) | 0 |

이어서 `COMMIT` 단독 실행 → 0.

- 엔진(MySQL)은 UPDATE 반영 수 116 을 정상으로 돌려준다.
- 여러 문장 실행이 끝나면 `QueryEditor.tsx` 가 `activeResultIndex: 0` 으로 되돌려 **1번(START TRANSACTION, 0)** 결과를 띄운다. 116 은 `Result 2` 칩에만 있다.
- 실행 상태줄(`ExecStatusBar`)은 여러 문장 실행 때 `rowsAffected: null` 로 두어 SELECT 행 수만 보인다.
- `splitStatementRanges` 는 주석만 있는 조각도 문장으로 보내 의미 없는 `Rows affected: 0` 결과를 하나 더 만든다.
- COMMIT·ROLLBACK 은 원래 영향 행이 0 이라 "이 트랜잭션에서 몇 행이 반영됐는지"를 알려 줄 방법이 없다.
- MySQL 은 값이 실제로 바뀐 행만 센다(11-18 `DoctorHolidaySetting` 재실행 916 → 0). 0 이 나와도 이유를 알려 주지 않는다.
- 별도 결함: Postgres `ExecuteQueryStream`(세션 없는 실행)은 항상 `QueryContext` 로 돌려 받은 행을 세므로 RETURNING 없는 UPDATE/DELETE/INSERT 는 늘 0 이다. MySQL·세션 경로는 `adapters.ExecuteSessionQuery` 로 `RowsAffected()` 를 쓴다.
- 결과 내보내기: 사용자는 16:55 116행 SELECT 결과를 파일로 받으려다 실패해 TSV 를 따로 만들었다. 내보내기는 `ResultGrid` 의 `내보내기 ▾ → CSV/JSON` 이고 `gridFormat.download()` 가 blob URL 을 만든 직후 같은 틱에 `revokeObjectURL` 한다. Electron 쪽 `will-download` 처리는 없다. 원인은 E2E 로 재현해 확정한다.
  - **확정(2차)**: React 19 가 이산 이벤트의 passive effect 를 동기로 flush 해서, `ResultGrid` 의 바깥 클릭 `window` 리스너가 메뉴를 연 같은 클릭에서 등록되어 메뉴를 즉시 닫는다(메뉴가 같은 클릭 안에서 추가·제거됨). blob 다운로드 자체는 정상이다. 수정: `.grid-export` 안쪽 클릭은 무시.

## 작업

### A. 결과 내보내기 (원인 재현 → 수정)
1. SQLite E2E 로 쿼리 결과 → `내보내기 ▾` → `CSV` 클릭 시 파일이 실제로 저장되는지 재현한다. 실패 지점(클릭 미도달 / 다운로드 미발생 / 저장 대화상자 / blob 해제)을 증거로 확정한다.
2. 확정한 원인을 고친다. `ResultGrid`·`TableDataView`·`TemplateRunner` 가 같은 저장 경로를 쓰게 한다.
3. CSV 앞에 UTF-8 BOM 을 붙여 엑셀에서 한글이 깨지지 않게 한다(`toCsv` 순수 함수는 그대로 두고 저장 단계에서 붙인다).

### B. 반영 행 수 표시
1. `splitStatementRanges`: 주석·공백만 있는 조각은 문장으로 내보내지 않는다. `/*! … */`(MySQL 실행 주석)·`/*+ … */` 는 남긴다. (TDD)
2. 여러 문장 실행 요약: 순수 모듈 `lib/resultSummary.ts` — 문장 수, 변경 행 합계(쓰기 문장의 rowsAffected 합), 조회 행 합계, 기본 선택 결과(첫 오류 → 없으면 트랜잭션 제어문이 아닌 마지막 결과). (TDD)
   - 결과 영역 위에 `N개 문장 · 변경 116행 · 조회 1행` 요약을 보인다.
   - 결과 칩에 문장 종류를 붙인다(예: `2 UPDATE · 116행 변경`, `1 START TRANSACTION`).
   - 실행이 끝나면 기본 선택 결과로 이동한다.
3. `ExecStatusBar`: 조회 행과 변경 행을 함께 보인다. 여러 문장 실행은 변경 행 합계를 넘긴다.
4. 수동 트랜잭션 반영 대기 집계: 탭별로 열린 트랜잭션 안에서 실행한 쓰기 문장의 rowsAffected 를 누적한다.
   - 트랜잭션 표시줄에 `커밋 대기 변경 116행` 을 보인다.
   - COMMIT(문장·버튼) 결과는 `커밋 완료 · 이 트랜잭션에서 116행 반영`, ROLLBACK 은 `롤백 완료 · 116행 변경 취소` 로 보인다.
   - 커밋·롤백·세션 폐기 때 0 으로 되돌린다.
5. MySQL/MariaDB 에서 UPDATE 가 0 이면 "값이 실제로 바뀐 행만 셉니다(조건에 맞아도 같은 값이면 0)" 안내를 붙인다.
6. 엔진: Postgres `ExecuteQueryStream` 도 `adapters.ExecuteSessionQuery` 로 실행해 쓰기 문장의 `RowsAffected()` 를 돌려준다. SQL Server·SQLite 의 같은 경로도 확인한다. (adapter 테스트)

## 검증
- vitest(renderer), `go test ./...`(engine), 관련 E2E(내보내기 신규, 여러 문장 요약, MySQL 트랜잭션 집계 — 로컬 3306 없으면 skip).
- E2E 쓰기는 일회용 `e2e_*` 테이블에서만 한다.
- 교차 검증: Codex 리뷰.

## 범위 밖
- `.xlsx` 형식 내보내기(의존성 추가 필요) — 필요하면 별도 작업.

## 엔진 알려진 제한 (2차 리뷰 반영)
- Postgres·SQLite 의 세션 없는 `ExecuteQueryStream` 은 `adapters.IsPlainDMLWrite`(단일 INSERT/UPDATE/DELETE/REPLACE/MERGE, `WITH … <DML>` 포함, RETURNING/OUTPUT 없음)일 때만 `ExecContext` 로 `RowsAffected()` 를 돌려준다. 그 밖의 문장(EXEC, DECLARE, PREPARE/EXECUTE, 다중 문장 등)은 기존 `QueryContext` 행 스트리밍을 그대로 쓴다.
- **SQL Server 는 변경하지 않았다.** T-SQL 배치(`UPDATE t SET a=1 SELECT @@ROWCOUNT`)는 맨 앞이 UPDATE 여도 결과 집합이 따라올 수 있어 안전하게 구분할 수 없다. 그래서 세션 없는 SQL Server 의 DML 은 여전히 `Rows affected: 0` 으로 보일 수 있다(알려진 제한).
- MySQL·세션 경로(`ExecuteSessionQuery`)는 그대로다.
- 커밋 대기 집계: MySQL DDL 의 암묵 커밋은 엔진이 돌려주는 `transactionState`(`idle`)를 기준으로 하고(`sqlsession.mysqlImplicitCommit`), 열린 트랜잭션 안의 `START TRANSACTION`/`BEGIN` 은 엔진이 `active` 를 유지하므로 렌더러가 mysql 드라이버일 때만 집계를 0 으로 되돌린다. SAVEPOINT 별로 집계를 저장하고 `ROLLBACK TO` 로 복원한다.
