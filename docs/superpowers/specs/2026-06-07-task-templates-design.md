# 반복 DB 업무 자동화 템플릿 (Task Automation Templates) — 설계

> Issue: #105 · Epic #107 · Milestone #8 (DB Tool v1)
> Date: 2026-06-07
> Direction: **full** — 범용 템플릿 + 의미 역할(semantic role) 바인딩 (사용자 선택)

## 배경 / 목표

운영·CS·QA 업무에는 반복되는 조회 패턴이 많다(병원 환자 조회, phone/chartNumber 중복
확인, 내원 이력, 메시지 발송 이력, 병원별 최근 내원 수 등). 매번 SQL을 새로 쓰는 대신,
자주 쓰는 업무를 **템플릿화**하고 사용자는 **필요한 값만 입력**해 실행한다.

**설계 철학(브레인스토밍 확정):** 리비짓 도메인을 하드코딩하지 않는다. 빌트인 템플릿은
*범용·역할 기반*이고, 각 연결(스키마)마다 사용자가 **역할 → 실제 테이블/컬럼**을 한 번
매핑하면(자동 추천으로 마찰 완화) 범용 템플릿이 그 도메인에 맞게 동작한다. 이로써
"phone 기준 중복 환자 조회"는 *범용 '컬럼 기준 중복 행 찾기' 템플릿 + 도메인 바인딩*으로
표현된다.

> **설계 시 인지한 리스크(정직한 기록):** 역할 바인딩은 단일 스키마 사용자에게 설정
> 마찰을 줄 수 있다. 이를 **자동 추천 바인딩**으로 완화하고, 빌트인은 소수의 강력한
> 범용 템플릿으로 한정한다(YAGNI). 일상 가치의 핵심은 *파라미터 폼이 SQL 편집보다
> 빠르고, 결과가 후속 액션으로 이어지는 것*이다.

## 핵심 결정 (확정)

1. **빌트인 = 범용·역할 기반**(렌더러 정적), 리비짓 특화는 사용자 커스텀 템플릿으로.
2. **도메인 설정 = 연결별 역할→테이블/컬럼 바인딩**(introspection 드롭다운 + 자동 추천).
3. **후속 액션 v1 = 핵심 세트**: CSV 다운로드 · 요약 문장(일반/Slack/Jira 포맷, AI 설정 시
   풍부화) · SQL 에디터에서 열기.

## 아키텍처 개요

```
[Templates 사이드바 탭] ── 카테고리별 목록(빌트인+사용자)
        │ 선택
        ▼
[TemplateRunner 메인 페인]
  파라미터 폼(역할 기본값 프리필) ──► renderTemplate(순수) ──► 안전 치환된 SQL
        │ 실행                                  │
        ▼                                       │ (도메인 바인딩 + 값/식별자/enum)
  기존 executeQueryStream (안전 실행 모드 게이트 그대로)
        ▼
  ResultGrid + 후속 액션 바 (CSV · 요약복사 · 에디터에서 열기)

[도메인 설정 다이얼로그] ─ 역할→컬럼 매핑(자동추천) ─► profile.domainBindings (engine)
[커스텀 템플릿 저장 다이얼로그] ─► engine templates 테이블
```

- 빌트인 템플릿은 **코드(렌더러 정적)** — 시드/마이그레이션 불필요, 읽기 전용.
- 사용자 커스텀 템플릿은 **엔진 SQLite**(`saved_queries` 패턴 재사용).
- 도메인 바인딩은 **연결 프로필의 JSON 컬럼**(safeMode/tenantColumns와 동일 방식).
- 치환은 **렌더러 순수 함수**(테스트 용이) → 최종 SQL을 기존 실행 경로로.

## 컴포넌트 설계

### A. 템플릿 렌더링 문법 + 엔진 (`templateRender.ts`, 순수, TDD)

템플릿 SQL은 4종 자리표시자를 쓴다:

