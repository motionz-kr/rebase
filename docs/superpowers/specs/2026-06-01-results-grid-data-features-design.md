# 결과 그리드 데이터 기능 (편집·내보내기·복사·정렬/필터·페이지네이션·테이블 데이터 뷰) — 설계

작성일: 2026-06-01

## 1. 목적

DataGrip 기본기 중 비어 있는 "데이터를 보고 그 자리에서 다루는" 경험을 채운다. 6개 기능을 한 설계 아래 3단계로 구현한다:

1. 인라인 데이터 편집(셀 수정·행 추가/삭제)
2. 결과 내보내기(CSV/JSON)
3. 그리드 복사(TSV)
4. 정렬/필터
5. 페이지네이션
6. 테이블 더블클릭 → 데이터 바로 열기

## 2. 핵심 아키텍처 결정

- **두 종류의 그리드로 분리한다.**
  - **쿼리 결과 그리드**(임의 `SELECT`): 행 식별자/PK를 알 수 없으므로 **읽기 전용**. 내보내기·복사·클라이언트 정렬/필터만.
  - **테이블 데이터 뷰**(테이블 더블클릭, `SELECT *` 기반): 테이블명·컬럼·PK를 알므로 **서버 페이지네이션·정렬·필터 + 인라인 편집**.
- **편집은 테이블 데이터 뷰에서만** 허용한다(사용자 결정). 임의 쿼리 결과는 편집 불가.
- **PK 없는 테이블의 데이터 뷰는 읽기 전용 + 안내**(사용자 결정). 고유 키가 없으면 행을 안전하게 지목할 수 없기 때문.
- **백엔드(Go) 변경 없음.** 페이지네이션/정렬/필터는 `executeQueryStream`에 다른 SQL(LIMIT/OFFSET/ORDER BY/WHERE)을 보내는 것이고, 편집은 `describeTable`(PK 제공) + 기존 쓰기 경로(`runDdl`)로 처리한다.
- **순수 로직은 분리해 TDD**한다(`gridExport`, `dmlBuilder`, 정렬/필터 헬퍼). 그리드/뷰/편집 UI는 CDP 실제 검증.

## 3. 기존 코드 기준점

- `apps/renderer/src/components/VirtualizedGrid.tsx` — `{ columns: string[], rows: any[][] }`만 받는 순수 표시용. 정렬/필터/편집/선택 없음.
- `apps/renderer/src/components/QueryEditor.tsx` — 연결별 쿼리 탭, 결과(rows/columns/rowsAffected/truncated/rowLimit) 보유. `executeQueryStream(queryId, profileId, sql, { allowWrite, confirmDestructive, maxRows, fetchAll })` 사용. 청크: `meta`/`row`/`policy`/`done`/`error`.
- `apps/renderer/src/lib/runDdl.ts` — 문장 배열을 allowWrite로 순차 실행(편집 저장에 재사용).
- `apps/renderer/src/lib/ddlBuilder.ts` — `quoteIdent(driver, name)`(방언별 식별자 인용) 재사용.
- `window.electronAPI.describeTable(profileId, db, table)` → `{ columns: [{ name, type, nullable, primaryKey }] }`.
- App 메인 패널은 연결별로 `RedisValueInspector` 또는 `QueryEditor`를 렌더.

---

## Phase 1 — 결과 그리드 읽기측 기능

기존 쿼리 결과 그리드(임의 SELECT 결과)에 적용. 테이블 데이터 뷰(Phase 2)도 동일 컴포넌트를 재사용한다.

### 1.1 내보내기 (기능 2) — `apps/renderer/src/lib/gridExport.ts` (TDD)
- `toCsv(columns: string[], rows: unknown[][]): string` — RFC4180 식. 값에 `,`·`"`·개행 포함 시 `"`로 감싸고 내부 `"`는 `""`로 이스케이프. `null` → 빈 문자열. 객체 → `JSON.stringify`.
- `toJson(columns: string[], rows: unknown[][]): string` — 행을 `{컬럼: 값}` 객체 배열로 만들어 `JSON.stringify(_, null, 2)`. `null`은 그대로 `null`.
- UI: 그리드 푸터/툴바에 "내보내기 ▾" → CSV / JSON. 브라우저 다운로드(Blob + `a[download]`), 파일명 `result-YYYYMMDD-HHMMSS.csv`(타임스탬프는 호출부에서 생성).

