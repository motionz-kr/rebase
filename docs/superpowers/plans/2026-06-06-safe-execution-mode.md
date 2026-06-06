# 운영 DB 안전 실행 모드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 운영 DB에서 위험 SQL을 실행 전 분석(위험도·영향 row 수·SELECT preview·Rollback SQL)하고, 안전 모드 연결에서는 명시적 확인 없이는 실행을 차단한다.

**Architecture:** 엔진이 권위(single source of truth). 새 `analyzer` 패키지가 순수 로직(분류·단일테이블 파싱·dialect SQL/리터럴/rollback 생성)을 담당하고, 새 `POST /query/analyze` 핸들러가 connector로 DB를 왕복해 COUNT·preview·snapshot을 채운다. `ExecuteQuery` 정책 게이트를 강화해 read-only 프로필 write 차단(전 드라이버)과 안전 모드 acknowledgement를 강제한다. 렌더러는 실행 전 analyze를 호출하고 `RiskConfirmDialog`로 확인 UX를 제공한다.

**Tech Stack:** Go 1.25 (엔진, `database/sql`, 표준 `net/http`, 테이블 테스트), TypeScript/React 19 (렌더러, Vitest), Electron IPC, SQLite 메타데이터 마이그레이션.

**Toolchain:** Go는 `/Users/smlee/sdk/go/bin/go` (PATH에 없음). 렌더러 테스트는 `pnpm --filter renderer test`. 통합 테스트 DB는 dev-mysql `127.0.0.1:3306` root/`password1!` db `devdb` — **사용자 데이터(`demo_users` 등) 절대 변경 금지, `erg_*` 임시 테이블만 사용**.

---

## File Structure

**엔진 (신규):**
- `engine/internal/analyzer/analyzer.go` — `RiskLevel`, `RiskReport`, `Analyze()` (분류+레벨+사유, 순수)
- `engine/internal/analyzer/parser.go` — `ParsedDML`, `ParseDML()` (단일테이블 UPDATE/DELETE 파서)
- `engine/internal/analyzer/sqlbuild.go` — `QuoteIdent()`, `BuildCountSQL()`, `BuildPreviewSQL()`, `BuildSnapshotSQL()`
- `engine/internal/analyzer/literal.go` — `FormatLiteral()` (dialect별 값 인라인)
- `engine/internal/analyzer/rollback.go` — `BuildRollbackSQL()` (snapshot rows → 역쿼리 텍스트)
- `engine/internal/analyzer/*_test.go` — 위 전부 테이블 테스트
- `engine/internal/transport/http/analyze.go` — `AnalyzeQuery()` 핸들러 + 요청/응답 타입

**엔진 (수정):**
- `engine/internal/domain/connection.go` — `SafeMode`, `TenantColumns` 필드 + `TenantColumnList()`
- `engine/internal/adapters/sqlite/sqlite_profile_repository.go` — 두 컬럼 read/write
- `engine/cmd/app-engine/main.go` — migration v6 + `/query/analyze` 라우트 등록 + handler 생성
- `engine/internal/transport/http/query.go` — `ExecuteQuery` 게이트 강화 + `Acknowledged` 필드
- `engine/internal/adapters/sqlite/sqlite_profile_repository_test.go` — 스키마 사본 동기화
- `engine/internal/application/integration_persistence_test.go` — 스키마 사본 동기화

**렌더러 (신규):**
- `apps/renderer/src/lib/safeMode.ts` — analyze 응답 → 다이얼로그 모델 매핑 (순수)
- `apps/renderer/src/lib/safeMode.test.ts`
- `apps/renderer/src/components/RiskConfirmDialog.tsx` — 확인 다이얼로그

**렌더러 (수정):**
- `apps/desktop/src/preload/index.ts` — `analyzeQuery` 노출 + `executeQueryStream` 옵션에 `acknowledged`
- `apps/desktop/src/main/index.ts` — `analyze-query` IPC 핸들러 + `/query/analyze` POST + acknowledged 전달
- `apps/renderer/src/global.d.ts` — 타입 추가
- `apps/renderer/src/components/QueryEditor.tsx` — 실행 전 analyze 호출 + 다이얼로그 게이트
- `apps/renderer/src/components/ConnectionForm.tsx` (또는 연결 폼 파일) — 안전 모드 체크박스 + tenant 컬럼 입력
- `apps/renderer/src/App.css` — 다이얼로그 스타일

---

## Task 1: 도메인 — SafeMode + TenantColumns 필드

**Files:**
- Modify: `engine/internal/domain/connection.go`
- Test: `engine/internal/domain/connection_test.go` (없으면 생성)

- [ ] **Step 1: 실패 테스트 작성**

`engine/internal/domain/connection_test.go`에 추가(파일 없으면 생성, `package domain`):

```go
package domain

import (
	"reflect"
	"testing"
)

func TestTenantColumnList_DefaultsWhenEmpty(t *testing.T) {
	p := ConnectionProfile{TenantColumns: ""}
	got := p.TenantColumnList()
	want := []string{"hospitalId", "tenantId"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("default tenant columns: got %v want %v", got, want)
	}
}

func TestTenantColumnList_ParsesAndTrims(t *testing.T) {
	p := ConnectionProfile{TenantColumns: " org_id , hospitalId ,"}
	got := p.TenantColumnList()
	want := []string{"org_id", "hospitalId"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsed tenant columns: got %v want %v", got, want)
	}
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/domain/ -run TestTenantColumnList -v`
Expected: FAIL — `p.TenantColumnList undefined`

- [ ] **Step 3: 최소 구현**

`connection.go`의 struct에 `ReadOnly` 아래(line 20 부근)에 두 필드 추가:

```go
	// SafeMode marks a connection as a production DB: risky statements are
	// hard-blocked and require explicit acknowledgement before they run.
	SafeMode bool `json:"safeMode"`
	// TenantColumns is a comma-separated list of tenant-scope key columns
	// (e.g. "hospitalId,tenantId"). Empty falls back to the default set.
	TenantColumns string `json:"tenantColumns"`
```

파일 끝에 메서드 추가:

```go
// TenantColumnList returns the configured tenant-scope columns, falling back to
// the default set ("hospitalId", "tenantId") when none are configured. Blank
// entries are dropped and surrounding whitespace trimmed.
func (p ConnectionProfile) TenantColumnList() []string {
	if strings.TrimSpace(p.TenantColumns) == "" {
		return []string{"hospitalId", "tenantId"}
	}
	var out []string
	for _, part := range strings.Split(p.TenantColumns, ",") {
		if t := strings.TrimSpace(part); t != "" {
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		return []string{"hospitalId", "tenantId"}
	}
	return out
}
```

`import` 블록에 `"strings"` 추가.

- [ ] **Step 4: 테스트 통과 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/domain/ -run TestTenantColumnList -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add engine/internal/domain/connection.go engine/internal/domain/connection_test.go
git commit -m "feat(engine): ConnectionProfile에 SafeMode·TenantColumns 추가 (#102)"
```

---

## Task 2: 영속성 — migration v6 + 프로필 repo + 스키마 사본 동기화

**Files:**
- Modify: `engine/cmd/app-engine/main.go:173-181` (migrations 배열 끝)
- Modify: `engine/internal/adapters/sqlite/sqlite_profile_repository.go` (Create/GetByID/List/Update)
- Modify: `engine/internal/adapters/sqlite/sqlite_profile_repository_test.go:27-45` (스키마 사본)
- Modify: `engine/internal/application/integration_persistence_test.go:38-54` (스키마 사본)

- [ ] **Step 1: 실패 테스트 작성**

`sqlite_profile_repository_test.go`의 `TestProfileRepository_ReadOnlyRoundTrips` 아래에 추가:

```go
func TestProfileRepository_SafeModeRoundTrips(t *testing.T) {
	repo := newProfileRepo(t)
	ctx := context.Background()

	p := &domain.ConnectionProfile{
		ID: "sm1", Name: "prod", Driver: "mysql", Host: "h", Port: 3306,
		Database: "d", Username: "u", SecretRef: "s", TLSMode: "none",
		SafeMode: true, TenantColumns: "hospitalId,orgId",
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := repo.Create(ctx, p); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.GetByID(ctx, "sm1")
	if err != nil {
		t.Fatalf("getByID: %v", err)
	}
	if !got.SafeMode {
		t.Fatalf("expected SafeMode=true to round-trip")
	}
	if got.TenantColumns != "hospitalId,orgId" {
		t.Fatalf("expected TenantColumns to round-trip, got %q", got.TenantColumns)
	}
}
```

- [ ] **Step 2: 테스트 실패 확인**

`sqlite_profile_repository_test.go`의 `newProfileRepo` 안 migration SQL(line 41 `connection_uri ...` 다음 줄)에 두 컬럼을 먼저 추가해야 컴파일이 되지만, repo 코드가 아직 두 필드를 쓰지 않으므로 Scan 불일치로 실패한다. **이 단계에서는 migration SQL만 추가**:

`sqlite_profile_repository_test.go`의 CREATE TABLE에 `connection_uri TEXT NOT NULL DEFAULT '',` 다음 줄에 추가:
```
						safe_mode INTEGER NOT NULL DEFAULT 0,
						tenant_columns TEXT NOT NULL DEFAULT '',
```

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/ -run TestProfileRepository_SafeModeRoundTrips -v`
Expected: FAIL — Create/Scan가 두 컬럼을 다루지 않아 round-trip 불일치

- [ ] **Step 3: repo에 두 컬럼 read/write 구현**

`sqlite_profile_repository.go`에서 4곳 SQL+인자 수정 (열 순서: `connection_uri` 다음, `created_at` 앞에 `safe_mode, tenant_columns` 삽입):

`Create`:
```go
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO connection_profiles (id, name, driver, host, port, database, username, secret_ref, tls_mode, mcp_enabled, mcp_data_exposure, read_only, connection_uri, safe_mode, tenant_columns, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, p.ID, p.Name, p.Driver, p.Host, p.Port, p.Database, p.Username, p.SecretRef, p.TLSMode, p.McpEnabled, p.McpDataExposure, p.ReadOnly, p.ConnectionURI, p.SafeMode, p.TenantColumns, p.CreatedAt, p.UpdatedAt)
```

`GetByID` SELECT 컬럼에 `connection_uri,` 다음 `safe_mode, tenant_columns,` 추가, Scan에 `&p.ConnectionURI,` 다음 `&p.SafeMode, &p.TenantColumns,` 추가.

`List` 동일하게 SELECT + Scan 두 곳 수정.

`Update` SET 절에 `connection_uri = ?,` 다음 `safe_mode = ?, tenant_columns = ?,` 추가, 인자에 `p.ConnectionURI,` 다음 `p.SafeMode, p.TenantColumns,` 추가.

- [ ] **Step 4: 테스트 통과 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/ -run TestProfileRepository -v`
Expected: PASS (기존 ReadOnly/MCP round-trip 테스트도 그대로 통과)

- [ ] **Step 5: 실 마이그레이션 + 통합 스키마 사본 동기화**

`engine/cmd/app-engine/main.go`의 migrations 배열에서 Version 5 항목 다음(`}` 다음, 닫는 `}` 앞)에 추가:

```go
		{
			Version: 6,
			Name:    "add_profile_safe_mode",
			SQL: `
				ALTER TABLE connection_profiles ADD COLUMN safe_mode INTEGER NOT NULL DEFAULT 0;
				ALTER TABLE connection_profiles ADD COLUMN tenant_columns TEXT NOT NULL DEFAULT '';
			`,
			Checksum: "profile-safe-mode-v1",
		},