| 문법 | 의미 | 치환 |
|------|------|------|
| `:name` | **값 파라미터** | `sqlLiteral(driver, coerce(input, valueType))` (이스케이프) |
| `{{name}}` | **식별자 파라미터**(테이블/컬럼) | 실제 스키마에 존재하는 값만 허용 후 `quoteIdent(driver, …)` |
| `{{role:NAME}}` | **연결 역할 바인딩** | 도메인 바인딩에서 컬럼명 조회 후 `quoteIdent` |
| `[[ … ]]` | **선택 블록** | 내부 자리표시자가 모두 해결되면 포함, 하나라도 미해결/빈값이면 블록 전체 생략 |

선택 블록이 범용 템플릿의 핵심이다 — tenant가 바인딩 안 됐거나 값이 비면 해당 WHERE 절을
자동 생략한다.

```ts
interface RenderInput {
  driver: Driver;                       // mysql|postgres|sqlite|sqlserver
  params: Record<string, ParamValue>;   // {name: {kind, valueType?, value, validIdentifier?}}
  roles: Record<string, string>;        // {role: columnName} (연결 domainBindings)
}
interface RenderResult {
  sql: string;
  missingRequired: string[];            // 채워지지 않은 required 파라미터/역할
}
function renderTemplate(rawSql: string, def: TemplateDef, input: RenderInput): RenderResult
```

**안전성:**
- 값 → 항상 `sqlLiteral` 이스케이프(따옴표 doubling, dialect 인지). 기존 `dmlBuilder.sqlLiteral` 재사용.
- 식별자 → 반드시 introspection 컬럼/테이블 목록에 존재(대소문자 무시) 검증 후 `quoteIdent`. 미존재 시 렌더 거부. (렌더러 `quoteIdent`는 엔진 `analyzer.QuoteIdent` 미러 — 신규 `sqlIdent.ts`.)
- enum → 옵션이 `sqlFragment`(작성자 신뢰, 그대로 삽입) 또는 `value`(리터럴) 제공. 사용자 자유 입력 아님.
- 선택 블록 생략으로 "조건 없는 전체 변경" 위험 없음(템플릿은 SELECT 위주, 게이트도 적용).

### B. 파라미터 모델 + 빌트인 템플릿 (`builtinTemplates.ts`)

```ts
type ParamKind = 'value' | 'identifier' | 'enum';
interface TemplateParam {
  name: string;            // 자리표시자 키
  label: string;
  kind: ParamKind;
  valueType?: 'string' | 'number' | 'date' | 'boolean'; // kind=value
  identifierKind?: 'table' | 'column';                  // kind=identifier
  role?: string;           // 기본값을 도메인 바인딩에서 프리필(주로 value의 tenant 값 등)
  required?: boolean;
  default?: string;
  options?: { label: string; value?: string; sqlFragment?: string }[]; // kind=enum
}
interface TemplateDef {
  id: string; name: string; description: string; category: string;
  sql: string; params: TemplateParam[];
  roles: string[];         // 사용하는 {{role:…}} 목록
  driver?: string;         // '' = any
  source: 'builtin' | 'user';
}
```

**역할 어휘(연결 전역, 자동 추천 대상):** `tenant`(컬럼), `soft_delete`(컬럼). 확장 가능.
(테이블·중복컬럼 등 가변 요소는 *역할이 아니라 per-run 식별자 파라미터*다.)

**빌트인 템플릿 v1 (범용·역할 기반, 3 카테고리):**
- **CS 조사**
  - *컬럼 기준 중복 행 찾기* — params: `table`(ident), `dupColumn`(ident), `tenantValue`(value, role=tenant). → phone/chartNumber 중복 커버.
  - *특정 엔티티 ID 내역* — params: `table`(ident), `idColumn`(ident), `idValue`(value). → 특정 환자 내원 이력.
  - *컬럼 값으로 행 조회* — params: `table`, `column`(ident), `value`(value), `tenantValue`(value, role=tenant).