### 1.2 복사 (기능 3)
- 그리드에 셀/행 선택 상태 추가: 셀 클릭 → 단일 셀 선택, 행 인덱스(`#`) 클릭 → 행 전체 선택, Shift+클릭 → 직사각형 범위(셀) / 연속 행.
- `Cmd/Ctrl+C` → 선택 영역을 **TSV**(탭 구분, 행 개행)로 클립보드 복사(`navigator.clipboard.writeText`). 다중 셀은 행×열 TSV. `null` → 빈 문자열.
- 순수 헬퍼 `toTsv(selectionGrid: unknown[][]): string`(TDD).

### 1.3 정렬 (기능 4, 클라이언트)
- 컬럼 헤더 클릭 → 해당 컬럼 기준 정렬 토글: 오름차순 → 내림차순 → 원본(3-state). 헤더에 ▲/▼ 표시.
- 로드된 행만 대상(클라이언트). 순수 비교 헬퍼 `sortRows(rows, colIndex, dir)`(TDD): 숫자/문자/`null` 혼재 안전 비교(`null`은 마지막, 숫자 우선 비교).

### 1.4 빠른 필터 (기능 4, 클라이언트)
- 그리드 툴바에 텍스트 입력. 입력 문자열을 모든 셀 문자열 표현에 대소문자 무시 부분일치로 필터(로드된 행 대상). 순수 `filterRows(rows, query)`(TDD).

### 1.5 그리드 컴포넌트 변경
- `VirtualizedGrid`를 확장하거나 래퍼 `ResultGrid`를 둔다: 정렬/필터/선택 상태와 툴바(필터 입력·내보내기·선택 복사 안내)를 포함. 가상화는 유지. 표시 행 = 필터→정렬 파이프라인을 거친 결과.
- `QueryEditor`의 결과 영역이 새 `ResultGrid`를 쓰도록 교체(읽기 전용 모드).

---

## Phase 2 — 테이블 데이터 뷰

### 2.1 열기 (기능 6)
- 스키마 트리에서 테이블 행 **더블클릭** → 데이터 뷰 열기. (기존 단일클릭=컬럼 펼치기, 우클릭=컨텍스트 메뉴는 유지.)
- App에 연결별 `openTableData[connId]: { db, table } | null` 상태. 설정되면 메인 패널에 `QueryEditor` 대신 `TableDataView`를 렌더. 뷰 상단에 "쿼리로 돌아가기/닫기" 버튼(상태 해제).

### 2.2 `TableDataView` 컴포넌트
- 마운트 시 `describeTable`로 컬럼·PK 로드.
- 데이터 조회: `SELECT * FROM <qt> [WHERE ...] [ORDER BY ...] LIMIT <size> OFFSET <n>` 를 `executeQueryStream`(읽기)로 실행해 페이지 단위로 그리드에 표시. 쿼리 빌드는 순수 `buildSelectPage(driver, table, { where, orderBy, limit, offset })`(TDD, 식별자 인용).
- **페이지네이션** (기능 5): 페이지 크기(기본 200), 이전/다음, "페이지 n" 표시. (총 행수 카운트는 선택: `SELECT COUNT(*)`는 큰 테이블에서 느릴 수 있어 v1은 "다음 페이지 존재 여부"만 — pageSize+1 조회로 판단.)
- **서버측 정렬** (기능 4): 헤더 클릭 → `ORDER BY <col> ASC|DESC` 설정 후 offset 0부터 재조회.
- **서버측 필터** (기능 4): 컬럼별 필터 입력(헤더 아래 행) → 각 입력을 `<col> LIKE '%v%'`(부분일치) 조건으로 만들어 `AND`로 결합한 `WHERE`로 재조회. 값의 `'`·`%`·`_`는 이스케이프. 순수 `buildWhere(driver, filters)`(TDD).
- Phase 1의 그리드 표시·내보내기·복사 재사용.

---

## Phase 3 — 인라인 데이터 편집 (기능 1)

테이블 데이터 뷰에서만. PK 있는 테이블에서만 활성(없으면 읽기 전용 + "고유 키가 없어 편집할 수 없음" 안내).

