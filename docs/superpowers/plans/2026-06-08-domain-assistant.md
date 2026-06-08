# 도메인 이해 기반 DB Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 연결별 도메인 사전(용어사전 + 규칙노트)을 만들고 기존 AgentChat의 system 프롬프트에 주입해, 자연어 질의를 도메인 맥락(예: `deletedAt IS NULL`, `hospitalId` 스코프)을 반영해 SQL로 변환·설명하게 한다.

**Architecture:** 별도 어시스턴트를 새로 만들지 않는다. (1) 프로필에 `domainGlossary`(JSON)·`domainNotes`(text) 두 필드를 추가하고, (2) 엔진 `/agent/run` 핸들러가 그 사전 + 기존 tenant/soft_delete 바인딩을 순수 함수로 직렬화해 `AgentService.SetDomainContext()`로 system 프롬프트 끝에 덧붙인다. (3) 렌더러는 스키마 자동 시드 + 주석 + AI 채우기로 사전을 편집하고 기존 도메인 설정 다이얼로그에 탭으로 통합한다. 빈 사전이면 주입을 생략해 기존 동작은 완전히 불변이다.

**Tech Stack:** Go 1.25 엔진(clean architecture, SQLite 메타데이터), React 19 + Vitest 렌더러, Electron IPC. Go: `/Users/smlee/sdk/go/bin/go`.

---

## File Structure

**엔진 (Go)**
- Modify `engine/internal/domain/connection.go` — `DomainGlossary`/`DomainNotes` 필드 + `DomainEntry` 타입 + `DomainGlossaryEntries()` 파서.
- Modify `engine/internal/domain/connection_test.go` — 파서 테스트.
- Modify `engine/cmd/app-engine/main.go` — 마이그레이션 v9(두 컬럼 추가).
- Modify `engine/internal/adapters/sqlite/sqlite_profile_repository.go` — 4개 쿼리 + scan에 두 컬럼.
- Modify `engine/internal/adapters/sqlite/sqlite_profile_repository_test.go` — round-trip 테스트.
- Create `engine/internal/agent/domain_context.go` — `BuildDomainContext` 순수 함수.
- Create `engine/internal/agent/domain_context_test.go` — 직렬화 테스트.
- Modify `engine/internal/agent/service.go` — `domain` 필드 + `SetDomainContext` + `request()` 결합.
- Modify `engine/internal/agent/service_test.go` — 주입 테스트.
- Modify `engine/internal/transport/http/agent.go` — Run 핸들러에서 `SetDomainContext` 배선.

**렌더러 (TS/React)**
- Create `apps/renderer/src/lib/domainGlossary.ts` — 순수: merge/serialize/parse.
- Create `apps/renderer/src/lib/domainGlossary.test.ts`.
- Create `apps/renderer/src/lib/domainFillPrompt.ts` — 순수: AI 채우기 프롬프트/파싱.
- Create `apps/renderer/src/lib/domainFillPrompt.test.ts`.
- Modify `apps/renderer/src/global.d.ts` — `ConnectionProfile`에 `domainGlossary?`/`domainNotes?`.
- Create `apps/renderer/src/components/DomainDictionaryEditor.tsx` — 사전 편집기(시드/주석/AI 채우기/규칙노트).
- Modify `apps/renderer/src/components/DomainBindingsDialog.tsx` — 탭 2개(역할 바인딩 / 용어사전·규칙)로 확장.
- Modify `apps/renderer/src/App.tsx` — 다이얼로그에 per-table 스키마 전달.
- Modify `apps/renderer/src/App.css` — 사전 편집기/탭 스타일(테마 토큰).

---

## Task 1: 엔진 도메인 — 사전 필드 + 파서

**Files:**
- Modify: `engine/internal/domain/connection.go`
- Test: `engine/internal/domain/connection_test.go`

- [ ] **Step 1: 실패 테스트 작성**

`engine/internal/domain/connection_test.go`에 추가:

```go
func TestDomainGlossaryEntries(t *testing.T) {
	p := ConnectionProfile{DomainGlossary: `[{"kind":"table","table":"User","column":"","meaning":"환자"},{"kind":"column","table":"User","column":"hospitalId","meaning":"병원 구분값"}]`}
	got := p.DomainGlossaryEntries()
	if len(got) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(got))
	}
	if got[0].Table != "User" || got[0].Meaning != "환자" || got[0].Kind != "table" {
		t.Errorf("entry0 wrong: %+v", got[0])
	}
	if got[1].Column != "hospitalId" || got[1].Meaning != "병원 구분값" {
		t.Errorf("entry1 wrong: %+v", got[1])
	}
}

func TestDomainGlossaryEntries_InvalidOrEmpty(t *testing.T) {
	for _, in := range []string{"", "   ", "not json", "{}"} {
		got := ConnectionProfile{DomainGlossary: in}.DomainGlossaryEntries()
		if len(got) != 0 {
			t.Errorf("input %q: expected 0 entries, got %d", in, len(got))
		}
	}
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/domain/ -run TestDomainGlossary -v`
Expected: FAIL — `p.DomainGlossary undefined` / `DomainGlossaryEntries undefined`.

- [ ] **Step 3: 최소 구현**

`engine/internal/domain/connection.go`의 `ConnectionProfile` 구조체에 `DomainBindings` 필드 바로 아래 추가:

```go
	// DomainGlossary is a JSON array of table/column business-meaning entries
	// (see DomainEntry). Injected into the AI assistant's system prompt so it
	// interprets natural-language queries with domain context. Empty = none.
	DomainGlossary string `json:"domainGlossary"`
	// DomainNotes is free-form domain rules text (e.g. "always deletedAt IS
	// NULL", "scope by hospitalId"). Injected alongside the glossary.
	DomainNotes string `json:"domainNotes"`
```

같은 파일 끝(메서드 영역)에 추가:

```go
// DomainEntry is one table- or column-level business-meaning mapping.
type DomainEntry struct {
	Kind    string `json:"kind"`    // "table" | "column"
	Table   string `json:"table"`   // table name
	Column  string `json:"column"`  // column name (empty for table entries)
	Meaning string `json:"meaning"` // business meaning
}

// DomainGlossaryEntries parses DomainGlossary JSON into entries. Invalid or
// empty JSON yields an empty slice (never nil-panics, mirrors DomainBindingMap).
func (p ConnectionProfile) DomainGlossaryEntries() []DomainEntry {
	if strings.TrimSpace(p.DomainGlossary) == "" {
		return nil
	}
	var out []DomainEntry
	_ = json.Unmarshal([]byte(p.DomainGlossary), &out)
	return out
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/domain/ -run TestDomainGlossary -v`
Expected: PASS (2 tests).

- [ ] **Step 5: 커밋**

```bash
git add engine/internal/domain/connection.go engine/internal/domain/connection_test.go
git commit -m "feat(engine): 도메인 사전 필드 + DomainGlossaryEntries 파서 (#103)"
```

---

## Task 2: 마이그레이션 v9 + 프로필 repo 영속화

**Files:**
- Modify: `engine/cmd/app-engine/main.go` (migrations 슬라이스, v8 항목 뒤)
- Modify: `engine/internal/adapters/sqlite/sqlite_profile_repository.go`
- Test: `engine/internal/adapters/sqlite/sqlite_profile_repository_test.go`

- [ ] **Step 1: 실패 테스트 작성**

`sqlite_profile_repository_test.go`에 추가(기존 테스트의 헬퍼/스키마 셋업 패턴을 따른다 — 기존 파일 상단의 테스트가 in-memory DB + 마이그레이션을 어떻게 세팅하는지 참고해 동일 방식으로 `domain_glossary`/`domain_notes` 컬럼을 포함한 테이블을 만들 것):

```go
func TestProfileRepo_DomainGlossaryRoundTrip(t *testing.T) {
	repo, cleanup := newTestProfileRepo(t) // 기존 헬퍼 이름에 맞춰 사용
	defer cleanup()
	ctx := context.Background()

	p := &domain.ConnectionProfile{
		ID: "p1", Name: "n", Driver: "mysql", Host: "h", Port: 3306,
		DomainGlossary: `[{"kind":"table","table":"User","column":"","meaning":"환자"}]`,
		DomainNotes:    "항상 deletedAt IS NULL",
		CreatedAt:      time.Now(), UpdatedAt: time.Now(),
	}
	if err := repo.Create(ctx, p); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.GetByID(ctx, "p1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.DomainGlossary != p.DomainGlossary {
		t.Errorf("glossary: got %q want %q", got.DomainGlossary, p.DomainGlossary)
	}
	if got.DomainNotes != p.DomainNotes {
		t.Errorf("notes: got %q want %q", got.DomainNotes, p.DomainNotes)
	}

	got.DomainNotes = "변경됨"
	if err := repo.Update(ctx, got); err != nil {
		t.Fatalf("update: %v", err)
	}
	again, _ := repo.GetByID(ctx, "p1")
	if again.DomainNotes != "변경됨" {
		t.Errorf("after update notes: got %q", again.DomainNotes)
	}
}
```

주의: 기존 테스트 파일이 테이블 DDL을 인라인으로 만들면 그 DDL에 `domain_glossary TEXT NOT NULL DEFAULT ''`, `domain_notes TEXT NOT NULL DEFAULT ''` 두 컬럼을 추가해야 한다. 마이그레이션 슬라이스를 직접 실행하는 헬퍼를 쓰면 Step 3의 v9가 자동 반영된다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/ -run TestProfileRepo_DomainGlossaryRoundTrip -v`
Expected: FAIL — `no such column: domain_glossary` 또는 scan 인자 불일치.

- [ ] **Step 3: 마이그레이션 v9 추가**

`engine/cmd/app-engine/main.go`의 migrations 슬라이스에서 `Version: 8` 항목 뒤에 추가:

```go
		{
			Version: 9,
			Name:    "add_profile_domain_glossary",
			SQL: `
				ALTER TABLE connection_profiles ADD COLUMN domain_glossary TEXT NOT NULL DEFAULT '';
				ALTER TABLE connection_profiles ADD COLUMN domain_notes TEXT NOT NULL DEFAULT '';
			`,
			Checksum: "profile-domain-glossary-v1",
		},
```

- [ ] **Step 4: repo 쿼리 4곳 + scan 갱신**

`sqlite_profile_repository.go`에서 컬럼 목록 끝(`domain_bindings` 뒤, `created_at` 앞)에 `domain_glossary, domain_notes`를 추가한다. 4곳 모두:

`Create` INSERT:
```go
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO connection_profiles (id, name, driver, host, port, database, username, secret_ref, tls_mode, mcp_enabled, mcp_data_exposure, read_only, connection_uri, safe_mode, tenant_columns, domain_bindings, domain_glossary, domain_notes, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, p.ID, p.Name, p.Driver, p.Host, p.Port, p.Database, p.Username, p.SecretRef, p.TLSMode, p.McpEnabled, p.McpDataExposure, p.ReadOnly, p.ConnectionURI, p.SafeMode, p.TenantColumns, p.DomainBindings, p.DomainGlossary, p.DomainNotes, p.CreatedAt, p.UpdatedAt)
```

`GetByID` SELECT 컬럼 + scan:
```go
		SELECT id, name, driver, host, port, database, username, secret_ref, tls_mode, mcp_enabled, mcp_data_exposure, read_only, connection_uri, safe_mode, tenant_columns, domain_bindings, domain_glossary, domain_notes, created_at, updated_at
		FROM connection_profiles WHERE id = ?
```
```go
	err := row.Scan(&p.ID, &p.Name, &p.Driver, &p.Host, &p.Port, &p.Database, &p.Username, &p.SecretRef, &p.TLSMode, &p.McpEnabled, &p.McpDataExposure, &p.ReadOnly, &p.ConnectionURI, &p.SafeMode, &p.TenantColumns, &p.DomainBindings, &p.DomainGlossary, &p.DomainNotes, &p.CreatedAt, &p.UpdatedAt)