- **운영 점검**
  - *그룹별 최근 N일 집계* — params: `table`, `groupColumn`(ident), `dateColumn`(ident), `days`(value:number). → 병원별 최근 30일 내원 수.
  - *컬럼 NULL/빈값 점검* — params: `table`, `column`(ident). → 업로드 이상 데이터.
  - *최근 생성 레코드* — params: `table`, `createdColumn`(ident), `limit`(value:number).
- **개발 QA**
  - *최근 생성 계정/행* — params: `table`, `createdColumn`(ident), `since`(value:date).
  - *컬럼 distinct 값 분포* — params: `table`, `column`(ident), `limit`(value:number).

각 템플릿은 `description`으로 "어떤 상황에 쓰는지" 설명한다. 모든 빌트인은 SELECT(읽기전용)이며
tenant/soft_delete 절은 `[[…]]`로 감싸 도메인 미설정 시 자동 생략.

### C. 도메인 바인딩 (engine: profile JSON + 자동 추천)

- `ConnectionProfile`에 `DomainBindings string` JSON 컬럼 추가. **migration v7**:
  `ALTER TABLE connection_profiles ADD COLUMN domain_bindings TEXT NOT NULL DEFAULT ''`.
- 세 connection_profiles 스키마 사본 동기화(main.go·sqlite repo test·integration test) + repo CRUD.
- JSON 형태: `{ "tenant": "hospitalId", "soft_delete": "deletedAt" }`.
- **자동 추천(`suggestBindings.ts`, 순수, TDD)**: 연결의 컬럼 목록(introspection) + 안전모드
  `tenantColumns`로부터 역할 기본값 추정 —
  - `tenant` ← tenantColumns 중 실제 존재하는 첫 컬럼, 없으면 이름매칭(`/tenant|hospital|org/i`)
  - `soft_delete` ← 이름매칭(`/deleted_?at|is_?deleted/i`)
  도메인 설정 다이얼로그를 처음 열면 추천값으로 프리필, 사용자는 드롭다운으로 확인·수정.

### D. 사용자 커스텀 템플릿 (engine 신규 도메인)

`saved_queries`와 동형으로 신규 추가:
- **engine/internal/domain/template.go**: `Template` 구조체 + Validate.
- **migration v8**: `templates` 테이블(id, workspace_id, name, description, category, sql_text,
  parameters TEXT JSON, driver, created_at, updated_at, FK workspace).
- **engine/internal/adapters/sqlite/sqlite_template_repository.go**: Create/List/GetByID/Update/Delete.
- **engine/internal/application/template_service.go**: SaveTemplate/ListTemplates/DeleteTemplate.
- **engine/internal/transport/http/template_handler.go**: `POST/GET/DELETE /templates`(workspace 스코프).
- 라우트 등록(main.go) + IPC(`listTemplates`/`saveTemplate`/`deleteTemplate`) + 렌더러 타입.
- 커스텀 템플릿 파라미터는 작성 다이얼로그에서 SQL의 `:name`/`{{name}}`을 스캔해 초안 생성,
  사용자가 종류·라벨·옵션 보정.

### E. 후속 액션 (`templateSummary.ts`, 순수, TDD + 기존 재사용)

- **CSV 다운로드** — 기존 `gridExport.toCsv` + download 헬퍼 재사용.
- **요약 문장 생성** — 결과(columns+rows)에서 결정적 요약 생성: 총 행 수, 그룹/카운트형
  결과면 상위 항목 나열. 3개 포맷:
  - 일반 텍스트, **Slack**(mrkdwn: `*굵게*`, 목록), **Jira**(마크다운/위키). 클립보드 복사.
  - **AI 풍부화(선택)**: 에이전트 설정 시 `agentRun`으로 결과 요약 문장 생성(읽기전용). 미설정 시 결정적 요약만.
