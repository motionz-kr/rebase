# 운영 DB 안전 실행 모드 (Safe Execution Mode) — 설계

> Issue: #102 (운영 DB 안전 실행 모드 추가) · Epic #107 · Milestone #8 (DB Tool v1)
> Date: 2026-06-06

## 배경 / 목표

운영 DB에서 `UPDATE`/`DELETE`/`TRUNCATE`/`DROP`, tenant 조건 누락, 대량 변경 등은 실서비스
데이터에 큰 영향을 준다. 실행 *전에* 위험도를 분석하고 영향 범위를 확인시켜, 의도하지 않은
데이터 변경을 방지한다.

**중요 전제 — 토대는 이미 존재한다:**
- 엔진 `domain.ClassifyQuery()` (policy.go): `ReadOnly` / `Destructive` / `Verb` 분류
- 렌더러 `sqlDanger.ts classifyStatement()`: DROP/TRUNCATE/WHERE 없는 DELETE·UPDATE 감지
- 정책 게이트: `403 read_only_blocked`, `409 confirmation_required` → 렌더러에 `policy` 청크 전달

따라서 본 작업은 백지 구현이 아니라 기존 토대 위에 **빈 칸을 채우는** 작업이다.

## 핵심 결정 (brainstorming 확정)

1. **안전 모드 판별** = 연결별 토글. 프로필에 `safeMode` 플래그 추가, 켜진 연결에서만 강제
   차단·추가 확인이 작동.
2. **Rollback** = 스냅샷 기반 SQL 텍스트 생성. 실행 직전 대상 row를 SELECT로 떠서 역쿼리
   텍스트를 만들어 저장(자동 실행 아님).
3. **tenant 키 컬럼** = 연결별 설정 + 기본값. 프로필에 `tenantColumns`(쉼표구분, 기본
   `hospitalId,tenantId`).

## 아키텍처 개요

```
[QueryEditor.executeQuery]
   │  위험 분류된 statement
   ▼
POST /query/analyze ─────────────► [engine analyzer 패키지]
   │  RiskReport(위험도/대상/조건/                │ ClassifyQuery 확장 + 단일테이블 파서
   │  예상 row 수/Preview/Rollback)               │ COUNT 실행, 스냅샷 SELECT, 역쿼리 생성
   ▼                                              ▼ (connector 읽기 왕복)
[RiskConfirmDialog] ── 사용자 확인 ──► 기존 POST /query/execute (정책 게이트)
```

- **엔진이 권위(single source of truth).** 차단·확인 게이트는 엔진에서 강제(렌더러는 신뢰
  대상이 아님). RiskReport 생성도 엔진(분석에 DB 왕복 필요).
- 렌더러는 분석 결과를 표시하고 확인 UX를 제공.

## 컴포넌트 설계

### A. 안전 모드 프로필 모델

`engine/internal/domain/connection.go` — `ConnectionProfile`에 추가:

```go
SafeMode      bool   `json:"safeMode"`      // 운영 DB 표시(연결별 토글)
TenantColumns string `json:"tenantColumns"` // 쉼표구분 tenant 키. 빈 값이면 기본값 사용
```

- `TenantColumns` 파싱 헬퍼: 빈 문자열 → `["hospitalId","tenantId"]`, 아니면 쉼표 분리 + trim.
- **migration v6**: `connection_profiles`에 `safe_mode INTEGER NOT NULL DEFAULT 0`,
  `tenant_columns TEXT NOT NULL DEFAULT ''` 컬럼 추가.
- **세 스키마 사본 동기화 필수**: `engine/cmd/app-engine/main.go` 마이그레이션,
  `engine/internal/adapters/sqlite/sqlite_profile_repository_test.go`,
  `engine/internal/application/integration_persistence_test.go`.
- 프로필 repo(`sqlite_profile_repository.go`)의 Create/Update/GetByID/List에 두 필드 read/write 추가.
- 렌더러 연결 폼(ConnectionForm)에 "안전 모드(운영 DB)" 체크박스 + tenant 컬럼 입력란(체크 시 노출).