```

`List` SELECT 컬럼 + scan: 동일하게 `domain_glossary, domain_notes`를 컬럼 목록과 `rows.Scan(... &p.DomainBindings, &p.DomainGlossary, &p.DomainNotes, &p.CreatedAt, &p.UpdatedAt)`에 추가.

`Update` SET 절:
```go
		SET name = ?, driver = ?, host = ?, port = ?, database = ?, username = ?, secret_ref = ?, tls_mode = ?, mcp_enabled = ?, mcp_data_exposure = ?, read_only = ?, connection_uri = ?, safe_mode = ?, tenant_columns = ?, domain_bindings = ?, domain_glossary = ?, domain_notes = ?, updated_at = ?
		WHERE id = ?
```
```go
	`, p.Name, p.Driver, p.Host, p.Port, p.Database, p.Username, p.SecretRef, p.TLSMode, p.McpEnabled, p.McpDataExposure, p.ReadOnly, p.ConnectionURI, p.SafeMode, p.TenantColumns, p.DomainBindings, p.DomainGlossary, p.DomainNotes, p.UpdatedAt, p.ID)
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/ -run TestProfileRepo_DomainGlossaryRoundTrip -v`
Expected: PASS.
또한 회귀 확인: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/`
Expected: 전부 PASS.

- [ ] **Step 6: 커밋**

```bash
git add engine/cmd/app-engine/main.go engine/internal/adapters/sqlite/
git commit -m "feat(engine): 마이그레이션 v9 + 프로필 도메인 사전 영속화 (#103)"
```

---

## Task 3: 도메인 컨텍스트 직렬화 (순수 함수)

**Files:**
- Create: `engine/internal/agent/domain_context.go`
- Test: `engine/internal/agent/domain_context_test.go`

- [ ] **Step 1: 실패 테스트 작성**

`engine/internal/agent/domain_context_test.go`:

```go
package agent