```

`engine/internal/application/integration_persistence_test.go`의 CREATE TABLE(`connection_uri TEXT NOT NULL DEFAULT '',` 다음)에 추가:
```
					safe_mode INTEGER NOT NULL DEFAULT 0,
					tenant_columns TEXT NOT NULL DEFAULT '',
```

- [ ] **Step 6: 전체 영속성 테스트 + 빌드 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/ ./engine/internal/application/ && /Users/smlee/sdk/go/bin/go build ./engine/...`
Expected: PASS + 빌드 성공

- [ ] **Step 7: 커밋**

```bash
git add engine/cmd/app-engine/main.go engine/internal/adapters/sqlite/ engine/internal/application/integration_persistence_test.go
git commit -m "feat(engine): safe_mode·tenant_columns 마이그레이션 v6 + 프로필 영속화 (#102)"
```

---

## Task 3: analyzer — 타입 + Analyze() 분류/레벨/사유

**Files:**
- Create: `engine/internal/analyzer/analyzer.go`
- Test: `engine/internal/analyzer/analyzer_test.go`

- [ ] **Step 1: 실패 테스트 작성**

```go
package analyzer

import "testing"

func TestAnalyze_Levels(t *testing.T) {
	tenant := []string{"hospitalId", "tenantId"}
	cases := []struct {
		name  string
		sql   string
		level RiskLevel
		verb  string
	}{
		{"plain select", "SELECT * FROM users WHERE id = 1", RiskSafe, "SELECT"},
		{"update with where", "UPDATE users SET a=1 WHERE id=2", RiskMedium, "UPDATE"},
		{"update no where", "UPDATE users SET a=1", RiskHigh, "UPDATE"},
		{"delete no where", "DELETE FROM users", RiskHigh, "DELETE"},
		{"truncate", "TRUNCATE TABLE users", RiskHigh, "TRUNCATE"},
		{"drop", "DROP TABLE users", RiskHigh, "DROP"},
		{"alter", "ALTER TABLE users ADD COLUMN x INT", RiskHigh, "ALTER"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := Analyze(c.sql, tenant)
			if r.Level != c.level {
				t.Errorf("level: got %q want %q", r.Level, c.level)
			}
			if r.Verb != c.verb {
				t.Errorf("verb: got %q want %q", r.Verb, c.verb)
			}
		})
	}
}

func TestAnalyze_ReasonsPopulated(t *testing.T) {
	r := Analyze("DELETE FROM users", nil)
	if len(r.Reasons) == 0 {
		t.Fatal("expected reasons for WHERE-less DELETE")
	}
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/analyzer/ -run TestAnalyze -v`
Expected: FAIL — 패키지/타입 없음

- [ ] **Step 3: 최소 구현**

`analyzer.go`:

```go
// Package analyzer performs pre-execution risk analysis of SQL statements:
// classification, single-table parsing, and dialect-aware SQL/rollback
// generation. It is the engine-side source of truth for safe execution mode
// (#102). All functions in this file are pure (no DB access).
package analyzer

import (
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type RiskLevel string

const (
	RiskSafe   RiskLevel = "safe"
	RiskWarn   RiskLevel = "warn"
	RiskMedium RiskLevel = "medium"
	RiskHigh   RiskLevel = "high"
)

// RiskReport is the static (no-DB) analysis of a single SQL statement.
type RiskReport struct {
	Level         RiskLevel `json:"level"`
	Verb          string    `json:"verb"`
	Reasons       []string  `json:"reasons"`
	Table         string    `json:"table"`
	HasWhere      bool      `json:"hasWhere"`
	WhereClause   string    `json:"whereClause"`
	TenantMissing bool      `json:"tenantMissing"`
	Parseable     bool      `json:"parseable"`
	Parsed        ParsedDML `json:"-"`
}

// Analyze produces the static risk report. tenantColumns is the connection's
// configured tenant-scope columns; tenant-missing is finalised by the handler
// after introspection (see ApplyTenantCheck), but Analyze pre-fills WhereClause
// and a textual tenant hint.
func Analyze(query string, tenantColumns []string) RiskReport {
	class := domain.ClassifyQuery(query)
	parsed := ParseDML(query)

	r := RiskReport{
		Verb:        class.Verb,
		Table:       parsed.Table,
		HasWhere:    parsed.HasWhere,
		WhereClause: parsed.WhereClause,
		Parseable:   parsed.Parseable,
		Parsed:      parsed,
		Reasons:     []string{},
	}

	upperVerb := strings.ToUpper(class.Verb)
	switch {
	case upperVerb == "DROP" || upperVerb == "TRUNCATE" || upperVerb == "ALTER":
		r.Level = RiskHigh
		r.Reasons = append(r.Reasons, upperVerb+" 문은 스키마/데이터를 되돌리기 어렵게 변경합니다")
	case (upperVerb == "UPDATE" || upperVerb == "DELETE") && !parsed.HasWhere:
		r.Level = RiskHigh
		r.Reasons = append(r.Reasons, upperVerb+" 문에 WHERE가 없어 모든 row에 영향을 줍니다")
	case upperVerb == "UPDATE" || upperVerb == "DELETE":
		r.Level = RiskMedium
		r.Reasons = append(r.Reasons, upperVerb+" 문은 데이터를 변경합니다")
	case class.ReadOnly:
		r.Level = RiskSafe
	default:
		// INSERT/REPLACE/CALL/MULTI/unknown — treat as medium write.
		r.Level = RiskMedium
		if class.Destructive {
			r.Level = RiskHigh
		}
		r.Reasons = append(r.Reasons, "데이터를 변경할 수 있는 문입니다")
	}
	return r
}
```

- [ ] **Step 4: 테스트 통과 확인**

`ParseDML`이 아직 없으므로 컴파일 실패한다 — Task 4를 먼저 작성해야 한다. **이 단계는 Task 4 완료 후 함께 통과시킨다.** 우선 `ParseDML`의 최소 스텁을 parser.go에 두고(빈 ParsedDML 반환) 통과시킨 뒤 Task 4에서 본구현:

`parser.go` (임시 스텁):
```go
package analyzer

type ParsedDML struct {
	Verb        string `json:"verb"`
	Table       string `json:"table"`
	WhereClause string `json:"whereClause"`
	HasWhere    bool   `json:"hasWhere"`
	SetCols     []string `json:"setCols"`
	Parseable   bool   `json:"parseable"`
}

func ParseDML(query string) ParsedDML { return ParsedDML{} }
```

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/analyzer/ -run TestAnalyze -v`
Expected: PASS (Analyze 레벨/사유 테스트 — 스텁 ParseDML이라 HasWhere가 false여도 레벨 판정은 verb 기반이라 통과; "update with where"는 `HasWhere=false`로 보여 High가 될 수 있음 → 이 케이스는 Task 4에서 파서 구현 후 재확인)

> 주의: `update with where` 케이스는 파서가 있어야 Medium이 된다. 스텁 단계에서 이 서브케이스만 실패하면 정상 — Task 4 통과 후 전체 그린.

- [ ] **Step 5: 커밋**

```bash
git add engine/internal/analyzer/analyzer.go engine/internal/analyzer/parser.go engine/internal/analyzer/analyzer_test.go
git commit -m "feat(engine): analyzer 위험 분류 + 레벨/사유 (#102)"
```

---

## Task 4: analyzer — 단일테이블 UPDATE/DELETE 파서

**Files:**
- Modify: `engine/internal/analyzer/parser.go` (스텁 → 본구현)
- Test: `engine/internal/analyzer/parser_test.go`

- [ ] **Step 1: 실패 테스트 작성**

```go
package analyzer

import (
	"reflect"
	"testing"
)

func TestParseDML_Update(t *testing.T) {
	p := ParseDML("UPDATE `User` SET deletedAt = NOW(), x=1 WHERE hospitalId = 153")
	if !p.Parseable || p.Verb != "UPDATE" {
		t.Fatalf("expected parseable UPDATE, got %+v", p)
	}
	if p.Table != "User" {
		t.Errorf("table: got %q want User", p.Table)
	}
	if !p.HasWhere || p.WhereClause != "hospitalId = 153" {
		t.Errorf("where: got hasWhere=%v %q", p.HasWhere, p.WhereClause)
	}
	if !reflect.DeepEqual(p.SetCols, []string{"deletedAt", "x"}) {
		t.Errorf("setCols: got %v", p.SetCols)
	}
}

func TestParseDML_DeleteNoWhere(t *testing.T) {
	p := ParseDML("DELETE FROM users")
	if !p.Parseable || p.Verb != "DELETE" || p.Table != "users" {
		t.Fatalf("got %+v", p)
	}
	if p.HasWhere {
		t.Error("expected HasWhere=false")
	}
}

func TestParseDML_UnparseableJoin(t *testing.T) {
	p := ParseDML("UPDATE a JOIN b ON a.id=b.id SET a.x=1 WHERE a.id=2")
	if p.Parseable {
		t.Error("multi-table UPDATE must be unparseable")
	}
}