### B. 위험 분석 — `engine/internal/analyzer` 패키지

순수 로직(DB 비의존). `domain.ClassifyQuery`를 확장/래핑.

```go
type RiskLevel string // "safe" | "warn" | "medium" | "high"

type RiskReport struct {
    Level        RiskLevel
    Verb         string   // SELECT/UPDATE/DELETE/TRUNCATE/DROP/ALTER/...
    Reasons      []string // 사람이 읽는 사유 목록
    Table        string   // 단일테이블 파싱 성공 시
    WhereClause  string   // 추출된 WHERE (없으면 "")
    HasWhere     bool
    TenantMissing bool    // tenant 컬럼 가진 테이블인데 tenant 조건 없음
    Parseable    bool     // 단일테이블 UPDATE/DELETE 파싱 성공 여부
}
```

**규칙 테이블:**

| 조건 | Level |
|------|-------|
| DROP / TRUNCATE / ALTER | high |
| WHERE 없는 UPDATE / DELETE | high |
| tenant 컬럼 보유 테이블을 tenant 조건 없이 변경/조회 | high(safe) / warn(일반) |
| LIMIT 없는 대량 SELECT (전체 테이블 스캔 가능) | warn |
| WHERE 있는 UPDATE / DELETE | medium |
| SELECT / SHOW / EXPLAIN / DESCRIBE | safe |

- **단일테이블 파서**: 정규식+토크나이저로 `UPDATE <table> SET ... [WHERE ...]`,
  `DELETE FROM <table> [WHERE ...]`에서 테이블명·WHERE 추출. JOIN·서브쿼리·멀티테이블 등
  복잡 구문은 `Parseable=false` → 정적 위험 경고만, COUNT/preview/rollback 생략(YAGNI).
- tenant 판정: WHERE 텍스트에 tenant 컬럼명(case-insensitive 단어 경계)이 등장하지 않으면
  누락으로 본다. (테이블이 실제 tenant 컬럼을 갖는지는 introspection으로 확인 — 갖지 않으면
  누락 규칙 미적용.)
- Go 테이블 테스트(TDD)로 분류·파서·tenant 판정 검증.

### C. 분석 엔드포인트 `POST /query/analyze`

`engine/internal/transport/http/query.go`에 핸들러 추가, 라우트 등록.

요청: `{ profileId, query }`
응답: `RiskReport` + 아래 DB 왕복 결과:

1. **영향 row 수**: `Parseable && verb in (UPDATE,DELETE)` →
   `SELECT COUNT(*) FROM <table> [WHERE <where>]` 실행 → `affectedRows`.
2. **SELECT Preview**: `SELECT * FROM <table> [WHERE <where>]` 텍스트 생성 +
   상위 N행(기본 20) 미리 조회해 `previewRows` 포함.
3. **Rollback SQL**: PK 있는 UPDATE/DELETE에 한해
   - DELETE: 스냅샷 `SELECT * FROM <t> WHERE <where>` → 각 row를 `INSERT INTO <t> (...) VALUES (...)`.
   - UPDATE: 영향 컬럼+PK만 스냅샷 → `UPDATE <t> SET col=oldval WHERE pk=...` per row.
   - 스냅샷 **상한 1000행**. 초과 시 rollback 미제공 + 사유 표기.
   - DDL/TRUNCATE/멀티테이블은 rollback 제외(미지원 표기).
   - 엔진에 **dialect별 리터럴 포매터** 추가(스냅샷 값 인라인; mysql/postgres/sqlite/sqlserver
     식별자 인용 + 값 이스케이프). NULL/숫자/문자/바이트/시간 타입 처리.
- 모든 분석용 쿼리는 읽기 전용. 기존 connector `ExecuteQueryStream(readOnly=true)` 재사용.

### D. 렌더러 확인 플로우

`apps/renderer/src/components/QueryEditor.tsx` `executeQuery()`에 사전 단계:

- statement가 위험 분류(`sqlDanger` 또는 analyze 결과 non-safe)면 `analyze` IPC 호출 →
  **`RiskConfirmDialog.tsx`** 표시: 위험도 배지, 대상 테이블, 사용 조건, 예상 영향 row 수,
  SELECT Preview(텍스트+샘플행), Rollback SQL(복사/`.sql` 저장 버튼).
- **일반 모드**: "실행" 1클릭으로 진행(기존 confirmDestructive 흐름과 통합).
- **안전 모드 추가 제약**: tenant 누락 / WHERE 없는 DML / TRUNCATE·DROP·ALTER 는
  "강제 실행" 체크박스를 켜야만 실행 버튼 활성화(한 번 더 명시적 확인).
- **read-only 프로필**: write 자체 차단. 기존 403 게이트를 mysql/postgres/sqlserver
  connector에도 확장(현재 sqlite만 enforce). → 세션 시작 시 `SET TRANSACTION READ ONLY`
  (pg) / `SET SESSION TRANSACTION READ ONLY`(mysql) 또는 정책 게이트에서 write verb 거부.
  최소 구현: 정책 게이트에서 `profile.ReadOnly && !ReadOnlyClass` → 403.

신규 IPC: `analyze-query` (preload + main `/query/analyze` POST 프록시 + renderer 타입).

### E. 안전 모드 엔진 강제 (게이트 강화)

`query.go` `ExecuteQuery` 정책 게이트:
- `profile.SafeMode`일 때: `RiskReport.Level == "high"`면 `ConfirmDestructive`만으로는 부족,
  요청에 새 플래그 `Acknowledged bool`(렌더러가 강제 실행 확인 후 전송)이 있어야 통과.
  없으면 `409 acknowledgement_required`.
- `profile.ReadOnly`면 write verb는 모든 드라이버에서 `403 read_only_blocked`.
- 비안전 모드: 기존 동작 유지(403/409).

## 범위 경계

**포함(v1):** A~E 전부.

**제외(v1, YAGNI):**
- 트랜잭션 savepoint 기반 실시간 롤백(텍스트 생성까지만).
- JOIN/멀티테이블 UPDATE의 rollback·COUNT·preview(정적 경고만).
- rollback 자동 실행(사용자가 수동 실행).
- 컬럼 단위 write 제한(테이블 단위 read-only 프로필만).
- 특정 테이블 write 블록리스트(향후).

**무관:** 에이전트 경로는 read-only. 그리드 인라인 편집은 이미 PK 스코프라 안전.

## 테스트 전략

- **analyzer 순수 로직**: Go 테이블 테스트(TDD) — 분류, 단일테이블 파서, tenant 판정,
  dialect 리터럴 포매터.
- **rollback/COUNT/preview**: 통합 테스트 — dev-mysql(127.0.0.1:3306)에서 `erg_*` 임시
  테이블만 사용(사용자 데이터 `demo_users` 등 절대 변경 금지). 읽기 분석 위주.
- **렌더러**: `sqlDanger`/analyze 매핑 유닛 테스트(Vitest), RiskConfirmDialog 렌더 테스트.
- **E2E**: CDP 라이브 — 안전 모드 연결에서 WHERE 없는 UPDATE 차단·강제 실행 확인,
  영향 row 수·preview·rollback 표시 확인.

## 완료 기준 (이슈 #102 매핑)

- [x] 위험한 UPDATE/DELETE를 실행 전 감지 → B (분류) + D (다이얼로그)
- [x] 실행 전 예상 영향 row 수 확인 → C-1 (COUNT)
- [x] 변경 대상 SELECT Preview → C-2
- [x] 가능한 경우 Rollback SQL 생성 → C-3
- [x] 운영 DB 기본 안전 실행 모드 → A (safeMode) + E (게이트)
- [x] 위험도 확인 후 명시적 실행 결정 → D (RiskConfirmDialog)
- [x] hospitalId 등 tenant 조건 누락 감지 → A (tenantColumns) + B (tenant 판정)
