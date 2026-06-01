# UI 기반 테이블/컬럼 편집 (DataGrip 스타일 DDL) — 설계

작성일: 2026-06-01

## 1. 목적

DataGrip의 "Modify Table" 처럼, SQL을 직접 타이핑하지 않고 **UI로 테이블 구조를 편집**한다.
스키마 트리에서 테이블을 우클릭해 컬럼을 추가/삭제/수정/이름변경하고, 테이블을 이름변경/비우기/삭제할 수 있다.
생성될 DDL을 **실행 전에 미리보기**로 보여주고, 사용자가 "실행"을 눌러야 적용한다.

## 2. 범위

### 포함 (v1)
- **컬럼**: 추가 / 삭제 / 수정(타입·NULL 허용·기본값) / 이름 변경
- **테이블**: 삭제(DROP) / 이름 변경(RENAME) / 비우기(TRUNCATE)
- 대상 방언: **MySQL, PostgreSQL** (Redis는 해당 없음)

### 제외 (v1, YAGNI)
- 새 테이블을 빈 화면에서 생성
- 인덱스 / 기본키 / 외래키 / 제약조건 빌더
- FK cascade 옵션, 컬럼 순서 변경(AFTER/FIRST)
- 변경 diff를 모아 한 번에 적용하는 "마이그레이션" 누적 기능 — 다이얼로그는 1회 적용 단위

## 3. 핵심 결정 사항

1. **프론트엔드 전용 구현.** 백엔드(Go) 변경 없음. 근거:
   - `describeTable(profileId, db, table)` → `{ columns: [{name, type, nullable, primaryKey}] }` 로 폼을 채운다.
   - `executeQueryStream(queryId, profileId, sql, { allowWrite: true, confirmDestructive: true })` 가 이미 기존 정책 게이트를 통해 DDL을 실행한다.
   - 방언 분기는 기존 `formatSql`의 `dialectFor(driver)` 패턴과 동일하게 프론트에서 처리한다.
2. **DDL 생성기는 `string[]`(문장 목록)을 반환한다.** Postgres 컬럼 수정은 여러 문장이 필요하고, 엔진 정책 게이트가 `;`로 이어붙인 다중 문장을 `MULTI`로 차단하므로, 실행기는 문장을 **하나씩 순차 실행**한다.
3. **미리보기 후 실행.** 폼 편집 → 실시간 SQL 미리보기 → "실행" 클릭 시 적용.
4. **컬럼 편집 + 테이블 이름 변경을 한 폼에 묶는다** (DataGrip "Modify Table" 다이얼로그와 동일).
5. **파괴적 작업(삭제/비우기) 가드**: SQL 미리보기를 보여주고, **테이블 이름을 정확히 타이핑**해야 확인 버튼이 활성화된다.

## 4. 구성요소

### 4.1 순수 DDL 생성기 — `apps/renderer/src/lib/ddlBuilder.ts` (TDD)

방언 인식. 각 함수는 `string[]`(문장 목록)을 반환한다. 식별자는 방언별로 인용한다(MySQL `` `c` ``, Postgres `"c"`). 인용 시 닫는 인용부호는 이스케이프한다.

| 작업 | MySQL | PostgreSQL |
|---|---|---|
| 컬럼 추가 | `ALTER TABLE t ADD COLUMN c 타입 [NOT NULL] [DEFAULT v]` | 동일 |
| 컬럼 삭제 | `ALTER TABLE t DROP COLUMN c` | 동일 |
| 컬럼 이름 변경 | `ALTER TABLE t RENAME COLUMN a TO b` | 동일 |
| 컬럼 수정 | `ALTER TABLE t MODIFY COLUMN c 타입 [NOT NULL] [DEFAULT v]` (1문장) | `ALTER TABLE t ALTER COLUMN c TYPE 타입`, `... SET/DROP NOT NULL`, `... SET/DROP DEFAULT` (여러 문장, 변경된 항목만) |
| 테이블 이름 변경 | `ALTER TABLE t RENAME TO n` | 동일 |
| 테이블 비우기 | `TRUNCATE TABLE t` | 동일 |
| 테이블 삭제 | `DROP TABLE t` | 동일 |

함수 구성(작고 개별 테스트 가능하게):
- `quoteIdent(driver, name): string`
- `buildAddColumn(driver, table, col): string[]`
- `buildDropColumn(driver, table, colName): string[]`
- `buildRenameColumn(driver, table, oldName, newName): string[]`
- `buildModifyColumn(driver, table, before, after): string[]` (Postgres는 변경된 속성만 문장 생성)
- `buildRenameTable(driver, table, newName): string[]`
- `buildTruncateTable(driver, table): string[]`
- `buildDropTable(driver, table): string[]`
- `buildTableChanges(driver, table, changes): string[]` — "테이블 수정" 폼의 변경 묶음을 순서대로 평탄화