func TestParseDML_NonDML(t *testing.T) {
	if ParseDML("SELECT 1").Parseable {
		t.Error("SELECT is not DML-parseable")
	}
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/analyzer/ -run TestParseDML -v`
Expected: FAIL — 스텁이 빈 값 반환

- [ ] **Step 3: 본구현**

`parser.go` 전체를 교체:

```go
package analyzer

import (
	"regexp"
	"strings"
)

type ParsedDML struct {
	Verb        string   `json:"verb"`
	Table       string   `json:"table"`
	WhereClause string   `json:"whereClause"`
	HasWhere    bool     `json:"hasWhere"`
	SetCols     []string `json:"setCols"`
	Parseable   bool     `json:"parseable"`
}

var (
	// UPDATE <table> SET <assignments> [WHERE <rest>]
	updateRe = regexp.MustCompile(`(?is)^\s*UPDATE\s+([` + "`" + `"\[\]\w.]+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?\s*;?\s*$`)
	// DELETE FROM <table> [WHERE <rest>]
	deleteRe = regexp.MustCompile(`(?is)^\s*DELETE\s+FROM\s+([` + "`" + `"\[\]\w.]+)(?:\s+WHERE\s+(.+))?\s*;?\s*$`)
)

// ParseDML extracts table/where/set-columns from a single-table UPDATE or
// DELETE. Anything it cannot confidently parse (JOIN, subquery, multi-statement,
// non-DML) yields Parseable=false so the caller skips COUNT/preview/rollback.
func ParseDML(query string) ParsedDML {
	q := stripComments(query)
	// Reject multi-statement up front.
	if strings.Contains(strings.TrimRight(strings.TrimSpace(q), ";"), ";") {
		return ParsedDML{}
	}
	upper := strings.ToUpper(q)
	// Reject join/using/subquery shapes we won't reverse safely.
	if strings.Contains(upper, " JOIN ") || strings.Contains(upper, " USING ") {
		return ParsedDML{}
	}

	if m := updateRe.FindStringSubmatch(q); m != nil {
		table := unquoteIdent(m[1])
		if strings.Contains(table, ",") {
			return ParsedDML{}
		}
		where := strings.TrimSpace(m[3])
		return ParsedDML{
			Verb:        "UPDATE",
			Table:       table,
			WhereClause: where,
			HasWhere:    where != "",
			SetCols:     setColumns(m[2]),
			Parseable:   true,
		}
	}
	if m := deleteRe.FindStringSubmatch(q); m != nil {
		table := unquoteIdent(m[1])
		if strings.Contains(table, ",") {
			return ParsedDML{}
		}
		where := strings.TrimSpace(m[2])
		return ParsedDML{
			Verb:        "DELETE",
			Table:       table,
			WhereClause: where,
			HasWhere:    where != "",
			Parseable:   true,
		}
	}
	return ParsedDML{}
}

// setColumns extracts the left-hand column names from a SET clause, splitting on
// top-level commas (ignoring commas inside parentheses, e.g. function calls).
func setColumns(setClause string) []string {
	var cols []string
	depth := 0
	start := 0
	parts := []string{}
	for i, r := range setClause {
		switch r {
		case '(':
			depth++
		case ')':
			depth--
		case ',':
			if depth == 0 {
				parts = append(parts, setClause[start:i])
				start = i + 1
			}
		}
	}
	parts = append(parts, setClause[start:])
	for _, p := range parts {
		if eq := strings.Index(p, "="); eq >= 0 {
			cols = append(cols, unquoteIdent(strings.TrimSpace(p[:eq])))
		}
	}
	return cols
}

func unquoteIdent(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, "`\"[]")
	return s
}

// stripComments removes -- line and /* */ block comments (mirrors the domain
// classifier so the parser sees the same cleaned text).
func stripComments(s string) string {
	reLine := regexp.MustCompile(`--[^\n]*`)
	reBlock := regexp.MustCompile(`(?s)/\*.*?\*/`)
	return reBlock.ReplaceAllString(reLine.ReplaceAllString(s, " "), " ")
}
```

- [ ] **Step 4: 테스트 통과 확인 (파서 + Task 3 Analyze 전체)**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/analyzer/ -run 'TestParseDML|TestAnalyze' -v`
Expected: PASS (이제 `update with where` 케이스도 Medium으로 그린)

- [ ] **Step 5: 커밋**

```bash
git add engine/internal/analyzer/parser.go engine/internal/analyzer/parser_test.go
git commit -m "feat(engine): 단일테이블 UPDATE/DELETE 파서 (#102)"
```

---

## Task 5: analyzer — tenant 조건 누락 판정

**Files:**
- Modify: `engine/internal/analyzer/analyzer.go` (`ReferencesColumn`, `ApplyTenantCheck` 추가)
- Test: `engine/internal/analyzer/tenant_test.go`

- [ ] **Step 1: 실패 테스트 작성**

```go
package analyzer

import "testing"

func TestReferencesColumn(t *testing.T) {
	if !ReferencesColumn("hospitalId = 153 AND x=1", "hospitalId") {
		t.Error("should find hospitalId")
	}
	if ReferencesColumn("xhospitalIdy = 1", "hospitalId") {
		t.Error("must match whole word only")
	}
	if !ReferencesColumn("WHERE HOSPITALID=1", "hospitalId") {
		t.Error("case-insensitive match expected")
	}
}

func TestApplyTenantCheck(t *testing.T) {
	// table has hospitalId, where does NOT reference it -> missing -> high
	r := Analyze("UPDATE patients SET x=1 WHERE id=2", []string{"hospitalId"})
	r = ApplyTenantCheck(r, []string{"id", "hospitalId", "x"}, []string{"hospitalId"}, true)
	if !r.TenantMissing {
		t.Fatal("expected TenantMissing=true")
	}
	if r.Level != RiskHigh {
		t.Errorf("safe-mode tenant-missing should be high, got %q", r.Level)
	}

	// where references hospitalId -> not missing
	r2 := Analyze("UPDATE patients SET x=1 WHERE hospitalId=9", []string{"hospitalId"})
	r2 = ApplyTenantCheck(r2, []string{"id", "hospitalId", "x"}, []string{"hospitalId"}, true)
	if r2.TenantMissing {
		t.Error("expected TenantMissing=false when referenced")
	}

	// table has no tenant column -> rule not applied
	r3 := Analyze("UPDATE lookup SET x=1 WHERE id=2", []string{"hospitalId"})
	r3 = ApplyTenantCheck(r3, []string{"id", "x"}, []string{}, true)
	if r3.TenantMissing {
		t.Error("no tenant column on table -> not missing")
	}
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/analyzer/ -run 'TestReferencesColumn|TestApplyTenantCheck' -v`
Expected: FAIL — 함수 미정의

- [ ] **Step 3: 구현**

`analyzer.go`에 추가:

```go
import "regexp" // 기존 import 블록에 추가

// ReferencesColumn reports whether clause references col as a whole word
// (case-insensitive). Used to detect tenant-scope predicates.
func ReferencesColumn(clause, col string) bool {
	if clause == "" || col == "" {
		return false
	}
	re := regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(col) + `\b`)
	return re.MatchString(clause)
}

// ApplyTenantCheck finalises tenant-missing detection using the target table's
// actual columns. tableTenantCols is the intersection of the table's columns
// with the connection's configured tenant columns (computed by the handler via
// introspection). If the table has tenant columns but the WHERE clause
// references none of them, the statement is flagged. In safe mode a tenant miss
// is High; otherwise Warn (unless already higher).
func ApplyTenantCheck(r RiskReport, tableColumns, tableTenantCols []string, safeMode bool) RiskReport {
	if !r.Parseable || len(tableTenantCols) == 0 {
		return r
	}
	for _, tc := range tableTenantCols {
		if ReferencesColumn(r.WhereClause, tc) {
			return r // tenant predicate present
		}
	}
	r.TenantMissing = true
	r.Reasons = append(r.Reasons, "tenant 조건("+strings.Join(tableTenantCols, "/")+") 없이 실행됩니다")
	if safeMode {
		r.Level = RiskHigh
	} else if r.Level == RiskSafe || r.Level == RiskMedium {
		r.Level = RiskWarn
	}
	return r
}

// IntersectColumns returns the configured tenant columns that the table actually
// has (case-insensitive match), preserving the configured spelling.
func IntersectColumns(tableColumns, tenantColumns []string) []string {
	have := map[string]bool{}
	for _, c := range tableColumns {
		have[strings.ToLower(c)] = true
	}
	var out []string
	for _, tc := range tenantColumns {
		if have[strings.ToLower(tc)] {
			out = append(out, tc)
		}
	}
	return out
}
```

> 주의: `tableColumns` 파라미터는 `ApplyTenantCheck`에서 직접 쓰지 않지만(교차는 핸들러가 `IntersectColumns`로 미리 계산) 시그니처 일관성을 위해 유지. 사용하지 않으면 Go가 컴파일 에러를 내지 않음(파라미터는 미사용 허용).

- [ ] **Step 4: 테스트 통과 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/analyzer/ -v`
Expected: PASS (전체 analyzer 테스트)

- [ ] **Step 5: 커밋**

```bash
git add engine/internal/analyzer/analyzer.go engine/internal/analyzer/tenant_test.go
git commit -m "feat(engine): tenant 조건 누락 판정 (#102)"
```

---

## Task 6: analyzer — dialect SQL 빌더 (COUNT/preview/snapshot)

**Files:**
- Create: `engine/internal/analyzer/sqlbuild.go`
- Test: `engine/internal/analyzer/sqlbuild_test.go`

- [ ] **Step 1: 실패 테스트 작성**

```go
package analyzer

import "testing"

func TestQuoteIdent(t *testing.T) {
	cases := []struct{ driver, in, want string }{
		{"mysql", "User", "`User`"},
		{"postgres", "User", `"User"`},
		{"sqlite", "User", `"User"`},
		{"sqlserver", "User", "[User]"},
		{"mysql", "a`b", "`a``b`"},
		{"postgres", `a"b`, `"a""b"`},
		{"sqlserver", "a]b", "[a]]b]"},
	}
	for _, c := range cases {
		if got := QuoteIdent(c.driver, c.in); got != c.want {
			t.Errorf("QuoteIdent(%s,%q)=%q want %q", c.driver, c.in, got, c.want)
		}
	}
}

