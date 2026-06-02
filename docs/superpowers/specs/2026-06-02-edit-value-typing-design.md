# 편집 값 타입 & NULL 처리 — 설계

작성일: 2026-06-02

## 1. 목적

인라인 데이터 편집의 두 가지 v1 한계를 해소한다:
1. **타입 미인식** — 숫자/불리언 컬럼도 모두 `'...'` 문자열 리터럴로 전송되어 DB의 암시적 캐스트에 의존(예: `WHERE id = '5'`, `SET active = '0'`).
2. **NULL vs 빈 문자열 구분 불가** — 셀을 비우면 무조건 NULL이 되고, 빈 문자열 `''`은 입력할 수 없음.

이 작업으로 컬럼 타입에 맞는 SQL 리터럴을 생성하고, 명시적 NULL과 빈 문자열을 분리한다.

## 2. 범위

- **포함**: 인라인 셀 편집과 새 행 INSERT에서 컬럼 타입에 따른 값 변환(숫자/불리언은 unquoted, 그 외 인용). 셀 에디터의 명시적 NULL 버튼. 빈 입력 = 빈 문자열.
- **제외**: 새 행 셀의 별도 NULL 버튼(빈 칸 = DB 기본값/NULL로 충분). 전용 날짜/불리언 위젯(텍스트 입력 유지). 엔진(Go) 변경.

## 3. 핵심 결정 사항

- 컬럼 타입은 이미 `describeTable`이 제공한다(`ColumnInfo.type`). 현재 `TableDataView`가 이름만 저장하고 타입을 버리므로, **타입을 보존**해 편집/삽입 시 활용한다.
- **NULL은 셀 에디터의 'NULL' 버튼으로만** 설정한다. **텍스트를 비우면 빈 문자열 `''`** (사용자 결정).
- 날짜/시간/JSON/UUID 등은 SQL에서 인용 문자열 리터럴이므로 `string` 범주로 둔다(특수 처리 없음).
- `sqlLiteral`/`buildUpdate`/`buildInsert`는 이미 `number`/`boolean`/`null`을 분기하므로 **변경하지 않는다**. 올바른 타입의 `CellValue`만 넣어주면 된다.

## 4. 구성요소

### 4.1 순수 로직 — `apps/renderer/src/lib/cellTypes.ts` (신규, TDD)

```ts
export type CellCategory = 'number' | 'boolean' | 'string';

export function classifyColumnType(sqlType: string): CellCategory;
export function coerceCellValue(category: CellCategory, text: string): CellValue;
```

- `classifyColumnType`: 소문자화 + `(...)` 파라미터 제거 후 베이스 타입으로 분류.
  - **number**: `int`, `integer`, `smallint`, `mediumint`, `bigint`, `tinyint`, `decimal`, `numeric`, `dec`, `fixed`, `float`, `double`, `double precision`, `real`, `serial`, `bigserial`, `smallserial`.
  - **boolean**: `bool`, `boolean`.
  - **string**: 그 외 전부(`varchar`, `char`, `text`, `date`, `datetime`, `timestamp`, `time`, `json`, `jsonb`, `uuid`, `bytea`, `enum`, …).
- `coerceCellValue`:
  - `number`: `text.trim() !== ''` 이고 `Number(text)`가 유한하면 `Number(text)`, 아니면 `text`(문자열 — DB가 거부).
  - `boolean`: 소문자 trim이 `true/1/t/yes` → `true`, `false/0/f/no` → `false`, 아니면 `text`.
  - `string`: `text` 그대로.
- `CellValue`는 `lib/dmlBuilder.ts`에서 import(`string | number | boolean | null`).

### 4.2 `TableDataView.tsx`

- **상태**: `colTypes: string[]` 추가. `describeTable` 로드 시 `setColTypes(cols.map((c) => c.type))` (columns와 동일 인덱스 순서; `SELECT *` 결과 컬럼 순서와 일치).
- **편집 커밋**: `commitEdit()`에서 `editText === '' ? null : editText` 대신:
  ```ts
  const cat = classifyColumnType(colTypes[c] ?? '');
  const value = coerceCellValue(cat, editText); // 빈 텍스트 → 문자열 컬럼이면 ''
  ```
  새 함수 `commitNull(r, c)` → 해당 셀 edit 값을 `null`로 설정 후 에디터 닫기.
- **셀 에디터 UI**: 편집 중인 셀(`.grid-cell.editing`)에 입력란 + **`∅ NULL` 버튼**. 버튼 클릭 → `commitNull`. (NULL로 커밋된 보류 셀은 `cellText(null)='NULL'` + dirty 스타일로 표시되어 자연히 구분됨.)
- **새 행 INSERT**: `pendingStatements`의 insert 빌드에서 각 채워진 셀을 `coerceCellValue(classifyColumnType(colTypes[c] ?? ''), nr[c])`로 변환해 `buildInsert`에 전달. 빈 셀은 기존대로 생략(DB 기본값/NULL).
- PK WHERE(`pkOf`)는 기존 `asCell(rows[r][...])` 유지(원본 DB 값은 JSON 숫자/문자열로 들어와 대체로 올바른 타입; 변경 불필요).

### 4.3 CSS — `App.css`

- `∅ NULL` 버튼 스타일(셀 에디터 내, 작게). 기존 `.grid-cell.dirty` / `.grid-cell.null` 재사용으로 NULL 표시.

## 5. 데이터 흐름

```
셀 더블클릭 → 입력 + [∅ NULL] 버튼
  → Enter/blur: value = coerceCellValue(classifyColumnType(colTypes[c]), editText)
  → [∅ NULL]:  value = null
  → edits[r][c] = value (dirty)
저장 → pendingStatements (updates: edits 값 그대로; inserts: 타입별 coerce)
  → buildUpdate/buildInsert → sqlLiteral (number/boolean unquoted, string 인용, null→NULL)
  → runBatch (단일 트랜잭션)
```

## 6. 에러 처리

- 숫자 컬럼에 비숫자 입력 → 문자열로 전송되어 DB가 거부 → 기존 배치 에러 표시(보류 유지). 사용자가 정정.
- 빈 입력 = 빈 문자열. NULL이 필요하면 NULL 버튼.

## 7. 테스트

- **`cellTypes.test.ts`** (TDD): `classifyColumnType`(int/bigint/decimal/float/tinyint→number, bool/boolean→boolean, varchar/text/date/datetime/json→string, 파라미터 `varchar(80)`·`decimal(10,2)` 처리), `coerceCellValue`(숫자 유효/무효, 불리언 변형, 문자열, 빈 문자열).
- **CDP 라이브**(dev-mysql `demo_users`: id int, name varchar NOT NULL, email varchar nullable, active tinyint nullable):
  - `active`(숫자) `1→0` 수정 → 미리보기 **`SET \`active\` = 0`(unquoted)**.
  - `email` → **NULL 버튼** → **`SET \`email\` = NULL`**.
  - `email` → 빈 입력 → **`SET \`email\` = ''`**(빈 문자열).
  - 각 저장 후 DB 확인, **검증 후 원복**.
- **백엔드 변경 없음.**

## 8. 영향받는 파일

- 신규: `apps/renderer/src/lib/cellTypes.ts`(+test).
- 수정: `apps/renderer/src/components/TableDataView.tsx`(colTypes 보존, commit coerce, NULL 버튼, insert coerce), `apps/renderer/src/App.css`(NULL 버튼 스타일).
- 변경 없음: `lib/dmlBuilder.ts`, `lib/runBatch.ts`, 엔진 전체.