컬럼 모델: `{ name: string; type: string; nullable: boolean; defaultValue?: string }`.
MySQL `MODIFY COLUMN`은 전체 정의를 다시 써야 하므로, 폼은 `describeTable` 결과로 미리 채워 현재 타입을 보존한다.

### 4.2 UI

- **컨텍스트 메뉴 확장** — `apps/renderer/src/components/SchemaExplorer.tsx` (기존 메뉴 [253행](apps/renderer/src/components/SchemaExplorer.tsx#L253)):
  추가 항목 — **컬럼 추가…**, **테이블 수정…**, **테이블 이름 변경…**, **테이블 비우기…**, **테이블 삭제…** (기존 "Show DDL" 유지).
- **`TableEditDialog.tsx`** — "테이블 수정" 모달:
  - 마운트 시 `describeTable`로 현재 컬럼 로드.
  - 컬럼 행 편집: 추가/삭제(표시)/이름변경/타입·NULL·기본값 변경, 테이블 이름 입력.
  - `buildTableChanges`로 생성된 문장의 **읽기 전용 SQL 미리보기** 패널.
  - **실행** 버튼(변경 없거나 식별자 비정상이면 비활성).
  - "컬럼 추가…" 메뉴는 같은 다이얼로그를 새 컬럼 행에 포커스한 상태로 연다.
- **파괴적 확인 다이얼로그** — 삭제/비우기/이름변경 중 파괴적인 것:
  SQL 미리보기 + 테이블 이름 타이핑 확인. 삭제/비우기는 빨간 확인 버튼.

### 4.3 실행 및 새로고침 — `runDdl` 헬퍼

- `runDdl(profileId, statements: string[])`:
  - 각 문장마다 고유 `queryId` 생성 → `onQueryStreamChunk` 구독 → `executeQueryStream(queryId, profileId, sql, { allowWrite: true, confirmDestructive: true })` 호출 → 스트림 종료 청크(done/error)에서 resolve.
  - 순차 실행, **첫 에러에서 중단**하고 어느 문장에서 실패했는지와 엔진 메시지를 반환.
- 결과 처리:
  - 성공 → 다이얼로그 닫기 + `onSchemaChanged()` 호출(트리·자동완성 스키마 재조회).
  - 실패 → 다이얼로그 유지, 엔진 에러 메시지 표시.
- SchemaExplorer는 `driver`(방언 선택용)와 `onSchemaChanged` 콜백 prop을 받는다.

## 5. 데이터 흐름

```
우클릭 → 메뉴 → (테이블 수정… | 컬럼 추가… | 삭제… | …)
  → TableEditDialog (describeTable로 폼 채움)
    → 사용자 편집 → buildTableChanges(driver, table, changes) → string[] → SQL 미리보기
      → 실행 클릭 → runDdl(profileId, statements)  [allowWrite+confirmDestructive, 순차]
        → 성공: onSchemaChanged() (listTables + getSchemaCompletion 재조회) + 닫기
        → 실패: 에러 표시, 다이얼로그 유지
```

## 6. 에러 처리

- 빈/비정상 식별자 → 생성기에서 거르고, 다이얼로그는 실행 버튼 비활성.
- 실행 실패(예: 컬럼 이미 존재, FK 제약으로 DROP 실패) → 엔진 에러 메시지를 다이얼로그에 표시, 닫지 않음.
- 파괴적 작업 → 테이블 이름 정확 입력 전까지 확인 버튼 비활성.
- FK cascade 등은 v1에서 자동 처리하지 않고 DB 에러를 그대로 노출.

## 7. 테스트

- **`ddlBuilder.test.ts`** (TDD, RED 먼저) — 20개 이상:
  - 두 방언 × 각 작업.
  - 식별자 인용/이스케이프.
  - NULL 허용·기본값 조합(있음/없음/문자열/숫자).
  - Postgres 컬럼 수정의 다중 문장(변경된 속성만 생성) 검증.
  - 변경 없음 → 빈 배열.
- **다이얼로그/실행** — `dev-mysql`, `verify-pg`에 대해 CDP로 실제 실행 검증(순수 로직은 단위 테스트, UI는 실제 동작 확인). 컬럼 추가 후 트리·자동완성에 반영되는지 확인.
- **백엔드/Go 변경 없음.**

## 8. 영향받는 파일

- 신규: `apps/renderer/src/lib/ddlBuilder.ts`, `apps/renderer/src/lib/ddlBuilder.test.ts`, `apps/renderer/src/components/TableEditDialog.tsx`, `runDdl` 헬퍼(`apps/renderer/src/lib/runDdl.ts`).
- 수정: `apps/renderer/src/components/SchemaExplorer.tsx`(메뉴·prop), 호출부(App에서 `driver`·`onSchemaChanged` 전달), `App.css`(다이얼로그 스타일).
- 변경 없음: 엔진(Go) 전체.