func TestBuildCountSQL(t *testing.T) {
	p := ParsedDML{Verb: "DELETE", Table: "User", WhereClause: "hospitalId = 153", HasWhere: true}
	got := BuildCountSQL("mysql", p)
	want := "SELECT COUNT(*) FROM `User` WHERE hospitalId = 153"
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

func TestBuildCountSQL_NoWhere(t *testing.T) {
	p := ParsedDML{Verb: "DELETE", Table: "User", HasWhere: false}
	if got := BuildCountSQL("postgres", p); got != `SELECT COUNT(*) FROM "User"` {
		t.Errorf("got %q", got)
	}
}

func TestBuildPreviewSQL(t *testing.T) {
	p := ParsedDML{Table: "User", WhereClause: "id=1", HasWhere: true}
	if got := BuildPreviewSQL("sqlite", p); got != `SELECT * FROM "User" WHERE id=1` {
		t.Errorf("got %q", got)
	}
}

func TestBuildSnapshotSQL_Update(t *testing.T) {
	p := ParsedDML{Verb: "UPDATE", Table: "User", WhereClause: "id=1", HasWhere: true, SetCols: []string{"deletedAt"}}
	got := BuildSnapshotSQL("mysql", p, []string{"id"})
	want := "SELECT `id`, `deletedAt` FROM `User` WHERE id=1"
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/analyzer/ -run 'TestQuoteIdent|TestBuild' -v`
Expected: FAIL — 함수 미정의

- [ ] **Step 3: 구현**

`sqlbuild.go`:

```go
package analyzer

import "strings"

// QuoteIdent quotes a SQL identifier for the given driver, escaping the closing
// quote character by doubling (or, for sqlserver, doubling the closing bracket).
func QuoteIdent(driver, name string) string {
	switch driver {
	case "mysql":
		return "`" + strings.ReplaceAll(name, "`", "``") + "`"
	case "sqlserver":
		return "[" + strings.ReplaceAll(name, "]", "]]") + "]"
	default: // postgres, sqlite
		return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
	}
}

func whereSuffix(p ParsedDML) string {
	if p.HasWhere && p.WhereClause != "" {
		return " WHERE " + p.WhereClause
	}
	return ""
}

// BuildCountSQL returns a read-only COUNT mirroring the DML's table+predicate,
// used to preview the affected-row count before execution.
func BuildCountSQL(driver string, p ParsedDML) string {
	return "SELECT COUNT(*) FROM " + QuoteIdent(driver, p.Table) + whereSuffix(p)
}

// BuildPreviewSQL returns a SELECT * over the same rows the DML would touch.
func BuildPreviewSQL(driver string, p ParsedDML) string {
	return "SELECT * FROM " + QuoteIdent(driver, p.Table) + whereSuffix(p)
}

// BuildSnapshotSQL returns the SELECT that captures the before-image needed to
// build rollback SQL. For UPDATE it selects pk + changed columns; for DELETE it
// selects all columns (SELECT *) so the full row can be re-inserted.
func BuildSnapshotSQL(driver string, p ParsedDML, pkCols []string) string {
	if p.Verb == "DELETE" {
		return "SELECT * FROM " + QuoteIdent(driver, p.Table) + whereSuffix(p)
	}
	// UPDATE: pk columns first, then changed columns (dedup).
	seen := map[string]bool{}
	var cols []string
	for _, c := range pkCols {
		if !seen[strings.ToLower(c)] {
			seen[strings.ToLower(c)] = true
			cols = append(cols, QuoteIdent(driver, c))
		}
	}
	for _, c := range p.SetCols {
		if !seen[strings.ToLower(c)] {
			seen[strings.ToLower(c)] = true
			cols = append(cols, QuoteIdent(driver, c))
		}
	}
	return "SELECT " + strings.Join(cols, ", ") + " FROM " + QuoteIdent(driver, p.Table) + whereSuffix(p)
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/analyzer/ -run 'TestQuoteIdent|TestBuild' -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add engine/internal/analyzer/sqlbuild.go engine/internal/analyzer/sqlbuild_test.go
git commit -m "feat(engine): dialect COUNT/preview/snapshot SQL 빌더 (#102)"
```

---

## Task 7: analyzer — dialect 리터럴 포매터

**Files:**
- Create: `engine/internal/analyzer/literal.go`
- Test: `engine/internal/analyzer/literal_test.go`

- [ ] **Step 1: 실패 테스트 작성**

```go
package analyzer

import (
	"testing"
	"time"
)

func TestFormatLiteral(t *testing.T) {
	ts := time.Date(2026, 6, 6, 10, 30, 0, 0, time.UTC)
	cases := []struct {
		driver string
		val    any
		want   string
	}{
		{"mysql", nil, "NULL"},
		{"mysql", int64(42), "42"},
		{"mysql", 3.5, "3.5"},
		{"mysql", true, "1"},
		{"mysql", false, "0"},
		{"mysql", "a'b", "'a''b'"},
		{"mysql", []byte("x'y"), "'x''y'"},
		{"mysql", ts, "'2026-06-06 10:30:00'"},
		{"postgres", true, "TRUE"},
		{"postgres", false, "FALSE"},
		{"sqlserver", true, "1"},
	}
	for _, c := range cases {
		if got := FormatLiteral(c.driver, c.val); got != c.want {
			t.Errorf("FormatLiteral(%s,%v)=%q want %q", c.driver, c.val, got, c.want)
		}
	}
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/analyzer/ -run TestFormatLiteral -v`
Expected: FAIL — 미정의

- [ ] **Step 3: 구현**

`literal.go`:

```go
package analyzer

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// FormatLiteral renders a Go value (as returned by database/sql) as an inline
// SQL literal for the given driver. Strings/bytes are single-quote escaped;
// booleans follow each dialect's convention. Used to build rollback SQL text —
// the values originate from the DB itself and the output is shown to the user,
// not auto-executed, but correct escaping still matters.
func FormatLiteral(driver string, v any) string {
	switch x := v.(type) {
	case nil:
		return "NULL"
	case bool:
		return formatBool(driver, x)
	case int64:
		return strconv.FormatInt(x, 10)
	case int:
		return strconv.Itoa(x)
	case float64:
		return strconv.FormatFloat(x, 'g', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(x), 'g', -1, 32)
	case []byte:
		return quoteString(string(x))
	case string:
		return quoteString(x)
	case time.Time:
		return "'" + x.Format("2006-01-02 15:04:05") + "'"
	default:
		return quoteString(fmt.Sprintf("%v", x))
	}
}

func formatBool(driver string, b bool) string {
	if driver == "postgres" {
		if b {
			return "TRUE"
		}
		return "FALSE"
	}
	if b {
		return "1"
	}
	return "0"
}

func quoteString(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/analyzer/ -run TestFormatLiteral -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add engine/internal/analyzer/literal.go engine/internal/analyzer/literal_test.go
git commit -m "feat(engine): dialect 리터럴 포매터 (#102)"
```

---

## Task 8: analyzer — Rollback SQL 생성기

**Files:**
- Create: `engine/internal/analyzer/rollback.go`
- Test: `engine/internal/analyzer/rollback_test.go`

- [ ] **Step 1: 실패 테스트 작성**

```go
package analyzer

import (
	"strings"
	"testing"
)

func TestBuildRollbackSQL_Delete(t *testing.T) {
	p := ParsedDML{Verb: "DELETE", Table: "User", WhereClause: "id=1", HasWhere: true}
	cols := []string{"id", "name"}
	rows := [][]any{{int64(1), "alice"}, {int64(2), "bob"}}
	sql, ok := BuildRollbackSQL("mysql", p, cols, nil, rows)
	if !ok {
		t.Fatal("expected rollback ok")
	}
	if !strings.Contains(sql, "INSERT INTO `User` (`id`, `name`) VALUES (1, 'alice');") {
		t.Errorf("missing first insert:\n%s", sql)
	}
	if !strings.Contains(sql, "(2, 'bob')") {
		t.Errorf("missing second insert:\n%s", sql)
	}
}

func TestBuildRollbackSQL_Update(t *testing.T) {
	p := ParsedDML{Verb: "UPDATE", Table: "User", WhereClause: "id=1", HasWhere: true, SetCols: []string{"deletedAt"}}
	// snapshot columns: pk(id) + changed(deletedAt)
	cols := []string{"id", "deletedAt"}
	rows := [][]any{{int64(7), nil}}
	sql, ok := BuildRollbackSQL("mysql", p, cols, []string{"id"}, rows)
	if !ok {
		t.Fatal("expected ok")
	}
	want := "UPDATE `User` SET `deletedAt` = NULL WHERE `id` = 7;"
	if !strings.Contains(sql, want) {
		t.Errorf("got:\n%s\nwant substring: %s", sql, want)
	}
}

func TestBuildRollbackSQL_UpdateNoPK(t *testing.T) {
	p := ParsedDML{Verb: "UPDATE", Table: "User", SetCols: []string{"x"}}
	if _, ok := BuildRollbackSQL("mysql", p, []string{"x"}, nil, [][]any{{1}}); ok {
		t.Error("UPDATE without PK must not produce rollback")
	}
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/analyzer/ -run TestBuildRollbackSQL -v`
Expected: FAIL — 미정의

- [ ] **Step 3: 구현**

`rollback.go`:

```go
package analyzer

import "strings"

// BuildRollbackSQL generates best-effort rollback SQL text from a before-image
// snapshot of the affected rows.
//
//   - DELETE → one INSERT per snapshot row (full row, re-insert).
//   - UPDATE → one UPDATE per snapshot row restoring the changed columns,
//     keyed by primary key. Requires pkCols; returns ok=false without one.
//
// snapshotCols are the column names of each row in `rows` (same order). DDL,
// TRUNCATE and multi-table statements are not supported (ok=false).
func BuildRollbackSQL(driver string, p ParsedDML, snapshotCols, pkCols []string, rows [][]any) (string, bool) {
	if len(rows) == 0 {
		return "", false
	}
	switch p.Verb {
	case "DELETE":
		return buildDeleteRollback(driver, p, snapshotCols, rows), true
	case "UPDATE":
		if len(pkCols) == 0 {
			return "", false
		}
		return buildUpdateRollback(driver, p, snapshotCols, pkCols, rows)
	default:
		return "", false
	}
}

func buildDeleteRollback(driver string, p ParsedDML, cols []string, rows [][]any) string {
	quoted := make([]string, len(cols))
	for i, c := range cols {
		quoted[i] = QuoteIdent(driver, c)
	}
	var b strings.Builder
	prefix := "INSERT INTO " + QuoteIdent(driver, p.Table) + " (" + strings.Join(quoted, ", ") + ") VALUES "
	for _, row := range rows {
		vals := make([]string, len(row))
		for i, v := range row {
			vals[i] = FormatLiteral(driver, v)
		}
		b.WriteString(prefix + "(" + strings.Join(vals, ", ") + ");\n")
	}
	return b.String()
}

func buildUpdateRollback(driver string, p ParsedDML, cols, pkCols []string, rows [][]any) (string, bool) {
	// Map column name (lower) -> index in each row.
	idx := map[string]int{}
	for i, c := range cols {
		idx[strings.ToLower(c)] = i
	}
	// Verify all pk + changed columns are present in the snapshot.
	for _, c := range pkCols {
		if _, ok := idx[strings.ToLower(c)]; !ok {
			return "", false
		}
	}
	for _, c := range p.SetCols {
		if _, ok := idx[strings.ToLower(c)]; !ok {
			return "", false
		}
	}
	var b strings.Builder
	for _, row := range rows {
		var sets, wheres []string
		for _, c := range p.SetCols {
			sets = append(sets, QuoteIdent(driver, c)+" = "+FormatLiteral(driver, row[idx[strings.ToLower(c)]]))
		}
		for _, c := range pkCols {
			wheres = append(wheres, QuoteIdent(driver, c)+" = "+FormatLiteral(driver, row[idx[strings.ToLower(c)]]))
		}
		b.WriteString("UPDATE " + QuoteIdent(driver, p.Table) + " SET " + strings.Join(sets, ", ") +
			" WHERE " + strings.Join(wheres, " AND ") + ";\n")
	}
	return b.String(), true
}
```

- [ ] **Step 4: 테스트 통과 확인 (analyzer 전체)**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/analyzer/ -v`
Expected: PASS (전체 그린)

- [ ] **Step 5: 커밋**

```bash
git add engine/internal/analyzer/rollback.go engine/internal/analyzer/rollback_test.go
git commit -m "feat(engine): 스냅샷 기반 Rollback SQL 생성 (#102)"
```

---

## Task 9: 엔진 — /query/analyze 핸들러 + 라우트

**Files:**
- Create: `engine/internal/transport/http/analyze.go`
- Modify: `engine/cmd/app-engine/main.go:242` (라우트 등록)
- Test: `engine/internal/transport/http/analyze_test.go` (정적 부분 단위 테스트)

핸들러는 `QueryHandler`(이미 connector·service 보유)에 메서드로 추가한다.

- [ ] **Step 1: 실패 테스트 작성 (DB 비의존 헬퍼)**

핸들러의 DB 왕복은 통합 테스트(Task 10)에서 검증하고, 여기서는 응답 조립 헬퍼 `assembleStaticReport`만 단위 테스트한다.

`analyze_test.go`:
```go
package http

import (
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/analyzer"
)

func TestAssembleStaticReport_NonParseablePassThrough(t *testing.T) {
	r := analyzer.Analyze("DROP TABLE x", nil)
	resp := assembleStaticReport(r)
	if resp.Level != "high" || resp.Verb != "DROP" {
		t.Fatalf("got %+v", resp)
	}
	if resp.AffectedRows != nil {
		t.Error("non-parseable must not carry affectedRows")
	}
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/transport/http/ -run TestAssembleStaticReport -v`
Expected: FAIL — `assembleStaticReport`/`AnalyzeResponse` 미정의

- [ ] **Step 3: 핸들러 구현**

`analyze.go`:
```go
package http

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/smlee/database-local-engine/engine/internal/analyzer"
)

type AnalyzeQueryRequest struct {
	ProfileID string `json:"profileId"`
	Query     string `json:"query"`
	Database  string `json:"database"`
}

// AnalyzeResponse is the pre-execution risk report sent to the renderer.
// Pointer fields are nil when not applicable (non-parseable / read-only / no PK).
type AnalyzeResponse struct {
	Level         string     `json:"level"`
	Verb          string     `json:"verb"`
	Reasons       []string   `json:"reasons"`
	Table         string     `json:"table"`
	HasWhere      bool       `json:"hasWhere"`
	TenantMissing bool       `json:"tenantMissing"`
	Parseable     bool       `json:"parseable"`
	AffectedRows  *int64     `json:"affectedRows"`
	PreviewSQL    string     `json:"previewSql"`
	PreviewCols   []string   `json:"previewCols"`
	PreviewRows   [][]any    `json:"previewRows"`
	RollbackSQL   string     `json:"rollbackSql"`
	RollbackNote  string     `json:"rollbackNote"`
}

const previewRowLimit = 20
const snapshotRowLimit = 1000

func assembleStaticReport(r analyzer.RiskReport) AnalyzeResponse {
	reasons := r.Reasons
	if reasons == nil {
		reasons = []string{}
	}
	return AnalyzeResponse{
		Level:         string(r.Level),
		Verb:          r.Verb,
		Reasons:       reasons,
		Table:         r.Table,
		HasWhere:      r.HasWhere,
		TenantMissing: r.TenantMissing,
		Parseable:     r.Parseable,
	}
}

func (h *QueryHandler) AnalyzeQuery() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var req AnalyzeQueryRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.ProfileID == "" || req.Query == "" {
			http.Error(w, "profileId and query are required", http.StatusBadRequest)
			return
		}
		profile, password, err := h.service.GetProfile(r.Context(), req.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		report := analyzer.Analyze(req.Query, profile.TenantColumnList())
		resp := assembleStaticReport(report)

		// DB round-trips only for parseable single-table UPDATE/DELETE on a SQL driver.
		connector, cerr := h.getConnector(profile.Driver)
		if report.Parseable && cerr == nil && (report.Verb == "UPDATE" || report.Verb == "DELETE") {
			h.enrichReport(r.Context(), connector, *profile, password, req.Database, report, &resp)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
}
```

`enrichReport`는 Task 10에서 본구현하므로, 지금은 컴파일을 위해 빈 메서드 스텁을 같은 파일에 둔다:
```go
func (h *QueryHandler) enrichReport(ctx context.Context, connector interface{}, profile interface{}, password, database string, report analyzer.RiskReport, resp *AnalyzeResponse) {
}
```
> 위 스텁 시그니처는 Task 10에서 정확한 타입으로 교체한다.

- [ ] **Step 4: 라우트 등록**

`engine/cmd/app-engine/main.go`의 `mux.Handle("/query/cancel", ...)`(line 244) 다음 줄에 추가:
```go
	mux.Handle("/query/analyze", queryHandler.AnalyzeQuery())
```

- [ ] **Step 5: 테스트 통과 + 빌드 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/transport/http/ -run TestAssembleStaticReport -v && /Users/smlee/sdk/go/bin/go build ./engine/...`
Expected: PASS + 빌드 성공

- [ ] **Step 6: 커밋**

```bash
git add engine/internal/transport/http/analyze.go engine/internal/transport/http/analyze_test.go engine/cmd/app-engine/main.go
git commit -m "feat(engine): /query/analyze 핸들러 정적 분석 + 라우트 (#102)"
```

---

## Task 10: 엔진 — analyze DB 왕복 (COUNT/preview/snapshot/rollback)

**Files:**
- Modify: `engine/internal/transport/http/analyze.go` (`enrichReport` 본구현)
- Test: `engine/internal/transport/http/analyze_integration_test.go` (dev-mysql, `erg_*` 임시 테이블)

- [ ] **Step 1: 실패 통합 테스트 작성**

`analyze_integration_test.go` — 빌드 태그로 격리하고, dev-mysql 부재 시 skip:
```go
//go:build integration

package http

import (
	"context"
	"database/sql"
	"os"
	"testing"

	_ "github.com/go-sql-driver/mysql"
)

func mysqlDSN() string {
	if v := os.Getenv("ANALYZE_TEST_DSN"); v != "" {
		return v
	}
	return "root:password1!@tcp(127.0.0.1:3306)/devdb?multiStatements=true&parseTime=true"
}

func TestEnrichReport_DeleteCountAndRollback(t *testing.T) {
	db, err := sql.Open("mysql", mysqlDSN())
	if err != nil {
		t.Skipf("no mysql: %v", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		t.Skipf("mysql unreachable: %v", err)
	}
	ctx := context.Background()
	db.ExecContext(ctx, "DROP TABLE IF EXISTS erg_safe_test")
	if _, err := db.ExecContext(ctx, "CREATE TABLE erg_safe_test (id INT PRIMARY KEY, name VARCHAR(50), hospitalId INT)"); err != nil {
		t.Fatalf("create: %v", err)
	}
	defer db.ExecContext(ctx, "DROP TABLE IF EXISTS erg_safe_test")
	db.ExecContext(ctx, "INSERT INTO erg_safe_test VALUES (1,'a',153),(2,'b',153),(3,'c',999)")

	// This test drives enrichReport through a real MySQLConnector. Construct the
	// handler's connector and a throwaway profile pointing at devdb.
	// (See helper newMysqlTestProfile below — it persists a profile via the
	//  ConnectionService used by QueryHandler.)
	h, profileID, cleanup := newAnalyzeTestHandler(t, db)
	defer cleanup()

	report := analyze(h, profileID, "DELETE FROM erg_safe_test WHERE hospitalId = 153", "devdb")
	if report.AffectedRows == nil || *report.AffectedRows != 2 {
		t.Fatalf("affectedRows: %v", report.AffectedRows)
	}
	if report.RollbackSQL == "" {
		t.Fatal("expected rollback SQL for DELETE with PK")
	}
}
```

> `newAnalyzeTestHandler`와 `analyze` 헬퍼는 같은 파일에 작성한다. 핵심은: 임시 메타데이터 SQLite로 `ConnectionService`를 만들고, devdb를 가리키는 프로필을 Create한 뒤 `QueryHandler{service, mysqlConnector:...}`를 구성, `enrichReport`를 호출하는 것. 구현 세부는 기존 통합 테스트 패턴(`engine/internal/adapters/mysql/*_test.go`, `integration_persistence_test.go`)을 참고해 작성. (이 헬퍼 작성도 본 스텝의 일부다.)

- [ ] **Step 2: 테스트 실패 확인**

Run: `/Users/smlee/sdk/go/bin/go test -tags=integration ./engine/internal/transport/http/ -run TestEnrichReport -v`
Expected: FAIL — `enrichReport` 스텁이 아무 것도 채우지 않음

- [ ] **Step 3: `enrichReport` 본구현**

Task 9의 스텁을 교체. 정확한 타입(`ports.SQLConnector`, `domain.ConnectionProfile`) 사용:

```go
func (h *QueryHandler) enrichReport(ctx context.Context, connector ports.SQLConnector, profile domain.ConnectionProfile, password, database string, report analyzer.RiskReport, resp *AnalyzeResponse) {
	driver := profile.Driver
	p := report.Parsed

	// 1. Table introspection: columns + primary keys + tenant intersection.
	desc, err := connector.DescribeTable(ctx, profile, password, database, p.Table)
	var allCols, pkCols []string
	if err == nil {
		for _, c := range desc.Columns {
			allCols = append(allCols, c.Name)
			if c.PrimaryKey {
				pkCols = append(pkCols, c.Name)
			}
		}
		tenantCols := analyzer.IntersectColumns(allCols, profile.TenantColumnList())
		report = analyzer.ApplyTenantCheck(report, allCols, tenantCols, profile.SafeMode)
		resp.Level = string(report.Level)
		resp.TenantMissing = report.TenantMissing
		resp.Reasons = report.Reasons
	}

	// 2. Affected-row COUNT.
	countSQL := analyzer.BuildCountSQL(driver, p)
	if n, ok := h.scalarInt(ctx, connector, profile, password, countSQL); ok {
		resp.AffectedRows = &n
	}

	// 3. SELECT preview (text + sample rows).
	resp.PreviewSQL = analyzer.BuildPreviewSQL(driver, p)
	cols, rows := h.collectRows(ctx, connector, profile, password, resp.PreviewSQL, previewRowLimit)
	resp.PreviewCols = cols
	resp.PreviewRows = rows

	// 4. Rollback (UPDATE needs PK; cap snapshot at snapshotRowLimit).
	if resp.AffectedRows != nil && *resp.AffectedRows > snapshotRowLimit {
		resp.RollbackNote = "영향 row가 1000건을 초과해 Rollback SQL을 생성하지 않았습니다"
		return
	}
	snapSQL := analyzer.BuildSnapshotSQL(driver, p, pkCols)
	snapCols, snapRows := h.collectRows(ctx, connector, profile, password, snapSQL, snapshotRowLimit+1)
	if len(snapRows) > snapshotRowLimit {
		resp.RollbackNote = "영향 row가 너무 많아 Rollback SQL을 생성하지 않았습니다"
		return
	}
	if sqlText, ok := analyzer.BuildRollbackSQL(driver, p, snapCols, pkCols, snapRows); ok {
		resp.RollbackSQL = sqlText
	} else if p.Verb == "UPDATE" && len(pkCols) == 0 {
		resp.RollbackNote = "PK가 없어 Rollback SQL을 생성할 수 없습니다"
	}
}

// scalarInt runs a single-value COUNT query and returns the integer result.
func (h *QueryHandler) scalarInt(ctx context.Context, connector ports.SQLConnector, profile domain.ConnectionProfile, password, query string) (int64, bool) {
	var out int64
	var got bool
	_, err := connector.ExecuteQueryStream(ctx, profile, password, query, true,
		func(int64) {}, func([]string) error { return nil },
		func(row []any) error {
			if len(row) > 0 {
				out = toInt64(row[0])
				got = true
			}
			return nil
		})
	if err != nil {
		return 0, false
	}
	return out, got
}

// collectRows runs a read-only query and accumulates up to limit rows.
func (h *QueryHandler) collectRows(ctx context.Context, connector ports.SQLConnector, profile domain.ConnectionProfile, password, query string, limit int) ([]string, [][]any) {
	var cols []string
	var rows [][]any
	stop := fmtError("limit")
	_, err := connector.ExecuteQueryStream(ctx, profile, password, query, true,
		func(int64) {}, func(c []string) error { cols = c; return nil },
		func(row []any) error {
			if len(rows) >= limit {
				return stop
			}
			cp := make([]any, len(row))
			copy(cp, row)
			rows = append(rows, cp)
			return nil
		})
	_ = err // limit sentinel or real error: best-effort preview
	return cols, rows
}

func toInt64(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int:
		return int64(x)
	case []byte:
		n, _ := strconvParseInt(string(x))
		return n
	case string:
		n, _ := strconvParseInt(x)
		return n
	case float64:
		return int64(x)
	}
	return 0
}
```

`analyze.go` import에 `"github.com/smlee/database-local-engine/engine/internal/domain"`, `"github.com/smlee/database-local-engine/engine/internal/ports"` 추가. `strconvParseInt` 헬퍼는 `strconv.ParseInt(s,10,64)` 래퍼로 같은 파일에 추가:
```go
func strconvParseInt(s string) (int64, error) { return strconv.ParseInt(strings.TrimSpace(s), 10, 64) }
```
import에 `"strconv"`, `"strings"` 추가. Task 9의 `AnalyzeQuery`에서 `enrichReport` 호출부의 인자 타입을 실제 시그니처(`connector ports.SQLConnector`, `*profile`)에 맞게 수정한다.

- [ ] **Step 4: 통합 테스트 통과 확인**

Run: `/Users/smlee/sdk/go/bin/go test -tags=integration ./engine/internal/transport/http/ -run TestEnrichReport -v`
Expected: PASS (affectedRows=2, rollback SQL 존재)

- [ ] **Step 5: 단위 테스트 + 빌드 회귀 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/... && /Users/smlee/sdk/go/bin/go build ./engine/...`
Expected: PASS (integration 태그 없는 기본 테스트 전부 그린)

- [ ] **Step 6: 커밋**

```bash
git add engine/internal/transport/http/analyze.go engine/internal/transport/http/analyze_integration_test.go
git commit -m "feat(engine): analyze DB 왕복 COUNT/preview/rollback (#102)"
```

---

## Task 11: 엔진 — 실행 게이트 강화 (read-only 프로필 + 안전모드 ack)

**Files:**
- Modify: `engine/internal/transport/http/query.go` (`ExecuteQueryRequest`, `ExecuteQuery` 게이트)
- Test: `engine/internal/transport/http/gate_test.go` (게이트 결정 함수 단위 테스트)

게이트 결정을 순수 함수로 추출해 테스트 가능하게 만든다.

- [ ] **Step 1: 실패 테스트 작성**

`gate_test.go`:
```go
package http

import "testing"

func TestEvaluateGate(t *testing.T) {
	// read-only profile blocks any write regardless of allowWrite
	g := evaluateGate(gateInput{readOnlyProfile: true, classReadOnly: false, allowWrite: true})
	if g.code != "read_only_blocked" {
		t.Errorf("read-only profile must block write, got %q", g.code)
	}
	// safe mode + high risk + not acknowledged -> ack required
	g = evaluateGate(gateInput{safeMode: true, riskHigh: true, allowWrite: true, confirmDestructive: true, acknowledged: false})
	if g.code != "acknowledgement_required" {
		t.Errorf("safe-mode high risk must require ack, got %q", g.code)
	}
	// safe mode + high + acknowledged -> pass
	g = evaluateGate(gateInput{safeMode: true, riskHigh: true, allowWrite: true, confirmDestructive: true, acknowledged: true})
	if g.code != "" {
		t.Errorf("acknowledged should pass, got %q", g.code)
	}
	// normal mode unchanged: destructive needs confirm
	g = evaluateGate(gateInput{classDestructive: true, allowWrite: true, confirmDestructive: false})
	if g.code != "confirmation_required" {
		t.Errorf("destructive needs confirm, got %q", g.code)
	}
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/transport/http/ -run TestEvaluateGate -v`
Expected: FAIL — `evaluateGate`/`gateInput` 미정의

- [ ] **Step 3: 게이트 함수 + 요청 필드 구현**

`query.go`의 `ExecuteQueryRequest`에 필드 추가:
```go
	// Acknowledged confirms the user saw the safe-mode risk report and chose to
	// force-run a high-risk statement on a production (safe-mode) connection.
	Acknowledged bool `json:"acknowledged"`
```

`query.go`에 게이트 결정 함수 추가:
```go
type gateInput struct {
	readOnlyProfile    bool
	safeMode           bool
	classReadOnly      bool
	classDestructive   bool
	riskHigh           bool
	allowWrite         bool
	confirmDestructive bool
	acknowledged       bool
}

type gateResult struct {
	status  int
	code    string
	message string
}

// evaluateGate centralises the pre-execution policy decision. An empty code
// means the statement may proceed.
func evaluateGate(in gateInput) gateResult {
	if in.readOnlyProfile && !in.classReadOnly {
		return gateResult{http.StatusForbidden, "read_only_blocked",
			"This connection is read-only. Writes are blocked."}
	}
	if !in.classReadOnly && !in.allowWrite {
		return gateResult{http.StatusForbidden, "read_only_blocked",
			"This statement may modify data and is blocked in read-only mode. Enable write mode to run it."}
	}
	if in.classDestructive && !in.confirmDestructive {
		return gateResult{http.StatusConflict, "confirmation_required",
			"This is a destructive statement. Confirm to run it."}
	}
	if in.safeMode && in.riskHigh && !in.acknowledged {
		return gateResult{http.StatusConflict, "acknowledgement_required",
			"This connection is in safe mode. Review the risk report and acknowledge to run this statement."}
	}
	return gateResult{}
}
```

`ExecuteQuery` 핸들러에서 기존 게이트 블록(line 129-142)을 교체: profile을 먼저 가져온 뒤 게이트 평가. 즉 `GetProfile` 호출(line 150-154)을 `class := domain.ClassifyQuery(...)` 위로 이동하고, 게이트 블록을 아래로 교체:

```go
		profile, password, err := h.service.GetProfile(r.Context(), req.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		class := domain.ClassifyQuery(req.Query)
		report := analyzer.Analyze(req.Query, profile.TenantColumnList())
		gate := evaluateGate(gateInput{
			readOnlyProfile:    profile.ReadOnly,
			safeMode:           profile.SafeMode,
			classReadOnly:      class.ReadOnly,
			classDestructive:   class.Destructive,
			riskHigh:           report.Level == analyzer.RiskHigh,
			allowWrite:         req.AllowWrite,
			confirmDestructive: req.ConfirmDestructive,
			acknowledged:       req.Acknowledged,
		})
		if gate.code != "" {
			writeQueryPolicyError(w, gate.status, gate.code, gate.message, class.Verb)
			return
		}
```

이후 코드에서 중복된 `profile, password, err := h.service.GetProfile(...)` 블록(원래 line 150)을 제거(이미 위에서 가져옴). `analyzer` import 추가.

> 주의: 안전모드 high 위험 판정은 정적(`report.Level`)만 사용한다 — tenant-missing의 DB 확정은 analyze 엔드포인트에서만 수행하며, 실행 게이트는 정적 레벨로 충분(보수적). 렌더러가 acknowledged를 보내는 흐름은 Task 15.

- [ ] **Step 4: 테스트 통과 + 빌드 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/transport/http/ -run TestEvaluateGate -v && /Users/smlee/sdk/go/bin/go build ./engine/...`
Expected: PASS + 빌드 성공

- [ ] **Step 5: 커밋**

```bash
git add engine/internal/transport/http/query.go engine/internal/transport/http/gate_test.go
git commit -m "feat(engine): read-only 프로필·안전모드 ack 실행 게이트 (#102)"
```

---

## Task 12: 렌더러 — IPC 배선 (preload/main/types)

**Files:**
- Modify: `apps/desktop/src/preload/index.ts:36-42` (`executeQueryStream` 옵션 + `analyzeQuery`)
- Modify: `apps/desktop/src/main/index.ts:503` 부근 (acknowledged 전달) + 신규 `analyze-query` 핸들러
- Modify: `apps/renderer/src/global.d.ts` (타입)

- [ ] **Step 1: preload 노출**

`apps/desktop/src/preload/index.ts`의 `executeQueryStream` 옵션 타입에 `acknowledged?: boolean` 추가(options 객체 타입에 필드 추가), 그리고 `cancelQuery` 위에 추가:
```ts
  analyzeQuery: (profileId: string, query: string, database: string) =>
    ipcRenderer.invoke('analyze-query', profileId, query, database),
```

- [ ] **Step 2: main IPC 핸들러**

`apps/desktop/src/main/index.ts`의 `execute-query-stream` 핸들러(line 503)에서 engine POST body에 `acknowledged: options?.acknowledged ?? false`를 추가(기존 `allowWrite`/`confirmDestructive`와 같은 위치). 그리고 `list-databases` 핸들러(line 396) 근처에 신규 핸들러 추가:
```ts
  ipcMain.handle('analyze-query', async (_event, profileId, query, database) => {
    try {
      const data = await requestEngine({
        method: 'POST',
        path: '/query/analyze',
        body: { profileId, query, database },
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
```

- [ ] **Step 3: 렌더러 타입**

`apps/renderer/src/global.d.ts`의 ElectronAPI 인터페이스에 추가:
```ts
  analyzeQuery: (profileId: string, query: string, database: string) => Promise<{ success: boolean; data?: AnalyzeResult; error?: string }>;
```
같은 파일에 타입 정의 추가:
```ts
export interface AnalyzeResult {
  level: 'safe' | 'warn' | 'medium' | 'high';
  verb: string;
  reasons: string[];
  table: string;
  hasWhere: boolean;
  tenantMissing: boolean;
  parseable: boolean;
  affectedRows: number | null;
  previewSql: string;
  previewCols: string[] | null;
  previewRows: any[][] | null;
  rollbackSql: string;
  rollbackNote: string;
}
```
그리고 `executeQueryStream` 옵션 타입에 `acknowledged?: boolean`를 추가.

- [ ] **Step 4: 빌드 확인**

Run: `pnpm --filter desktop build && pnpm --filter renderer build`
Expected: 타입체크/빌드 성공

- [ ] **Step 5: 커밋**

```bash
git add apps/desktop/src/preload/index.ts apps/desktop/src/main/index.ts apps/renderer/src/global.d.ts
git commit -m "feat(renderer): analyze-query IPC + acknowledged 옵션 배선 (#102)"
```

---

## Task 13: 렌더러 — safeMode.ts 매핑 로직 (TDD)

**Files:**
- Create: `apps/renderer/src/lib/safeMode.ts`
- Test: `apps/renderer/src/lib/safeMode.test.ts`

다이얼로그가 쓰기 좋은 뷰모델로 analyze 결과를 변환하고, "강제 실행 필요" 여부를 판정한다.

- [ ] **Step 1: 실패 테스트 작성**

`safeMode.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { toRiskView, requiresAcknowledgement, riskLabel } from './safeMode';
import type { AnalyzeResult } from '../global';

const base: AnalyzeResult = {
  level: 'high', verb: 'DELETE', reasons: ['no where'], table: 'User',
  hasWhere: false, tenantMissing: false, parseable: true,
  affectedRows: 5, previewSql: 'SELECT * FROM `User`', previewCols: ['id'],
  previewRows: [[1]], rollbackSql: 'INSERT ...', rollbackNote: '',
};

describe('safeMode', () => {
  it('requires acknowledgement for high risk in safe mode', () => {
    expect(requiresAcknowledgement(base, true)).toBe(true);
    expect(requiresAcknowledgement(base, false)).toBe(false);
    expect(requiresAcknowledgement({ ...base, level: 'medium' }, true)).toBe(false);
  });

  it('maps level to a Korean label', () => {
    expect(riskLabel('high')).toContain('위험');
    expect(riskLabel('safe')).toContain('안전');
  });

  it('builds a view with affected-row text', () => {
    const v = toRiskView(base);
    expect(v.affectedText).toContain('5');
    expect(v.hasRollback).toBe(true);
  });

  it('handles null affected rows', () => {
    const v = toRiskView({ ...base, affectedRows: null });
    expect(v.affectedText).toMatch(/알 수 없|—|N\/A/);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm --filter renderer test safeMode`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`safeMode.ts`:
```ts
import type { AnalyzeResult } from '../global';

export type RiskLevel = AnalyzeResult['level'];

export function riskLabel(level: RiskLevel): string {
  switch (level) {
    case 'high': return '위험';
    case 'medium': return '주의';
    case 'warn': return '경고';
    default: return '안전';
  }
}

export function riskClass(level: RiskLevel): string {
  return `risk-${level}`;
}

// requiresAcknowledgement is true when a safe-mode connection must force the
// user through an explicit "강제 실행" step (high risk only).
export function requiresAcknowledgement(r: AnalyzeResult, safeMode: boolean): boolean {
  return safeMode && r.level === 'high';
}

export interface RiskView {
  level: RiskLevel;
  label: string;
  verb: string;
  table: string;
  reasons: string[];
  affectedText: string;
  tenantMissing: boolean;
  previewSql: string;
  previewCols: string[];
  previewRows: any[][];
  hasRollback: boolean;
  rollbackSql: string;
  rollbackNote: string;
}

export function toRiskView(r: AnalyzeResult): RiskView {
  const affectedText = r.affectedRows == null
    ? '알 수 없음'
    : `${r.affectedRows.toLocaleString()}건`;
  return {
    level: r.level,
    label: riskLabel(r.level),
    verb: r.verb,
    table: r.table,
    reasons: r.reasons ?? [],
    affectedText,
    tenantMissing: r.tenantMissing,
    previewSql: r.previewSql ?? '',
    previewCols: r.previewCols ?? [],
    previewRows: r.previewRows ?? [],
    hasRollback: !!r.rollbackSql,
    rollbackSql: r.rollbackSql ?? '',
    rollbackNote: r.rollbackNote ?? '',
  };
}
```
> `AnalyzeResult` 타입은 Task 12에서 `global.d.ts`에 정의됨. 테스트 import 경로(`../global`)가 맞도록, global.d.ts가 모듈로 export하지 않으면 `apps/renderer/src/lib/types.ts`에 동일 인터페이스를 두고 거기서 import하도록 조정한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm --filter renderer test safeMode`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add apps/renderer/src/lib/safeMode.ts apps/renderer/src/lib/safeMode.test.ts
git commit -m "feat(renderer): safeMode 위험 뷰모델 매핑 (#102)"
```

---

## Task 14: 렌더러 — RiskConfirmDialog 컴포넌트

**Files:**
- Create: `apps/renderer/src/components/RiskConfirmDialog.tsx`
- Test: `apps/renderer/src/components/RiskConfirmDialog.test.tsx`

- [ ] **Step 1: 실패 렌더 테스트 작성**

`RiskConfirmDialog.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RiskConfirmDialog } from './RiskConfirmDialog';
import type { AnalyzeResult } from '../global';

const result: AnalyzeResult = {
  level: 'high', verb: 'DELETE', reasons: ['WHERE 없음'], table: 'User',
  hasWhere: false, tenantMissing: true, parseable: true, affectedRows: 12,
  previewSql: 'SELECT * FROM `User`', previewCols: ['id'], previewRows: [[1]],
  rollbackSql: 'INSERT INTO `User` ...', rollbackNote: '',
};

describe('RiskConfirmDialog', () => {
  it('shows affected rows and blocks run until acknowledged in safe mode', () => {
    const onRun = vi.fn();
    render(<RiskConfirmDialog result={result} safeMode={true} onRun={onRun} onCancel={() => {}} />);
    expect(screen.getByText(/12/)).toBeInTheDocument();
    const runBtn = screen.getByRole('button', { name: /실행/ });
    expect(runBtn).toBeDisabled(); // ack 체크 전
    fireEvent.click(screen.getByLabelText(/강제 실행/));
    expect(runBtn).not.toBeDisabled();
    fireEvent.click(runBtn);
    expect(onRun).toHaveBeenCalled();
  });

  it('allows run immediately in normal mode', () => {
    const onRun = vi.fn();
    render(<RiskConfirmDialog result={result} safeMode={false} onRun={onRun} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /실행/ }));
    expect(onRun).toHaveBeenCalled();
  });
});
```
> 기존 컴포넌트 테스트의 setup(`@testing-library/jest-dom`, vitest jsdom 환경)을 따른다. 없으면 동일 패턴의 기존 테스트 파일을 참고해 맞춘다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm --filter renderer test RiskConfirmDialog`
Expected: FAIL — 컴포넌트 없음

- [ ] **Step 3: 구현**

`RiskConfirmDialog.tsx`:
```tsx
import { useState } from 'react';
import type { AnalyzeResult } from '../global';
import { toRiskView, requiresAcknowledgement, riskClass } from '../lib/safeMode';

interface Props {
  result: AnalyzeResult;
  safeMode: boolean;
  onRun: () => void;
  onCancel: () => void;
}

export function RiskConfirmDialog({ result, safeMode, onRun, onCancel }: Props) {
  const v = toRiskView(result);
  const needAck = requiresAcknowledgement(result, safeMode);
  const [ack, setAck] = useState(false);
  const canRun = !needAck || ack;

  const copy = (text: string) => navigator.clipboard?.writeText(text);

  return (
    <div className="risk-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="risk-dialog">
        <header className={`risk-header ${riskClass(v.level)}`}>
          <span className="risk-badge">{v.label}</span>
          <span className="risk-verb">{v.verb} · {v.table || '—'}</span>
        </header>

        <section className="risk-body">
          <dl className="risk-facts">
            <dt>예상 영향 row</dt><dd>{v.affectedText}</dd>
            {v.tenantMissing && <><dt>tenant 조건</dt><dd className="risk-warn-text">누락</dd></>}
          </dl>

          {v.reasons.length > 0 && (
            <ul className="risk-reasons">
              {v.reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          )}

          {v.previewSql && (
            <div className="risk-section">
              <div className="risk-section-head">
                <span>SELECT Preview</span>
                <button onClick={() => copy(v.previewSql)}>복사</button>
              </div>
              <pre className="risk-sql">{v.previewSql}</pre>
            </div>
          )}

          {v.hasRollback ? (
            <div className="risk-section">
              <div className="risk-section-head">
                <span>Rollback SQL</span>
                <button onClick={() => copy(v.rollbackSql)}>복사</button>
              </div>
              <pre className="risk-sql risk-rollback">{v.rollbackSql}</pre>
            </div>
          ) : v.rollbackNote ? (
            <p className="risk-note">{v.rollbackNote}</p>
          ) : null}
        </section>

        <footer className="risk-footer">
          {needAck && (
            <label className="risk-ack">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              강제 실행 (운영 DB · 위험을 확인했습니다)
            </label>
          )}
          <div className="risk-actions">
            <button onClick={onCancel}>취소</button>
            <button className="risk-run" disabled={!canRun} onClick={onRun}>실행</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm --filter renderer test RiskConfirmDialog`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add apps/renderer/src/components/RiskConfirmDialog.tsx apps/renderer/src/components/RiskConfirmDialog.test.tsx
git commit -m "feat(renderer): RiskConfirmDialog 위험 확인 다이얼로그 (#102)"
```

---

## Task 15: 렌더러 — 연결 폼 필드 + QueryEditor 배선 + CSS

**Files:**
- Modify: 연결 폼 컴포넌트 (`apps/renderer/src/components/ConnectionForm.tsx` 또는 실제 폼 파일 — 먼저 `grep -rl "readOnly" apps/renderer/src/components`로 확인)
- Modify: `apps/renderer/src/components/QueryEditor.tsx` (executeQuery, ~line 400)
- Modify: `apps/renderer/src/App.css`

- [ ] **Step 1: 연결 폼에 안전 모드 필드 추가**

연결 폼에서 기존 `readOnly` 체크박스 근처에 추가(상태/직렬화 포함):
```tsx
<label className="form-check">
  <input type="checkbox" checked={safeMode} onChange={(e) => setSafeMode(e.target.checked)} />
  안전 모드 (운영 DB)
</label>
{safeMode && (
  <label className="form-field">
    tenant 스코프 컬럼 (쉼표 구분)
    <input type="text" value={tenantColumns} placeholder="hospitalId,tenantId"
      onChange={(e) => setTenantColumns(e.target.value)} />
  </label>
)}
```
프로필 저장 페이로드(create/update)에 `safeMode`, `tenantColumns` 포함. 편집 시 기존 프로필에서 두 값 로드. (폼의 기존 `readOnly` 처리 패턴을 그대로 따른다.)

- [ ] **Step 2: QueryEditor 실행 전 analyze 게이트**

`QueryEditor.tsx`의 `executeQuery()`(line 400)에서, 단일 statement가 위험(`classifyStatement(sql).risk === 'dangerous'` 또는 write verb)일 때 실제 실행 직전에 analyze를 호출하고 다이얼로그를 띄운다. 상태 추가:
```tsx
const [riskResult, setRiskResult] = useState<AnalyzeResult | null>(null);
const pendingRunRef = useRef<null | (() => void)>(null);
```
실행 직전 분기(스트림 호출 `window.electronAPI.executeQueryStream(...)` 앞):
```tsx
const danger = classifyStatement(stmt);
if (danger.risk === 'dangerous' || isWriteVerb(stmt)) {
  const res = await window.electronAPI.analyzeQuery(profileId, stmt, database);
  if (res.success && res.data) {
    return await new Promise<void>((resolve) => {
      pendingRunRef.current = () => {
        setRiskResult(null);
        // acknowledged=true 전달 (안전모드 high면 ack 후에만 도달)
        runStreamingStatement(stmt, { allowWrite: true, confirmDestructive: true, acknowledged: true })
          .then(resolve);
      };
      setRiskResult(res.data);
    });
  }
}
```
다이얼로그 렌더(컴포넌트 JSX 말미):
```tsx
{riskResult && (
  <RiskConfirmDialog
    result={riskResult}
    safeMode={focusedProfile?.safeMode ?? false}
    onRun={() => pendingRunRef.current?.()}
    onCancel={() => { setRiskResult(null); pendingRunRef.current = null; }}
  />
)}
```
`isWriteVerb`는 `sqlDanger`나 간단한 정규식으로 `^(UPDATE|DELETE|INSERT|TRUNCATE|DROP|ALTER|REPLACE|MERGE)\b` 판정. `runStreamingStatement`는 기존 단일 statement 스트리밍 로직을 옵션 받는 형태로 추출(이미 `allowWrite`/`confirmDestructive`를 options로 받으므로 `acknowledged`만 추가). `executeQueryStream` 호출 options에 `acknowledged` 포함.

> 핵심 불변식: 안전모드 high 위험이면 엔진이 `acknowledgement_required(409)`를 돌려준다. 렌더러는 다이얼로그에서 "강제 실행" 체크 후에만 `onRun`→`acknowledged:true`로 재요청하므로 통과한다. 일반 모드는 다이얼로그에서 바로 실행 가능하고 `acknowledged`는 무시된다.

- [ ] **Step 3: CSS 추가**

`App.css` 끝에 다이얼로그 스타일 추가:
```css
.risk-dialog-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5);
  display: flex; align-items: center; justify-content: center; z-index: 1000; }
.risk-dialog { background: var(--panel-bg, #1e1e1e); color: var(--text, #eee);
  width: min(640px, 92vw); max-height: 86vh; overflow: auto; border-radius: 8px;
  box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
.risk-header { display: flex; align-items: center; gap: 10px; padding: 14px 18px;
  border-bottom: 1px solid var(--border, #333); }
.risk-badge { font-weight: 700; padding: 2px 10px; border-radius: 12px; color: #fff; }
.risk-header.risk-high .risk-badge { background: #c0392b; }
.risk-header.risk-medium .risk-badge { background: #d68910; }
.risk-header.risk-warn .risk-badge { background: #b7950b; }
.risk-header.risk-safe .risk-badge { background: #229954; }
.risk-verb { opacity: 0.8; font-family: monospace; }
.risk-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; }
.risk-facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
.risk-facts dt { opacity: 0.7; } .risk-facts dd { margin: 0; font-weight: 600; }
.risk-warn-text { color: #e67e22; }
.risk-reasons { margin: 0; padding-left: 18px; color: #e0b050; }
.risk-section-head { display: flex; justify-content: space-between; align-items: center;
  font-size: 12px; opacity: 0.8; margin-bottom: 4px; }
.risk-sql { background: #111; padding: 10px; border-radius: 6px; font-size: 12px;
  white-space: pre-wrap; word-break: break-all; max-height: 180px; overflow: auto; }
.risk-rollback { border-left: 3px solid #229954; }
.risk-note { font-size: 13px; opacity: 0.75; }
.risk-footer { padding: 14px 18px; border-top: 1px solid var(--border, #333);
  display: flex; flex-direction: column; gap: 10px; }
.risk-ack { display: flex; align-items: center; gap: 8px; color: #e74c3c; font-weight: 600; }
.risk-actions { display: flex; justify-content: flex-end; gap: 10px; }
.risk-run { background: #c0392b; color: #fff; border: none; padding: 7px 16px; border-radius: 6px; }
.risk-run:disabled { opacity: 0.4; cursor: not-allowed; }
```

- [ ] **Step 4: 빌드 + 렌더러 테스트 확인**

Run: `pnpm --filter renderer test && pnpm --filter renderer build && pnpm --filter desktop build`
Expected: 전부 통과

- [ ] **Step 5: 커밋**

```bash
git add apps/renderer/src/components/ apps/renderer/src/App.css
git commit -m "feat(renderer): 연결 폼 안전모드 + QueryEditor analyze 게이트 + CSS (#102)"
```

---

## Task 16: 검증 — 전체 빌드/테스트 + CDP 라이브

**Files:** (없음 — 검증 전용)

- [ ] **Step 1: 엔진 전체 테스트 + 빌드**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/... && /Users/smlee/sdk/go/bin/go build ./engine/...`
Expected: PASS

- [ ] **Step 2: analyze 통합 테스트 (dev-mysql 필요)**

Run: `/Users/smlee/sdk/go/bin/go test -tags=integration ./engine/internal/transport/http/ -run TestEnrichReport -v`
Expected: PASS (dev-mysql 가동 시). 미가동 시 skip 로그 확인.

- [ ] **Step 3: 렌더러 전체 테스트 + 빌드**

Run: `pnpm --filter renderer test && pnpm --filter renderer build && pnpm --filter desktop build`
Expected: PASS

- [ ] **Step 4: CDP 라이브 검증 (앱 실행)**

앱을 dev로 띄우고 CDP로 다음을 확인:
1. 안전 모드 연결 생성(dev-mysql, safeMode 체크, tenantColumns=hospitalId) → 저장/재로드 시 값 유지.
2. `erg_safe_test` 임시 테이블 생성(에디터에서). `DELETE FROM erg_safe_test WHERE hospitalId=153` 실행 → RiskConfirmDialog 표시: 위험=위험(high), 예상 영향 row 수, SELECT Preview, Rollback SQL(INSERT...) 표시. "강제 실행" 체크 전 실행 버튼 비활성, 체크 후 활성.
3. 실행 → 정상 삭제. Rollback SQL 복사해 실행 → 행 복구 확인.
4. `UPDATE erg_safe_test SET name='x'` (WHERE 없음) → high + ack 요구 확인.
5. 일반 모드(safeMode off) 연결에서 같은 쿼리 → 다이얼로그는 뜨되 ack 체크박스 없이 바로 실행 가능.
6. 정리: `DROP TABLE erg_safe_test`.

스크린샷으로 다이얼로그 before/after 기록.

- [ ] **Step 5: 정리 + 최종 커밋(있으면)**

검증 중 수정이 있으면 커밋. 없으면 스킵.

```bash
git add -A && git commit -m "test: 안전 실행 모드 CDP 라이브 검증 (#102)" || echo "no changes"
```

---

## Self-Review

**1. Spec coverage:**
- A 안전모드 프로필 모델 → Task 1, 2, 15(폼)
- B 위험 분석 → Task 3, 4, 5
- C analyze 엔드포인트(COUNT/preview/rollback) → Task 6, 7, 8, 9, 10
- D 렌더러 확인 플로우 → Task 12, 13, 14, 15
- E 안전모드 엔진 강제 → Task 11
- 테스트 전략 → 각 Task TDD + Task 16
- 완료 기준 7개 모두 매핑됨(이슈 #102)

**2. Placeholder scan:** 코드 스텁(Task 3 parser, Task 9 enrichReport)은 명시적으로 "다음 Task에서 교체"로 표기 — 의도된 중간 상태이며 최종 placeholder 아님. 통합 테스트 헬퍼(`newAnalyzeTestHandler`)는 기존 패턴 참조로 작성 지시 — 완전한 코드를 주기엔 기존 테스트 인프라 의존이 커서 패턴 참조가 적절.

**3. Type consistency:** `RiskReport`/`ParsedDML`/`RiskLevel`(엔진), `AnalyzeResult`/`RiskView`(렌더러), `gateInput`/`gateResult`, `AnalyzeResponse` 필드명이 Task 간 일치. `enrichReport` 시그니처는 Task 9 스텁→Task 10 본구현 시 교체 명시. `BuildRollbackSQL(driver, p, snapshotCols, pkCols, rows)` 인자 순서가 Task 8 정의와 Task 10 호출에서 일치.