- **SQL 에디터에서 열기** — 렌더된 SQL을 `handleSelectQuery`로 에디터에 로드(편집·후속 쿼리).

### F. UI / 렌더러 통합

- **Templates 사이드바 탭**(`TemplatesPanel.tsx`): focused-panel에 Saved/History 옆 "Templates"
  탭 추가. 카테고리별 목록(빌트인+사용자), 설명 표시, 검색. "도메인 설정"·"새 템플릿" 버튼.
- **TemplateRunner**(`TemplateRunner.tsx`, 메인 페인 `templateView[id]` 상태): 파라미터 폼
  (identifier=스키마 드롭다운, value=타입별 입력, enum=select; role 값은 바인딩 기본값 프리필) →
  "실행"(미충족 required 비활성) → `renderTemplate` → 실행 → `ResultGrid` + 후속 액션 바.
- **도메인 설정 다이얼로그**(`DomainBindingsDialog.tsx`): 역할→컬럼 드롭다운(자동추천 프리필),
  저장 시 `updateProfile`로 domainBindings 반영.
- **커스텀 템플릿 저장 다이얼로그**(`SaveTemplateDialog.tsx`): 이름·설명·카테고리·SQL·파라미터(초안).
- App.tsx: `templateView` 상태 + 사이드바 탭 + 메인 페인 분기 추가.
- IPC 배선: `listTemplates`/`saveTemplate`/`deleteTemplate`(preload+main+global.d.ts).

## 범위 경계

**포함(v1):** A~F 전부.

**제외(v1, YAGNI):**
- Jira/Slack **실제 전송**(텍스트 생성·복사까지만).
- 템플릿 권한/공유/팀 동기화, 버전 관리.
- 후속 쿼리 자동 체이닝(에디터에서 열기까지만).
- 식별자 외 동적 SQL 구조(JOIN 자동생성 등). 빌트인은 단일 테이블 SELECT 중심.
- 비-SQL 엔진(Redis/Mongo) 템플릿 — v1은 SQL 드라이버(mysql/postgres/sqlite/sqlserver)만.

## 테스트 전략

- **순수 로직(렌더러, Vitest TDD)**: `renderTemplate`(값/식별자/역할/선택블록/이스케이프·미존재
  식별자 거부), `suggestBindings`(이름매칭·tenantColumns), `templateSummary`(결정적 요약 3포맷),
  빌트인 정의 무결성(자리표시자↔params 일치).
- **엔진(Go)**: template repo round-trip(테이블 테스트), domainBindings 영속(3 스키마 사본),
  template_service/handler 동작.
- **렌더러 컴포넌트**: 빌드/타입체크(프로젝트에 testing-library 없음 — 로직은 순수 테스트로 커버).
- **CDP 라이브**: dev-mysql `erg_*` 임시 테이블에 도메인 바인딩 설정 → "컬럼 기준 중복 행 찾기"
  실행 → 결과·요약·CSV·에디터 열기 검증. 커스텀 템플릿 저장→실행 검증.

## 완료 기준 (이슈 #105 매핑)

- [x] 반복 업무 템플릿 목록 확인 → F(TemplatesPanel) + B(빌트인)
- [x] 템플릿별 설명 확인 → B(description) + F
- [x] 파라미터만 입력해 실행 → A(렌더) + F(Runner)
- [x] 실행 결과 확인 → C(executeQueryStream + ResultGrid)
- [x] 결과 기반 요약 문장 생성 → E(templateSummary, AI 선택)
- [x] 사용자가 직접 쿼리를 템플릿으로 저장 → D + F(SaveTemplateDialog)
- [x] 카테고리별 분류 → B/D(category) + F
- [x] (이상화) 범용 템플릿이 스키마별 도메인 설정으로 동작 → C(도메인 바인딩) + A(`{{role:}}`)