import (
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func TestBuildDomainContext_Empty(t *testing.T) {
	if got := BuildDomainContext(nil, "", nil, ""); got != "" {
		t.Errorf("expected empty string, got %q", got)
	}
	// whitespace-only notes + no entries/bindings = still empty
	if got := BuildDomainContext(nil, "   ", nil, ""); got != "" {
		t.Errorf("expected empty string for blank notes, got %q", got)
	}
}

func TestBuildDomainContext_Full(t *testing.T) {
	entries := []domain.DomainEntry{
		{Kind: "table", Table: "User", Meaning: "환자"},
		{Kind: "column", Table: "User", Column: "hospitalId", Meaning: "병원 구분값"},
	}
	got := BuildDomainContext(entries, "항상 deletedAt IS NULL", []string{"hospitalId"}, "deletedAt")

	for _, want := range []string{
		"도메인 맥락",
		"User (테이블) = 환자",
		"User.hospitalId (컬럼) = 병원 구분값",
		"항상 deletedAt IS NULL",
		"deletedAt",        // soft-delete 자동 규칙
		"hospitalId",       // tenant 자동 규칙
		"해석한 조건",        // intent-confirmation 지시
	} {
		if !strings.Contains(got, want) {
			t.Errorf("context missing %q\n---\n%s", want, got)
		}
	}
}

func TestBuildDomainContext_OnlyNotes(t *testing.T) {
	got := BuildDomainContext(nil, "규칙만 있음", nil, "")
	if !strings.Contains(got, "규칙만 있음") {
		t.Errorf("expected notes included, got %q", got)
	}
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/agent/ -run TestBuildDomainContext -v`
Expected: FAIL — `BuildDomainContext undefined`.

- [ ] **Step 3: 최소 구현**

`engine/internal/agent/domain_context.go`:

```go
package agent

import (
	"fmt"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

// BuildDomainContext serializes the connection's domain glossary, free-form
// rules, and tenant/soft-delete bindings into a Korean system-prompt block.
// Returns "" when there is nothing to inject (so the agent's default behavior
// is unchanged for connections without a domain dictionary).
func BuildDomainContext(entries []domain.DomainEntry, notes string, tenantCols []string, softDelete string) string {
	notes = strings.TrimSpace(notes)
	hasEntries := false
	for _, e := range entries {
		if strings.TrimSpace(e.Meaning) != "" {
			hasEntries = true
			break
		}
	}
	hasAuto := softDelete != "" || len(tenantCols) > 0
	if !hasEntries && notes == "" && !hasAuto {
		return ""
	}

	var b strings.Builder
	b.WriteString("## 도메인 맥락 (이 연결의 업무 의미)\n")

	if hasEntries {
		b.WriteString("다음 용어 의미를 반영해 질의를 해석하라:\n")
		for _, e := range entries {
			if strings.TrimSpace(e.Meaning) == "" {
				continue
			}
			if e.Kind == "column" && e.Column != "" {
				fmt.Fprintf(&b, "- %s.%s (컬럼) = %s\n", e.Table, e.Column, e.Meaning)
			} else {
				fmt.Fprintf(&b, "- %s (테이블) = %s\n", e.Table, e.Meaning)
			}
		}
	}

	if notes != "" {
		b.WriteString("도메인 규칙:\n")
		for _, line := range strings.Split(notes, "\n") {
			if t := strings.TrimSpace(line); t != "" {
				fmt.Fprintf(&b, "- %s\n", t)
			}
		}
	}

	if hasAuto {
		b.WriteString("자동 적용 규칙(사용자가 명시적으로 해제하지 않는 한):\n")
		if softDelete != "" {
			fmt.Fprintf(&b, "- soft-delete 컬럼 `%s` 은 IS NULL 로 필터한다.\n", softDelete)
		}
		if len(tenantCols) > 0 {
			fmt.Fprintf(&b, "- 특정 병원/조직이 언급되면 tenant 컬럼(%s)으로 범위를 제한한다.\n", strings.Join(tenantCols, ", "))
		}
	}

	b.WriteString("지시: 쓰기 또는 조회 SQL을 제안하기 전에, 네가 해석한 조건을 한국어 불릿 목록으로 먼저 제시하라.\n")
	return b.String()
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/agent/ -run TestBuildDomainContext -v`
Expected: PASS (3 tests).

- [ ] **Step 5: 커밋**

```bash
git add engine/internal/agent/domain_context.go engine/internal/agent/domain_context_test.go
git commit -m "feat(engine): BuildDomainContext 도메인 system 블록 직렬화 (#103)"
```

---

## Task 4: AgentService 주입 + 핸들러 배선

**Files:**
- Modify: `engine/internal/agent/service.go`
- Test: `engine/internal/agent/service_test.go`
- Modify: `engine/internal/transport/http/agent.go`

- [ ] **Step 1: 실패 테스트 작성**

`engine/internal/agent/service_test.go`에 추가(이 파일에 기존 fake provider 패턴이 있으면 재사용; 없으면 `request` 메서드를 직접 검증하는 화이트박스 테스트로 작성한다 — `service_test.go`는 `package agent`이므로 비공개 메서드 접근 가능):

```go
func TestServiceInjectsDomainContext(t *testing.T) {
	svc := NewAgentService(nil, nil, 16)
	base := svc.system
	svc.SetDomainContext("## 도메인 맥락\n- User (테이블) = 환자\n")

	req := svc.request([]ports.LLMMessage{{Role: "user", Text: "hi"}}, nil)
	if !strings.Contains(req.System, base) {
		t.Errorf("system should retain base prompt")
	}
	if !strings.Contains(req.System, "User (테이블) = 환자") {
		t.Errorf("system should include domain context, got:\n%s", req.System)
	}
}

func TestServiceNoDomainContextUnchanged(t *testing.T) {
	svc := NewAgentService(nil, nil, 16)
	req := svc.request([]ports.LLMMessage{{Role: "user", Text: "hi"}}, nil)
	if req.System != svc.system {
		t.Errorf("empty domain context must leave system unchanged")
	}
}
```

(파일 상단 import에 `strings`, `ports` 패키지 경로가 없으면 추가.)

- [ ] **Step 2: 테스트 실패 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/agent/ -run TestService -v`
Expected: FAIL — `SetDomainContext undefined`.

- [ ] **Step 3: 최소 구현**

`service.go` 구조체에 필드 추가(`secrets []string` 아래):
```go
	domain   string
```

메서드 추가(`SetSecrets` 근처):
```go
// SetDomainContext registers a domain-context block appended to the system
// prompt (glossary + rules + tenant/soft-delete bindings). Empty = no-op.
func (s *AgentService) SetDomainContext(ctx string) { s.domain = ctx }
```

`request()`를 도메인 결합하도록 수정. 기존:
```go
func (s *AgentService) request(messages []ports.LLMMessage, specs []ports.ToolSpec) ports.LLMRequest {
	if len(s.secrets) == 0 {
		return ports.LLMRequest{System: s.system, Messages: messages, Tools: specs}
	}
	scrubbed := make([]ports.LLMMessage, len(messages))
	for i, m := range messages {
		m.Text = Redact(m.Text, s.secrets)
		scrubbed[i] = m
	}
	return ports.LLMRequest{System: Redact(s.system, s.secrets), Messages: scrubbed, Tools: specs}
}
```
수정 후:
```go
func (s *AgentService) request(messages []ports.LLMMessage, specs []ports.ToolSpec) ports.LLMRequest {
	system := s.system
	if strings.TrimSpace(s.domain) != "" {
		system = s.system + "\n\n" + s.domain
	}
	if len(s.secrets) == 0 {
		return ports.LLMRequest{System: system, Messages: messages, Tools: specs}
	}
	scrubbed := make([]ports.LLMMessage, len(messages))
	for i, m := range messages {
		m.Text = Redact(m.Text, s.secrets)
		scrubbed[i] = m
	}
	return ports.LLMRequest{System: Redact(system, s.secrets), Messages: scrubbed, Tools: specs}
}
```
(`service.go`가 이미 `strings`를 import 함 — Redact가 사용 중. 확인만.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/agent/ -run TestService -v`
Expected: PASS.

- [ ] **Step 5: 핸들러 배선**

`engine/internal/transport/http/agent.go`의 Run 핸들러에서 `svc := agent.NewAgentService(provider, registry, 16)` 직후, `svc.SetPolicy(...)` 근처에 추가:

```go
		svc.SetDomainContext(agent.BuildDomainContext(
			profile.DomainGlossaryEntries(),
			profile.DomainNotes,
			profile.TenantColumnList(),
			profile.DomainBindingMap()["soft_delete"],
		))
```

(`profile`은 이미 `h.service.GetProfile`로 로드되어 있음.)

- [ ] **Step 6: 엔진 전체 빌드/테스트**

Run: `/Users/smlee/sdk/go/bin/go build ./engine/... && /Users/smlee/sdk/go/bin/go test ./engine/...`
Expected: 전부 PASS.

- [ ] **Step 7: 커밋**

```bash
git add engine/internal/agent/service.go engine/internal/agent/service_test.go engine/internal/transport/http/agent.go
git commit -m "feat(engine): AgentChat에 도메인 컨텍스트 주입 (#103)"
```

---

## Task 5: 렌더러 — 용어사전 순수 로직

**Files:**
- Create: `apps/renderer/src/lib/domainGlossary.ts`
- Test: `apps/renderer/src/lib/domainGlossary.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`apps/renderer/src/lib/domainGlossary.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mergeSchema, serializeGlossary, parseGlossary, type DomainEntry } from './domainGlossary';

describe('parseGlossary', () => {
  it('parses valid JSON', () => {
    const j = '[{"kind":"table","table":"User","column":"","meaning":"환자"}]';
    expect(parseGlossary(j)).toHaveLength(1);
  });
  it('returns [] for empty/invalid/undefined', () => {
    expect(parseGlossary(undefined)).toEqual([]);
    expect(parseGlossary('')).toEqual([]);
    expect(parseGlossary('nonsense')).toEqual([]);
  });
});

describe('serializeGlossary', () => {
  it('drops entries with blank meaning then JSON-stringifies', () => {
    const entries: DomainEntry[] = [
      { kind: 'table', table: 'User', column: '', meaning: '환자' },
      { kind: 'column', table: 'User', column: 'id', meaning: '' },
    ];
    const out = JSON.parse(serializeGlossary(entries));
    expect(out).toHaveLength(1);
    expect(out[0].meaning).toBe('환자');
  });
});

describe('mergeSchema', () => {
  it('seeds table+column rows, preserving existing meanings', () => {
    const existing: DomainEntry[] = [{ kind: 'table', table: 'User', column: '', meaning: '환자' }];
    const merged = mergeSchema(existing, ['User'], { User: ['id', 'hospitalId'] });
    // 1 table row + 2 column rows
    expect(merged).toHaveLength(3);
    const tableRow = merged.find((e) => e.kind === 'table' && e.table === 'User');
    expect(tableRow?.meaning).toBe('환자'); // preserved
    const colRow = merged.find((e) => e.kind === 'column' && e.column === 'hospitalId');
    expect(colRow?.meaning).toBe(''); // new, blank
  });
  it('keeps orphaned entries that still have a meaning', () => {
    const existing: DomainEntry[] = [{ kind: 'column', table: 'Old', column: 'gone', meaning: '의미있음' }];
    const merged = mergeSchema(existing, ['User'], { User: ['id'] });
    expect(merged.find((e) => e.column === 'gone')?.meaning).toBe('의미있음');
  });
  it('drops orphaned entries with no meaning', () => {
    const existing: DomainEntry[] = [{ kind: 'column', table: 'Old', column: 'gone', meaning: '' }];
    const merged = mergeSchema(existing, ['User'], { User: ['id'] });
    expect(merged.find((e) => e.column === 'gone')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd /Users/smlee/projects/product/database && pnpm --filter renderer test domainGlossary`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 최소 구현**

`apps/renderer/src/lib/domainGlossary.ts`:

```ts
export interface DomainEntry {
  kind: 'table' | 'column';
  table: string;
  column: string; // '' for table entries
  meaning: string;
}

/** Lenient parse: invalid/empty/undefined → []. */
export function parseGlossary(json: string | undefined): DomainEntry[] {
  if (!json || !json.trim()) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as DomainEntry[]) : [];
  } catch {
    return [];
  }
}

/** Drop blank-meaning entries, then JSON-stringify. */
export function serializeGlossary(entries: DomainEntry[]): string {
  return JSON.stringify(entries.filter((e) => e.meaning.trim() !== ''));
}

const key = (e: { table: string; column: string }) => `${e.table} ${e.column}`;

/**
 * Merge live schema (tables + columns-per-table) with existing entries:
 * preserve existing meanings, add new schema rows with blank meaning, keep
 * orphaned (schema-removed) entries only if they still carry a meaning.
 */
export function mergeSchema(
  existing: DomainEntry[],
  tables: string[],
  columnsByTable: Record<string, string[]>,
): DomainEntry[] {
  const byKey = new Map(existing.map((e) => [key(e), e]));
  const out: DomainEntry[] = [];
  const seen = new Set<string>();

  for (const t of tables) {
    const tk = key({ table: t, column: '' });
    out.push({ kind: 'table', table: t, column: '', meaning: byKey.get(tk)?.meaning ?? '' });
    seen.add(tk);
    for (const c of columnsByTable[t] ?? []) {
      const ck = key({ table: t, column: c });
      out.push({ kind: 'column', table: t, column: c, meaning: byKey.get(ck)?.meaning ?? '' });
      seen.add(ck);
    }
  }
  // orphans with a meaning survive (so manual annotations aren't lost)
  for (const e of existing) {
    if (!seen.has(key(e)) && e.meaning.trim() !== '') out.push(e);
  }
  return out;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd /Users/smlee/projects/product/database && pnpm --filter renderer test domainGlossary`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/renderer/src/lib/domainGlossary.ts apps/renderer/src/lib/domainGlossary.test.ts
git commit -m "feat(renderer): 도메인 용어사전 순수 로직 (merge/serialize/parse) (#103)"
```

---

## Task 6: 렌더러 — AI 채우기 프롬프트/파싱

**Files:**
- Create: `apps/renderer/src/lib/domainFillPrompt.ts`
- Test: `apps/renderer/src/lib/domainFillPrompt.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`apps/renderer/src/lib/domainFillPrompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildFillPrompt, parseFillResponse } from './domainFillPrompt';

describe('buildFillPrompt', () => {
  it('includes schema names and asks for JSON; appends user text', () => {
    const { system, user } = buildFillPrompt(['User'], { User: ['id', 'hospitalId'] }, 'User는 환자');
    expect(system).toMatch(/JSON/);
    expect(user).toContain('User');
    expect(user).toContain('hospitalId');
    expect(user).toContain('User는 환자');
  });
  it('works without user text', () => {
    const { user } = buildFillPrompt(['User'], { User: ['id'] });
    expect(user).toContain('User');
  });
});

describe('parseFillResponse', () => {
  it('extracts entries from a JSON array, even with surrounding prose/fences', () => {
    const text = '여기 있습니다:\n```json\n[{"kind":"table","table":"User","column":"","meaning":"환자"}]\n```';
    const out = parseFillResponse(text);
    expect(out).toHaveLength(1);
    expect(out[0].meaning).toBe('환자');
  });
  it('returns [] when no JSON array present', () => {
    expect(parseFillResponse('죄송합니다 모르겠어요')).toEqual([]);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd /Users/smlee/projects/product/database && pnpm --filter renderer test domainFillPrompt`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 최소 구현**

`apps/renderer/src/lib/domainFillPrompt.ts`:

```ts
import type { DomainEntry } from './domainGlossary';

/**
 * Build a tool-free /agent/complete prompt that asks the model to propose
 * business meanings for the given schema. Only metadata (table/column names)
 * is sent — never row data — so no data-exposure consent is required.
 */
export function buildFillPrompt(
  tables: string[],
  columnsByTable: Record<string, string[]>,
  userText?: string,
): { system: string; user: string } {
  const system =
    '너는 DB 도메인 전문가다. 주어진 스키마(테이블/컬럼명)에 대해 각 항목의 업무 의미를 한국어로 추정하라. ' +
    '반드시 JSON 배열만 출력하라. 각 원소는 {"kind":"table"|"column","table":"<테이블>","column":"<컬럼 또는 빈문자열>","meaning":"<업무 의미>"} 형식이다. ' +
    '확실하지 않으면 그 항목은 생략하라. 설명 문장 없이 JSON 배열만 출력하라.';

  const lines: string[] = ['스키마:'];
  for (const t of tables) {
    lines.push(`- 테이블 ${t}: ${(columnsByTable[t] ?? []).join(', ')}`);
  }
  if (userText && userText.trim()) {
    lines.push('', '사용자 설명(우선 반영):', userText.trim());
  }
  return { system, user: lines.join('\n') };
}

/** Extract a JSON array of DomainEntry from a model response (lenient). */
export function parseFillResponse(text: string): DomainEntry[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(v)) return [];
    return v
      .filter((e) => e && typeof e.meaning === 'string' && typeof e.table === 'string')
      .map((e) => ({
        kind: e.kind === 'column' ? 'column' : 'table',
        table: String(e.table),
        column: typeof e.column === 'string' ? e.column : '',
        meaning: String(e.meaning),
      }));
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd /Users/smlee/projects/product/database && pnpm --filter renderer test domainFillPrompt`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/renderer/src/lib/domainFillPrompt.ts apps/renderer/src/lib/domainFillPrompt.test.ts
git commit -m "feat(renderer): 도메인 사전 AI 채우기 프롬프트/파싱 (#103)"
```

---

## Task 7: 렌더러 — 타입 + 사전 편집기 컴포넌트

**Files:**
- Modify: `apps/renderer/src/global.d.ts`
- Create: `apps/renderer/src/components/DomainDictionaryEditor.tsx`

- [ ] **Step 1: 타입 추가**

`apps/renderer/src/global.d.ts`의 `ConnectionProfile` 인터페이스에서 `domainBindings?: string;` 아래 추가:
```ts
  domainGlossary?: string;
  domainNotes?: string;
```
같은 두 필드를 `App.tsx`의 로컬 `ConnectionProfile`형(58~59행 근처 `domainBindings?: string;` 아래)에도 추가:
```ts
  domainGlossary?: string;
  domainNotes?: string;
```

- [ ] **Step 2: 편집기 컴포넌트 작성**

`apps/renderer/src/components/DomainDictionaryEditor.tsx`. AI 채우기는 #104의 `generateNarration`(→`/agent/complete`)를 스트리밍 호출하고 `onAgentStreamChunk`로 누적한다(ResultNarrator와 동일 패턴). 스키마명만 전송하므로 프라이버시 게이트 불필요.

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DomainEntry } from '../lib/domainGlossary';
import { mergeSchema, parseGlossary, serializeGlossary } from '../lib/domainGlossary';
import { buildFillPrompt, parseFillResponse } from '../lib/domainFillPrompt';
import { loadAgentSettings, isOAuthProvider } from '../lib/agentSettings';

interface Props {
  profileId: string;
  glossaryJson?: string;
  notes?: string;
  tables: string[];
  columnsByTable: Record<string, string[]>;
  onChange: (glossaryJson: string, notes: string) => void;
}

export function DomainDictionaryEditor({ profileId, glossaryJson, notes, tables, columnsByTable, onChange }: Props) {
  const [entries, setEntries] = useState<DomainEntry[]>(() =>
    mergeSchema(parseGlossary(glossaryJson), tables, columnsByTable),
  );
  const [noteText, setNoteText] = useState(notes ?? '');
  const [filter, setFilter] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiText, setAiText] = useState('');
  const [aiHint, setAiHint] = useState('');
  const offRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { offRef.current?.(); }, []);

  // re-seed if the schema arrives after mount
  useEffect(() => {
    setEntries((cur) => mergeSchema(cur, tables, columnsByTable));
  }, [tables, columnsByTable]);

  // bubble changes upward
  useEffect(() => { onChange(serializeGlossary(entries), noteText); }, [entries, noteText, onChange]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) => e.table.toLowerCase().includes(q) || e.column.toLowerCase().includes(q) || e.meaning.toLowerCase().includes(q),
    );
  }, [entries, filter]);

  function setMeaning(target: DomainEntry, meaning: string) {
    setEntries((cur) => cur.map((e) => (e.table === target.table && e.column === target.column && e.kind === target.kind ? { ...e, meaning } : e)));
  }

  function applyProposals(props: DomainEntry[]) {
    if (props.length === 0) return;
    const pk = (e: DomainEntry) => `${e.kind} ${e.table} ${e.column}`;
    const map = new Map(props.map((p) => [pk(p), p.meaning]));
    setEntries((cur) => cur.map((e) => (e.meaning.trim() === '' && map.has(pk(e)) ? { ...e, meaning: map.get(pk(e))! } : e)));
  }

  async function aiFill() {
    const s = loadAgentSettings();
    // availability check
    const status = isOAuthProvider(s.provider)
      ? await window.electronAPI.agentOAuthStatus(s.provider)
      : await window.electronAPI.agentKeyStatus(s.provider);
    const data = status?.data as Record<string, unknown> | undefined;
    const ready = !!(status?.success && (data?.['present'] || data?.['loggedIn']));
    if (!ready) {
      setAiHint('AI 미설정 — 어시스턴트에서 provider/키를 설정하세요.');
      return;
    }
    setAiBusy(true); setAiText(''); setAiHint('');
    const { system, user } = buildFillPrompt(tables, columnsByTable);
    const runId = `domfill-${profileId}`;
    let acc = '';
    const off = window.electronAPI.onAgentStreamChunk((rid, chunk) => {
      if (rid !== runId) return;
      if (chunk.kind === 'text') { acc += chunk.text ?? ''; setAiText(acc); }
      else if (chunk.kind === 'error') { setAiHint(`AI 오류: ${chunk.text ?? ''}`); setAiBusy(false); off(); offRef.current = null; }
      else if (chunk.kind === 'done') { applyProposals(parseFillResponse(acc)); setAiBusy(false); off(); offRef.current = null; }
    });
    offRef.current = off;
    const res = await window.electronAPI.generateNarration(runId, profileId, system, [{ role: 'user', text: user }], { provider: s.provider, model: s.model });
    if (!res.success) { setAiHint(res.error ?? 'AI 호출 실패'); setAiBusy(false); off(); offRef.current = null; }
  }

  // group filtered rows by table for display
  const byTable = useMemo(() => {
    const m: Record<string, DomainEntry[]> = {};
    for (const e of filtered) (m[e.table] ??= []).push(e);
    return m;
  }, [filtered]);

  return (
    <div className="domain-dict">
      <div className="domain-dict-toolbar">
        <input className="domain-dict-search" placeholder="테이블·컬럼·의미 검색" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn btn-sm" onClick={aiFill} disabled={aiBusy}>{aiBusy ? 'AI 채우는 중…' : 'AI로 채우기'}</button>
      </div>
      {aiHint && <p className="domain-dict-hint">{aiHint}</p>}
      <div className="domain-dict-grid">
        {Object.keys(byTable).map((t) => (
          <div key={t} className="domain-dict-table">
            {byTable[t].map((e) => (
              <div key={`${e.kind}-${e.table}-${e.column}`} className={`domain-dict-row${e.kind === 'table' ? ' is-table' : ''}`}>
                <span className="domain-dict-name">{e.kind === 'table' ? e.table : `· ${e.column}`}</span>
                <input className="domain-dict-meaning" placeholder="업무 의미" value={e.meaning} onChange={(ev) => setMeaning(e, ev.target.value)} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <label className="domain-dict-notes-label">도메인 규칙 (자유 서술)</label>
      <textarea className="domain-dict-notes" rows={4} placeholder={'예: 항상 deletedAt IS NULL\nhospitalId로 범위 제한'} value={noteText} onChange={(e) => setNoteText(e.target.value)} />
    </div>
  );
}
```

- [ ] **Step 3: 빌드/타입체크**

Run: `cd /Users/smlee/projects/product/database && pnpm --filter renderer build`
Expected: 성공(타입 에러 없음). `onAgentStreamChunk`/`generateNarration`/`agentOAuthStatus`/`agentKeyStatus` 시그니처는 global.d.ts에 이미 존재.

- [ ] **Step 4: 커밋**

```bash
git add apps/renderer/src/global.d.ts apps/renderer/src/components/DomainDictionaryEditor.tsx
git commit -m "feat(renderer): 도메인 사전 편집기 컴포넌트 (시드/주석/AI 채우기) (#103)"
```

---

## Task 8: 도메인 설정 탭 통합 + 스키마 배선 + CSS

**Files:**
- Modify: `apps/renderer/src/components/DomainBindingsDialog.tsx`
- Modify: `apps/renderer/src/App.tsx`
- Modify: `apps/renderer/src/App.css`

- [ ] **Step 1: 다이얼로그를 탭 구조로 확장**

`DomainBindingsDialog.tsx`를 수정해 두 탭(역할 바인딩 / 용어사전·규칙)을 갖게 한다. props에 per-table 스키마와 도메인 사전 저장 핸들러를 추가한다. 기존 역할 바인딩 UI(현재 `<section className="risk-body">`의 ROLES 매핑)는 탭 1로 그대로 유지하고, 탭 2에 `DomainDictionaryEditor`를 마운트한다. 저장 시 두 탭의 값을 한 번에 `updateProfile`로 보낸다.

기존 `save()`를 수정해 glossary/notes도 포함:
```tsx
import { DomainDictionaryEditor } from './DomainDictionaryEditor';
// ...
interface Props {
  profile: ConnectionProfile;
  columns: string[];
  tables: string[];
  columnsByTable: Record<string, string[]>;
  onClose: () => void;
  onSaved: () => void;
}
```
컴포넌트 본문에 탭 상태 + 사전 상태 추가:
```tsx
  const [tab, setTab] = useState<'roles' | 'glossary'>('roles');
  const [glossary, setGlossary] = useState(profile.domainGlossary ?? '');
  const [notes, setNotes] = useState(profile.domainNotes ?? '');
```
`save()` 내부 `updateProfile` 호출을 다음으로 교체:
```tsx
    await window.electronAPI.updateProfile({
      ...profile,
      domainBindings: JSON.stringify(cleaned),
      domainGlossary: glossary,
      domainNotes: notes,
    });
```
`<section className="risk-body">` 위에 탭 헤더, 그리고 본문을 탭에 따라 렌더:
```tsx
        <div className="domain-tabs">
          <button className={`domain-tab${tab === 'roles' ? ' active' : ''}`} onClick={() => setTab('roles')}>역할 바인딩</button>
          <button className={`domain-tab${tab === 'glossary' ? ' active' : ''}`} onClick={() => setTab('glossary')}>용어사전·규칙</button>
        </div>
        <section className="risk-body">
          {tab === 'roles' ? (
            <>{/* 기존 ROLES 매핑 UI 그대로 */}</>
          ) : (
            <DomainDictionaryEditor
              profileId={profile.id}
              glossaryJson={profile.domainGlossary}
              notes={profile.domainNotes}
              tables={tables}
              columnsByTable={columnsByTable}
              onChange={(g, n) => { setGlossary(g); setNotes(n); }}
            />
          )}
        </section>
```

- [ ] **Step 2: App.tsx — per-table 스키마 제공**

App.tsx에서 도메인 다이얼로그가 열릴 때 per-table 컬럼 맵을 만든다. 이미 `getSchemaCompletion` 결과로 `tplSchema`를 채우는 코드(약 200~207행)가 있다. 그 옆에 `columnsByTable` 상태를 추가한다:
```tsx
  const [tplColumnsByTable, setTplColumnsByTable] = useState<Record<string, string[]>>({});
```
`getSchemaCompletion` 응답 처리부에서 함께 채운다(기존 `setTplSchema(...)` 직후):
```tsx
        setTplColumnsByTable(Object.fromEntries(res.data.tables.map((t) => [t.name, t.columns.map((c) => c.name)])));
```
`<DomainBindingsDialog ...>` 호출(약 1145행)에 props 추가:
```tsx
          tables={tplSchema.tables}
          columnsByTable={tplColumnsByTable}
```

- [ ] **Step 3: CSS 추가**

`apps/renderer/src/App.css` 끝에 추가(테마 토큰 사용):
```css
.domain-tabs { display: flex; gap: 4px; padding: 0 16px; border-bottom: 1px solid var(--border); }
.domain-tab { background: none; border: none; padding: 8px 12px; color: var(--text-2); cursor: pointer; border-bottom: 2px solid transparent; }
.domain-tab.active { color: var(--text); border-bottom-color: var(--accent); }
.domain-dict { display: flex; flex-direction: column; gap: 8px; }
.domain-dict-toolbar { display: flex; gap: 8px; align-items: center; }
.domain-dict-search { flex: 1; background: var(--bg-input); border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 6px 8px; }
.domain-dict-hint { color: var(--text-3); font-size: 12px; margin: 0; }
.domain-dict-grid { max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.domain-dict-table { display: flex; flex-direction: column; gap: 2px; }
.domain-dict-row { display: flex; align-items: center; gap: 8px; }
.domain-dict-row.is-table { margin-top: 4px; }
.domain-dict-name { flex: 0 0 200px; color: var(--text-2); font-size: 13px; }
.domain-dict-row.is-table .domain-dict-name { color: var(--text); font-weight: 600; }
.domain-dict-meaning { flex: 1; background: var(--bg-input); border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 4px 8px; }
.domain-dict-notes-label { color: var(--text-2); font-size: 13px; margin-top: 4px; }
.domain-dict-notes { background: var(--bg-input); border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 8px; resize: vertical; }
```

- [ ] **Step 4: 빌드 확인**

Run: `cd /Users/smlee/projects/product/database && pnpm --filter renderer build`
Expected: 성공.

- [ ] **Step 5: 커밋**

```bash
git add apps/renderer/src/components/DomainBindingsDialog.tsx apps/renderer/src/App.tsx apps/renderer/src/App.css
git commit -m "feat(renderer): 도메인 설정에 용어사전·규칙 탭 통합 (#103)"
```

---

## Task 9: 전체 검증 (빌드/테스트 + CDP 라이브)

**Files:**
- Throwaway: `apps/desktop/e2e/domain-assistant.verify.spec.ts` (커밋하지 않음)

- [ ] **Step 1: 전체 수트**

Run:
```bash
cd /Users/smlee/projects/product/database
/Users/smlee/sdk/go/bin/go test ./engine/... && /Users/smlee/sdk/go/bin/go build ./engine/...
pnpm --filter renderer test 2>&1 | tail -5
pnpm --filter renderer lint 2>&1 | tail -3
pnpm --filter renderer build >/dev/null && echo RENDERER_OK
pnpm --filter desktop build >/dev/null && echo DESKTOP_OK
```
Expected: 엔진 PASS, 렌더러 전체 PASS(신규 테스트 포함), lint clean, RENDERER_OK, DESKTOP_OK.

- [ ] **Step 2: CDP 라이브 검증 (dev-mysql `erg_*` 임시 테이블)**

빌드된 앱을 실행하는 throwaway Playwright 스펙을 작성한다(기존 `apps/desktop/e2e/*.spec.ts` fixture 패턴 사용: 격리 userDataDir, dev-mysql 연결, `erg_*` 테이블만 사용). 흐름:
1. `erg_dom_user(id, hospitalId, deletedAt, name)` 생성 + 행 삽입(활성/삭제 혼합).
2. 연결 → 도메인 설정 다이얼로그 → 용어사전·규칙 탭에서 `erg_dom_user`=환자, `deletedAt`=삭제여부 입력 + 규칙노트 "항상 deletedAt IS NULL" 저장.
3. AgentChat 열고 "삭제 안 된 환자 목록 보여줘" 입력.
4. 단언: 어시스턴트 응답/제안 SQL에 `deletedAt IS NULL`이 포함되고, 해석 조건 불릿이 SQL 앞에 제시됨.
5. 스크린샷 `docs/verify-domain-assistant.png` 저장.

AI 경로는 키체인 OAuth 사용. OAuth 미설정 환경이면 최소한 (a) 도메인 컨텍스트가 `/agent/run` 요청 system에 포함되는지 엔진 stub 레벨에서 확인하고, (b) 사전 편집기 UI 저장 왕복(저장 후 재오픈 시 값 유지)을 단언한다.

- [ ] **Step 3: 결과 확인 + 정리**

`docs/verify-domain-assistant.png` 확인 → throwaway 스펙 삭제 → `erg_*` 임시 테이블 drop. 누수 없음 확인.

- [ ] **Step 4: 커밋(검증 자체는 코드 변경 없음 — 정리만)**

검증으로 코드 수정이 필요했다면 해당 커밋. 아니면 스킵.

---

## Self-Review (작성자 체크)

**스펙 커버리지**
- 테이블/컬럼 의미 등록 → Task 1(데이터)·5(merge/serialize)·7~8(편집기/탭) ✅
- 자연어→SQL(도메인 인지) → Task 3~4(컨텍스트 주입) + 기존 AgentChat ✅
- SQL 생성 전 해석 조건 제시 → Task 3 지시문("해석한 조건을 한국어 불릿로 먼저") ✅
- 기본 도메인 규칙 제안(deletedAt/hospitalId) → Task 3 자동 규칙 + 기존 #102 분석기 백스톱 ✅
- 생성 SQL 자연어 설명 → 채팅 내 기존 동작(별도 작업 없음, 설계 §SQL 설명) ✅
- 검토 후 직접 실행 → 기존 propose_write/실행 게이트(변경 없음) ✅
- AI 채우기(자연어로 사전 작성) → Task 6~7 ✅

**플레이스홀더 스캔:** 없음(모든 코드 단계 실제 코드 포함). Task 9 throwaway 스펙은 기존 e2e fixture 재사용을 명시 — 구체 fixture API는 `apps/desktop/e2e/` 기존 스펙을 참조하라고 지정.

**타입 일관성:** `DomainEntry`(Go: Kind/Table/Column/Meaning, TS: kind/table/column/meaning) 일관. `BuildDomainContext(entries, notes, tenantCols, softDelete)` 시그니처가 Task 3 정의·Task 4 호출 일치. `mergeSchema`/`serializeGlossary`/`parseGlossary`/`buildFillPrompt`/`parseFillResponse` 이름 Task 5~7 일관. `generateNarration(runId, profileId, system, messages, options)` 실제 global.d.ts 시그니처와 일치.