### 3.1 편집 상호작용
- 셀 더블클릭 → 인라인 입력으로 편집. 변경된 셀은 **보류(dirty)** 로 하이라이트.
- **행 추가**: 빈 행을 그리드 하단에 추가(보류 INSERT).
- **행 삭제**: 행 선택 → 삭제 표시(보류 DELETE, 취소선).
- 보류 변경은 메모리에만. "되돌리기"로 개별/전체 취소.

### 3.2 DML 생성 — `apps/renderer/src/lib/dmlBuilder.ts` (TDD)
- `buildUpdate(driver, table, pk: {col,value}[], changes: {col,value}[]): string`
- `buildInsert(driver, table, cols: {col,value}[]): string`
- `buildDelete(driver, table, pk: {col,value}[]): string`
- 값 리터럴 방언별 이스케이프 `sqlLiteral(driver, value)`: 문자열 `'`→`''` 후 작은따옴표로 감쌈, `null`→`NULL`, 숫자→그대로, boolean→`TRUE/FALSE`(pg)·`1/0`(mysql). 식별자는 `quoteIdent` 재사용.
- 보안 메모: 로컬 개발 도구로 사용자 자신의 DB에 대해 동작하며, 값은 이스케이프 후 리터럴로 삽입(에디터가 이미 임의 SQL을 실행하는 것과 동일 수준). 파라미터 바인딩은 v1 범위 밖.

### 3.3 저장
- "저장" 클릭 → 보류 변경을 문장 목록으로 변환(DELETE → UPDATE → INSERT 순서 권장) → 미리보기 → `runDdl(profileId, statements)`(allowWrite) 순차 실행.
- 성공 → 현재 페이지 재조회(서버 상태 반영) + 보류 비움. 실패 → 어느 문장에서 실패했는지 + 엔진 에러 표시, 보류 유지.

---

## 4. 에러 처리

- 내보내기/복사: 빈 결과면 비활성. 클립보드 실패 시 토스트/알림.
- 페이지네이션/정렬/필터 조회 실패: 엔진 에러를 뷰에 표시, 이전 데이터 유지.
- 편집 저장 실패: 위 3.3. 잘못된 값/제약 위반은 엔진 에러 그대로 노출.
- PK 없는 테이블: 편집 UI 비활성 + 안내 배지.

## 5. 테스트

- **순수 로직 TDD**: `gridExport`(toCsv/toJson/toTsv), `sortRows`/`filterRows`, `buildSelectPage`/`buildWhere`, `dmlBuilder`(update/insert/delete + sqlLiteral 이스케이프, 두 방언, null/숫자/문자/boolean).
- **CDP 실제 검증**: `dev-mysql`·`verify-pg`에 대해 — 내보내기 결과 문자열, 복사 클립보드, 정렬/필터, 테이블 더블클릭→데이터 뷰, 페이지네이션, 셀 편집·행 추가/삭제→저장→DB 반영. **사용자 DB(dev-mysql)는 검증 후 원상복구**, 내 컨테이너만 정리.
- **백엔드/Go 변경 없음.**

## 6. 영향받는 파일 (단계별)

- Phase 1: 신규 `lib/gridExport.ts`(+test), `lib/gridView.ts`(sortRows/filterRows, +test); 신규/확장 `components/ResultGrid.tsx`(VirtualizedGrid 기반); 수정 `components/QueryEditor.tsx`(결과 영역 교체), `App.css`.
- Phase 2: 신규 `components/TableDataView.tsx`, `lib/tableQuery.ts`(buildSelectPage/buildWhere, +test); 수정 `components/SchemaExplorer.tsx`(더블클릭), `App.tsx`(openTableData 상태·렌더 분기), `App.css`.
- Phase 3: 신규 `lib/dmlBuilder.ts`(+test); 수정 `components/TableDataView.tsx`(편집·보류·저장), `App.css`.
- 변경 없음: 엔진(Go) 전체, 기존 DDL 다이얼로그들.

## 7. 구현 순서

Phase 1 → 2 → 3 순서로 각 단계를 독립적으로 구현·검증·커밋한다. 각 단계는 그 자체로 동작하는 소프트웨어를 만든다(Phase 1만으로도 결과 내보내기/복사/정렬/필터가 동작).
