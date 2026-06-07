# 반복 DB 업무 자동화 템플릿 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 범용·역할 기반 SQL 업무 템플릿을 카테고리별로 제공하고, 사용자는 파라미터만 입력해 안전하게 실행하며(빈칸 자동 생략·식별자 검증), 결과를 CSV·요약·에디터로 이어가고, 자신의 쿼리를 템플릿으로 저장할 수 있게 한다.

**Architecture:** 빌트인 템플릿은 렌더러 정적 정의(코드). 사용자 커스텀 템플릿은 엔진 SQLite `templates` 테이블(saved_queries 패턴 재사용). 연결별 "역할→컬럼" 도메인 바인딩은 프로필 JSON 컬럼. 치환은 렌더러 순수 함수 `renderTemplate`(`:value`/`{{ident}}`/`{{role:NAME}}`/`[[optional]]`)이 담당하고 최종 SQL을 기존 `executeQueryStream` 실행 경로로 보낸다(안전 실행 모드 게이트 그대로).

**Tech Stack:** Go 1.25 (엔진, database/sql, 표준 net/http, 테이블 테스트), TypeScript/React 19 (렌더러, Vitest), Electron IPC, SQLite 메타데이터 마이그레이션.

**Toolchain:** Go는 `/Users/smlee/sdk/go/bin/go`. 렌더러 테스트 `pnpm --filter renderer test`. 통합 DB는 dev-mysql `127.0.0.1:3306` root/`password1!` `devdb` — **사용자 데이터 금지, `erg_*` 임시 테이블만**.

**기존 재사용 자산(확인됨):**
- 렌더러 `quoteIdent(driver, name)` + `type Driver`는 `apps/renderer/src/lib/ddlBuilder.ts`에, `sqlLiteral(driver, value)`는 `apps/renderer/src/lib/dmlBuilder.ts`에 이미 존재.
- saved-query 패턴: `domain/workspace.go`(SavedQuery), `application/workspace_service.go`, `transport/http/workspace_handler.go`, `adapters/sqlite/sqlite_workspace_repository.go`, 라우트 `engine/cmd/app-engine/main.go:285`, IPC preload `apps/desktop/src/preload/index.ts:144`, main `apps/desktop/src/main/index.ts:1200`, 렌더러 `components/SavedQueries.tsx`.
- 실행/표시: `executeQueryStream`, `ResultGrid`, `gridExport.toCsv`, `App.handleSelectQuery`(에디터에 SQL 로드), `agentRun`(AI 요약).
- 안전모드 필드 추가 패턴: 프로필에 `SafeMode`/`TenantColumns` JSON류 컬럼 추가 + migration + 3 스키마 사본(`main.go`, `sqlite_profile_repository_test.go`, `integration_persistence_test.go`).

---

## File Structure

**엔진 (신규):**
- `engine/internal/domain/template.go` — `Template` 구조체 + Validate
- `engine/internal/ports/template_repository.go` — `TemplateRepository` 인터페이스
- `engine/internal/adapters/sqlite/sqlite_template_repository.go` — CRUD
- `engine/internal/adapters/sqlite/sqlite_template_repository_test.go` — round-trip
- `engine/internal/application/template_service.go` — Save/List/Delete
- `engine/internal/transport/http/template_handler.go` — `/templates` 핸들러

**엔진 (수정):**
- `engine/internal/domain/connection.go` — `DomainBindings string` 필드 + `DomainBindingMap()` 헬퍼
- `engine/internal/adapters/sqlite/sqlite_profile_repository.go` — domain_bindings read/write
- `engine/cmd/app-engine/main.go` — migration v7(domain_bindings)+v8(templates) + 라우트 + 서비스/핸들러 생성
- `engine/internal/adapters/sqlite/sqlite_profile_repository_test.go` · `engine/internal/application/integration_persistence_test.go` — 스키마 사본 동기화

**렌더러 (신규):**
- `apps/renderer/src/lib/templateTypes.ts` — 공유 타입
- `apps/renderer/src/lib/templateRender.ts` + `.test.ts` — 치환 엔진(순수)
- `apps/renderer/src/lib/suggestBindings.ts` + `.test.ts` — 역할 자동추천(순수)
- `apps/renderer/src/lib/templateSummary.ts` + `.test.ts` — 요약 생성(순수)
- `apps/renderer/src/lib/builtinTemplates.ts` + `.test.ts` — 빌트인 정의 + 무결성
- `apps/renderer/src/components/TemplatesPanel.tsx` — 사이드바 목록
- `apps/renderer/src/components/TemplateRunner.tsx` — 파라미터 폼 + 실행 + 결과 + 후속
- `apps/renderer/src/components/DomainBindingsDialog.tsx` — 역할→컬럼 매핑
- `apps/renderer/src/components/SaveTemplateDialog.tsx` — 커스텀 템플릿 저장

**렌더러 (수정):**
- `apps/desktop/src/preload/index.ts` · `apps/desktop/src/main/index.ts` · `apps/renderer/src/global.d.ts` — template IPC + `domainBindings` 타입
- `apps/renderer/src/App.tsx` — Templates 탭 + `templateView` 상태 + 메인 페인 분기 + 도메인설정 전달
- `apps/renderer/src/App.css` — 스타일

---

## Task 1: 엔진 — 프로필 domainBindings (migration v7)

**Files:**
- Modify: `engine/internal/domain/connection.go`
- Modify: `engine/internal/adapters/sqlite/sqlite_profile_repository.go`
- Modify: `engine/cmd/app-engine/main.go` (migrations 끝)
- Test: `engine/internal/adapters/sqlite/sqlite_profile_repository_test.go` (+스키마 사본)
- Modify: `engine/internal/application/integration_persistence_test.go` (스키마 사본)

- [ ] **Step 1: 실패 테스트** — `sqlite_profile_repository_test.go`에 추가:

```go
func TestProfileRepository_DomainBindingsRoundTrips(t *testing.T) {
	repo := newProfileRepo(t)
	ctx := context.Background()
	p := &domain.ConnectionProfile{
		ID: "db1", Name: "x", Driver: "mysql", Host: "h", Port: 3306, Database: "d",
		Username: "u", SecretRef: "s", TLSMode: "none",
		DomainBindings: `{"tenant":"hospitalId","soft_delete":"deletedAt"}`,
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := repo.Create(ctx, p); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.GetByID(ctx, "db1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.DomainBindings != p.DomainBindings {
		t.Fatalf("domain_bindings round-trip: got %q", got.DomainBindings)
	}
}

func TestDomainBindingMap(t *testing.T) {
	p := domain.ConnectionProfile{DomainBindings: `{"tenant":"hospitalId"}`}
	m := p.DomainBindingMap()
	if m["tenant"] != "hospitalId" {
		t.Fatalf("got %v", m)
	}
	if len(domain.ConnectionProfile{}.DomainBindingMap()) != 0 {
		t.Fatal("empty bindings should give empty map")
	}
}
```

Also add the column to the CREATE TABLE in `newProfileRepo` (after `tenant_columns TEXT NOT NULL DEFAULT '',`):
```
						domain_bindings TEXT NOT NULL DEFAULT '',
```

- [ ] **Step 2: 실패 확인** — Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/ -run 'TestProfileRepository_DomainBindingsRoundTrips|TestDomainBindingMap' -v` → FAIL.

- [ ] **Step 3: 도메인 필드 + 헬퍼** — `connection.go` struct에 `TenantColumns` 아래 추가:

```go
	// DomainBindings is a JSON object mapping semantic roles to actual column
	// names for this connection (e.g. {"tenant":"hospitalId"}). Used by task
	// templates to resolve {{role:NAME}} placeholders. Empty = no bindings.
	DomainBindings string `json:"domainBindings"`
```

파일 끝에 메서드 추가(+import `"encoding/json"`):
```go
// DomainBindingMap parses DomainBindings JSON into a role→column map. Invalid or
// empty JSON yields an empty map (never nil-panics).
func (p ConnectionProfile) DomainBindingMap() map[string]string {
	out := map[string]string{}
	if strings.TrimSpace(p.DomainBindings) == "" {
		return out
	}
	_ = json.Unmarshal([]byte(p.DomainBindings), &out)
	return out
}
```

- [ ] **Step 4: repo read/write** — `sqlite_profile_repository.go` 4개 SQL에 `domain_bindings`를 `tenant_columns` 다음·`created_at` 앞에 삽입(컬럼 리스트 + `?` + 인자 `p.DomainBindings`; GetByID/List Scan에 `&p.DomainBindings`; Update SET + 인자). (안전모드 때 `safe_mode, tenant_columns` 추가한 위치 바로 뒤.)

- [ ] **Step 5: 통과 확인** — Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/ -run 'TestProfileRepository' -v` → PASS(기존 SafeMode/ReadOnly 포함).

- [ ] **Step 6: 실 마이그레이션 + 통합 스키마 사본** — `main.go` migrations 배열 끝(Version 6 다음)에 추가:
```go
		{
			Version: 7,
			Name:    "add_profile_domain_bindings",
			SQL: `
				ALTER TABLE connection_profiles ADD COLUMN domain_bindings TEXT NOT NULL DEFAULT '';
			`,
			Checksum: "profile-domain-bindings-v1",
		},
```
`integration_persistence_test.go`의 CREATE TABLE에 `tenant_columns ...` 다음 `domain_bindings TEXT NOT NULL DEFAULT '',` 추가.

- [ ] **Step 7: 전체 확인 + 커밋** — Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/ ./engine/internal/application/ ./engine/internal/domain/ && /Users/smlee/sdk/go/bin/go build ./engine/...` → PASS.
```bash
cd /Users/smlee/projects/product/database
git add engine/internal/domain/connection.go engine/internal/adapters/sqlite/ engine/cmd/app-engine/main.go engine/internal/application/integration_persistence_test.go
git commit -m "feat(engine): 프로필 domainBindings + migration v7 (#105)"
```

---

## Task 2: 엔진 — Template 도메인 + migration v8 + SQLite repo

**Files:**
- Create: `engine/internal/domain/template.go`
- Create: `engine/internal/ports/template_repository.go`
- Create: `engine/internal/adapters/sqlite/sqlite_template_repository.go`
- Create: `engine/internal/adapters/sqlite/sqlite_template_repository_test.go`
- Modify: `engine/cmd/app-engine/main.go` (migration v8)

- [ ] **Step 1: 실패 테스트** — `sqlite_template_repository_test.go`:

```go
package sqlite

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	_ "modernc.org/sqlite"
)

func newTemplateRepo(t *testing.T) *SQLiteTemplateRepository {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(`
		CREATE TABLE templates (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			category TEXT NOT NULL DEFAULT '',
			sql_text TEXT NOT NULL,
			parameters TEXT NOT NULL DEFAULT '[]',
			driver TEXT NOT NULL DEFAULT '',
			created_at DATETIME NOT NULL,
			updated_at DATETIME NOT NULL
		);
	`); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return NewSQLiteTemplateRepository(db)
}

func TestTemplateRepository_RoundTrip(t *testing.T) {
	repo := newTemplateRepo(t)
	ctx := context.Background()
	tpl := &domain.Template{
		ID: "t1", WorkspaceID: "default", Name: "Dup by column",
		Description: "find dups", Category: "CS", SQLText: "SELECT 1",
		Parameters: `[{"name":"table","kind":"identifier"}]`, Driver: "mysql",
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := repo.Create(ctx, tpl); err != nil {
		t.Fatalf("create: %v", err)
	}
	list, err := repo.List(ctx, "default")
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v len=%d", err, len(list))
	}
	if list[0].Name != "Dup by column" || list[0].Parameters != tpl.Parameters {
		t.Fatalf("round-trip mismatch: %+v", list[0])
	}
	if err := repo.Delete(ctx, "t1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if l, _ := repo.List(ctx, "default"); len(l) != 0 {
		t.Fatalf("expected empty after delete")
	}
}
```

- [ ] **Step 2: 실패 확인** — Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/ -run TestTemplateRepository_RoundTrip -v` → FAIL (types missing).

- [ ] **Step 3: 도메인** — `engine/internal/domain/template.go`:
```go
package domain

import (
	"errors"
	"time"
)

// Template is a user-saved parameterized SQL task template.
type Template struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspaceId"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Category    string    `json:"category"`
	SQLText     string    `json:"sqlText"`
	Parameters  string    `json:"parameters"` // JSON array of param defs
	Driver      string    `json:"driver"`     // "" = any
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

func (t Template) Validate() error {
	if t.ID == "" {
		return errors.New("template ID is required")
	}
	if t.WorkspaceID == "" {
		return errors.New("workspace ID is required")
	}
	if t.Name == "" {
		return errors.New("template name is required")
	}
	if t.SQLText == "" {
		return errors.New("template SQL is required")
	}
	return nil
}
```

- [ ] **Step 4: 포트 + repo** — `engine/internal/ports/template_repository.go`:
```go
package ports

import (
	"context"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type TemplateRepository interface {
	Create(ctx context.Context, t *domain.Template) error
	List(ctx context.Context, workspaceID string) ([]*domain.Template, error)
	GetByID(ctx context.Context, id string) (*domain.Template, error)
	Update(ctx context.Context, t *domain.Template) error
	Delete(ctx context.Context, id string) error
}
```

`engine/internal/adapters/sqlite/sqlite_template_repository.go`:
```go
package sqlite

import (
	"context"
	"database/sql"
	"errors"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type SQLiteTemplateRepository struct {
	db *sql.DB
}

func NewSQLiteTemplateRepository(db *sql.DB) *SQLiteTemplateRepository {
	return &SQLiteTemplateRepository{db: db}
}

func (r *SQLiteTemplateRepository) Create(ctx context.Context, t *domain.Template) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO templates (id, workspace_id, name, description, category, sql_text, parameters, driver, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
			category=excluded.category, sql_text=excluded.sql_text, parameters=excluded.parameters,
			driver=excluded.driver, updated_at=excluded.updated_at
	`, t.ID, t.WorkspaceID, t.Name, t.Description, t.Category, t.SQLText, t.Parameters, t.Driver, t.CreatedAt, t.UpdatedAt)
	return err
}

func (r *SQLiteTemplateRepository) scan(rows interface{ Scan(...any) error }) (*domain.Template, error) {
	var t domain.Template
	err := rows.Scan(&t.ID, &t.WorkspaceID, &t.Name, &t.Description, &t.Category, &t.SQLText, &t.Parameters, &t.Driver, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (r *SQLiteTemplateRepository) List(ctx context.Context, workspaceID string) ([]*domain.Template, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, workspace_id, name, description, category, sql_text, parameters, driver, created_at, updated_at
		FROM templates WHERE workspace_id = ? ORDER BY category, name
	`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*domain.Template
	for rows.Next() {
		t, err := r.scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, nil
}

func (r *SQLiteTemplateRepository) GetByID(ctx context.Context, id string) (*domain.Template, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, workspace_id, name, description, category, sql_text, parameters, driver, created_at, updated_at
		FROM templates WHERE id = ?
	`, id)
	t, err := r.scan(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("template not found")
	}
	return t, err
}

func (r *SQLiteTemplateRepository) Update(ctx context.Context, t *domain.Template) error {
	return r.Create(ctx, t) // upsert
}

func (r *SQLiteTemplateRepository) Delete(ctx context.Context, id string) error {
	res, err := r.db.ExecContext(ctx, "DELETE FROM templates WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return errors.New("template not found")
	}
	return nil
}
```

- [ ] **Step 5: 통과 확인** — Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/ -run TestTemplateRepository_RoundTrip -v` → PASS.

- [ ] **Step 6: 실 마이그레이션 v8** — `main.go` migrations 끝(Version 7 다음)에 추가:
```go
		{
			Version: 8,
			Name:    "create_templates",
			SQL: `
				CREATE TABLE IF NOT EXISTS templates (
					id TEXT PRIMARY KEY,
					workspace_id TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					category TEXT NOT NULL DEFAULT '',
					sql_text TEXT NOT NULL,
					parameters TEXT NOT NULL DEFAULT '[]',
					driver TEXT NOT NULL DEFAULT '',
					created_at DATETIME NOT NULL,
					updated_at DATETIME NOT NULL,
					FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
				);
			`,
			Checksum: "templates-v1",
		},
```

- [ ] **Step 7: 빌드 + 커밋** — Run: `/Users/smlee/sdk/go/bin/go build ./engine/... && /Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/ ./engine/internal/domain/`.
```bash
git add engine/internal/domain/template.go engine/internal/ports/template_repository.go engine/internal/adapters/sqlite/sqlite_template_repository.go engine/internal/adapters/sqlite/sqlite_template_repository_test.go engine/cmd/app-engine/main.go
git commit -m "feat(engine): Template 도메인 + repo + migration v8 (#105)"
```

---

## Task 3: 엔진 — Template 서비스 + 핸들러 + 라우트

**Files:**
- Create: `engine/internal/application/template_service.go`
- Create: `engine/internal/transport/http/template_handler.go`
- Modify: `engine/cmd/app-engine/main.go` (서비스/핸들러 생성 + 라우트)
- Test: `engine/internal/application/template_service_test.go`

- [ ] **Step 1: 실패 테스트(서비스, 인메모리 repo)** — `template_service_test.go`:
```go
package application

import (
	"context"
	"database/sql"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlite"
	_ "modernc.org/sqlite"
)

func TestTemplateService_SaveAssignsIDAndLists(t *testing.T) {
	db, _ := sql.Open("sqlite", ":memory:")
	defer db.Close()
	db.Exec(`CREATE TABLE templates (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
		description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', sql_text TEXT NOT NULL,
		parameters TEXT NOT NULL DEFAULT '[]', driver TEXT NOT NULL DEFAULT '',
		created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL);`)
	svc := NewTemplateService(sqlite.NewSQLiteTemplateRepository(db))
	ctx := context.Background()
	tpl, err := svc.SaveTemplate(ctx, "", "default", "Dup", "desc", "CS", "SELECT 1", "[]", "mysql")
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if tpl.ID == "" {
		t.Fatal("expected generated ID")
	}
	list, err := svc.ListTemplates(ctx, "default")
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v len=%d", err, len(list))
	}
}
```

- [ ] **Step 2: 실패 확인** — Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/application/ -run TestTemplateService -v` → FAIL.

- [ ] **Step 3: 서비스** — `template_service.go`:
```go
package application

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type TemplateService struct {
	repo ports.TemplateRepository
}

func NewTemplateService(repo ports.TemplateRepository) *TemplateService {
	return &TemplateService{repo: repo}
}

func (s *TemplateService) SaveTemplate(ctx context.Context, id, workspaceID, name, description, category, sqlText, parameters, driver string) (*domain.Template, error) {
	if id == "" {
		id = uuid.NewString()
	}
	if parameters == "" {
		parameters = "[]"
	}
	t := &domain.Template{
		ID: id, WorkspaceID: workspaceID, Name: name, Description: description,
		Category: category, SQLText: sqlText, Parameters: parameters, Driver: driver,
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := t.Validate(); err != nil {
		return nil, err
	}
	if err := s.repo.Create(ctx, t); err != nil {
		return nil, err
	}
	return t, nil
}

func (s *TemplateService) ListTemplates(ctx context.Context, workspaceID string) ([]*domain.Template, error) {
	return s.repo.List(ctx, workspaceID)
}

func (s *TemplateService) DeleteTemplate(ctx context.Context, id string) error {
	return s.repo.Delete(ctx, id)
}
```

- [ ] **Step 4: 통과 확인** — Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/application/ -run TestTemplateService -v` → PASS.

- [ ] **Step 5: 핸들러** — `template_handler.go` (workspace_handler.go의 SaveQuery/ListQueries/DeleteQuery 구조를 그대로 미러):
```go
package http

import (
	"encoding/json"
	"net/http"

	"github.com/smlee/database-local-engine/engine/internal/application"
)

type TemplateHandler struct {
	token   string
	service *application.TemplateService
}

func NewTemplateHandler(token string, service *application.TemplateService) *TemplateHandler {
	return &TemplateHandler{token: token, service: service}
}

func (h *TemplateHandler) checkToken(r *http.Request) bool {
	return validToken(r.Header.Get("X-App-Engine-Token"), h.token)
}

func (h *TemplateHandler) Save() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var req struct {
			ID, WorkspaceID, Name, Description, Category, SQLText, Parameters, Driver string
		}
		// JSON keys are camelCase; decode explicitly.
		var body struct {
			ID          string `json:"id"`
			WorkspaceID string `json:"workspaceId"`
			Name        string `json:"name"`
			Description string `json:"description"`
			Category    string `json:"category"`
			SQLText     string `json:"sqlText"`
			Parameters  string `json:"parameters"`
			Driver      string `json:"driver"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		req = struct {
			ID, WorkspaceID, Name, Description, Category, SQLText, Parameters, Driver string
		}(body)
		t, err := h.service.SaveTemplate(r.Context(), req.ID, req.WorkspaceID, req.Name, req.Description, req.Category, req.SQLText, req.Parameters, req.Driver)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(t)
	})
}

func (h *TemplateHandler) List() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		workspaceID := r.URL.Query().Get("workspaceId")
		if workspaceID == "" {
			http.Error(w, "workspaceId is required", http.StatusBadRequest)
			return
		}
		list, err := h.service.ListTemplates(r.Context(), workspaceID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(list)
	})
}

func (h *TemplateHandler) Delete() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		id := r.URL.Query().Get("id")
		if id == "" {
			http.Error(w, "id is required", http.StatusBadRequest)
			return
		}
		if err := h.service.DeleteTemplate(r.Context(), id); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"success":true}`))
	})
}
```
> 주: 위 `req`/`body` 이중 구조가 번거로우면 `body`만 쓰고 service 호출에 `body.ID` 등 직접 전달해도 됨. 핵심은 camelCase JSON 디코드.

- [ ] **Step 6: 라우트 등록** — `main.go`에서 saved-queries 라우트 블록(`mux.Handle("/saved-queries", ...)`) 근처에 추가:
```go
	templateRepo := sqlite.NewSQLiteTemplateRepository(db)
	templateService := application.NewTemplateService(templateRepo)
	templateHandler := internalHttp.NewTemplateHandler(*token, templateService)
	mux.Handle("/templates", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			templateHandler.Save().ServeHTTP(w, r)
		case http.MethodGet:
			templateHandler.List().ServeHTTP(w, r)
		case http.MethodDelete:
			templateHandler.Delete().ServeHTTP(w, r)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}))
```
(`db`는 이미 main.go에서 열려 있음 — profileRepo 생성에 쓰인 동일 핸들.)

- [ ] **Step 7: 빌드 + 커밋** — Run: `/Users/smlee/sdk/go/bin/go build ./engine/... && /Users/smlee/sdk/go/bin/go test ./engine/...`.
```bash
git add engine/internal/application/template_service.go engine/internal/application/template_service_test.go engine/internal/transport/http/template_handler.go engine/cmd/app-engine/main.go
git commit -m "feat(engine): template 서비스·핸들러·/templates 라우트 (#105)"
```

---

## Task 4: 렌더러 — 공유 타입 + 템플릿 렌더 엔진 (핵심, TDD)

**Files:**
- Create: `apps/renderer/src/lib/templateTypes.ts`
- Create: `apps/renderer/src/lib/templateRender.ts`
- Test: `apps/renderer/src/lib/templateRender.test.ts`

- [ ] **Step 1: 공유 타입** — `templateTypes.ts`:
```ts
import type { Driver } from './ddlBuilder';

export type ParamKind = 'value' | 'identifier' | 'enum';

export interface TemplateParam {
  name: string;
  label: string;
  kind: ParamKind;
  valueType?: 'string' | 'number' | 'date' | 'boolean';
  identifierKind?: 'table' | 'column';
  role?: string;
  required?: boolean;
  default?: string;
  options?: { label: string; value?: string; sqlFragment?: string }[];
}

export interface TemplateDef {
  id: string;
  name: string;
  description: string;
  category: string;
  sql: string;
  params: TemplateParam[];
  roles: string[];
  driver?: string;
  source: 'builtin' | 'user';
}

export interface RenderContext {
  driver: Driver;
  inputs: Record<string, string>;     // user form values keyed by param name
  roles: Record<string, string>;      // role -> column name (domainBindings)
  validIdentifiers: Set<string>;      // lowercased real table+column names
}

export interface RenderResult {
  sql: string;
  missing: string[];                  // required params/roles not satisfied
}
```

- [ ] **Step 2: 실패 테스트** — `templateRender.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { renderTemplate } from './templateRender';
import type { TemplateDef, RenderContext } from './templateTypes';

const dupDef: TemplateDef = {
  id: 'dup', name: 'dup', description: '', category: 'CS', source: 'builtin',
  roles: ['tenant', 'soft_delete'],
  sql: `SELECT {{dupCol}}, COUNT(*) c FROM {{table}}
WHERE {{dupCol}} IS NOT NULL
[[ AND {{role:tenant}} = :tenantValue ]]
[[ AND {{role:soft_delete}} IS NULL ]]
GROUP BY {{dupCol}} HAVING COUNT(*) > 1`,
  params: [
    { name: 'table', label: 'Table', kind: 'identifier', identifierKind: 'table', required: true },
    { name: 'dupCol', label: 'Column', kind: 'identifier', identifierKind: 'column', required: true },
    { name: 'tenantValue', label: 'Tenant value', kind: 'value', valueType: 'number' },
  ],
};

function ctx(over: Partial<RenderContext>): RenderContext {
  return {
    driver: 'mysql',
    inputs: {},
    roles: {},
    validIdentifiers: new Set(['user', 'phone', 'hospitalid', 'deletedat']),
    ...over,
  };
}

describe('renderTemplate', () => {
  it('substitutes identifiers + value, keeps optional blocks when resolved', () => {
    const r = renderTemplate(dupDef, ctx({
      inputs: { table: 'User', dupCol: 'phone', tenantValue: '153' },
      roles: { tenant: 'hospitalId', soft_delete: 'deletedAt' },
    }));
    expect(r.missing).toEqual([]);
    expect(r.sql).toContain('SELECT `phone`, COUNT(*) c FROM `User`');
    expect(r.sql).toContain('AND `hospitalId` = 153');
    expect(r.sql).toContain('AND `deletedAt` IS NULL');
  });

  it('drops optional block when role unbound', () => {
    const r = renderTemplate(dupDef, ctx({
      inputs: { table: 'User', dupCol: 'phone' },
      roles: {}, // no tenant/soft_delete
    }));
    expect(r.sql).not.toContain('hospital');
    expect(r.sql).not.toContain('IS NULL');
    expect(r.sql).toContain('FROM `User`');
  });

  it('drops tenant block when value empty even if role bound', () => {
    const r = renderTemplate(dupDef, ctx({
      inputs: { table: 'User', dupCol: 'phone' }, // no tenantValue
      roles: { tenant: 'hospitalId' },
    }));
    expect(r.sql).not.toContain('hospitalId =');
  });

  it('reports missing required identifier', () => {
    const r = renderTemplate(dupDef, ctx({ inputs: { dupCol: 'phone' } }));
    expect(r.missing).toContain('table');
  });

  it('rejects an identifier not in the schema', () => {
    const r = renderTemplate(dupDef, ctx({ inputs: { table: 'Secret', dupCol: 'phone' } }));
    expect(r.missing).toContain('table'); // unknown identifier treated as unsatisfied
  });

  it('escapes string values', () => {
    const def: TemplateDef = { ...dupDef, roles: [], sql: `WHERE name = :name`,
      params: [{ name: 'name', label: 'n', kind: 'value', valueType: 'string', required: true }] };
    const r = renderTemplate(def, ctx({ inputs: { name: "a'b" } }));
    expect(r.sql).toContain("name = 'a''b'");
  });
});
```

- [ ] **Step 3: 실패 확인** — Run: `pnpm --filter renderer test templateRender` → FAIL.

- [ ] **Step 4: 구현** — `templateRender.ts`:
```ts
import { sqlLiteral } from './dmlBuilder';
import { quoteIdent } from './ddlBuilder';
import type { TemplateDef, TemplateParam, RenderContext, RenderResult } from './templateTypes';

// A resolved placeholder: either a substitution string, or null when unresolved.
type Resolution = { sql: string } | { missing: string };

function coerceValue(valueType: string | undefined, raw: string): string | number | boolean {
  switch (valueType) {
    case 'number': return Number(raw);
    case 'boolean': return raw === 'true' || raw === '1';
    default: return raw; // string, date → quoted string literal
  }
}

function resolveParam(p: TemplateParam, ctx: RenderContext): Resolution {
  const raw = (ctx.inputs[p.name] ?? p.default ?? '').trim();
  if (p.kind === 'value') {
    if (raw === '') return { missing: p.name };
    return { sql: sqlLiteral(ctx.driver, coerceValue(p.valueType, raw)) };
  }
  if (p.kind === 'identifier') {
    if (raw === '' || !ctx.validIdentifiers.has(raw.toLowerCase())) return { missing: p.name };
    return { sql: quoteIdent(ctx.driver, raw) };
  }
  // enum
  if (raw === '') return { missing: p.name };
  const opt = (p.options ?? []).find((o) => (o.value ?? o.label) === raw);
  if (!opt) return { missing: p.name };
  if (opt.sqlFragment != null) return { sql: opt.sqlFragment };
  return { sql: sqlLiteral(ctx.driver, opt.value ?? '') };
}

function resolveRole(role: string, ctx: RenderContext): Resolution {
  const col = ctx.roles[role];
  if (!col) return { missing: `role:${role}` };
  return { sql: quoteIdent(ctx.driver, col) };
}

// Build resolution maps once.
function buildResolutions(def: TemplateDef, ctx: RenderContext) {
  const params = new Map<string, Resolution>();
  for (const p of def.params) params.set(p.name, resolveParam(p, ctx));
  const roles = new Map<string, Resolution>();
  for (const role of def.roles) roles.set(role, resolveRole(role, ctx));
  return { params, roles };
}

const RE_ROLE = /\{\{role:(\w+)\}\}/g;
const RE_IDENT = /\{\{(\w+)\}\}/g;
const RE_VALUE = /:(\w+)/g;

// Returns true if every placeholder in `fragment` resolves, else false.
function fragmentResolves(fragment: string, res: ReturnType<typeof buildResolutions>): boolean {
  const names = new Set<string>();
  for (const m of fragment.matchAll(RE_ROLE)) names.add('role:' + m[1]);
  // strip role tokens before scanning idents so {{role:x}} isn't double-counted
  const noRoles = fragment.replace(RE_ROLE, '');
  for (const m of noRoles.matchAll(RE_IDENT)) names.add('ident:' + m[1]);
  for (const m of fragment.matchAll(RE_VALUE)) names.add('value:' + m[1]);
  for (const key of names) {
    const [kind, name] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (kind === 'role') {
      const r = res.roles.get(name);
      if (!r || 'missing' in r) return false;
    } else {
      const r = res.params.get(name);
      if (!r || 'missing' in r) return false;
    }
  }
  return true;
}

// Replace all placeholders in `fragment` with their resolved SQL (assumes resolvable).
function substitute(fragment: string, res: ReturnType<typeof buildResolutions>): string {
  let out = fragment.replace(RE_ROLE, (_, role) => {
    const r = res.roles.get(role)!;
    return 'sql' in r ? r.sql : '';
  });
  out = out.replace(RE_IDENT, (_, name) => {
    const r = res.params.get(name);
    return r && 'sql' in r ? r.sql : '';
  });
  out = out.replace(RE_VALUE, (_, name) => {
    const r = res.params.get(name);
    return r && 'sql' in r ? r.sql : '';
  });
  return out;
}

const RE_BLOCK = /\[\[([\s\S]*?)\]\]/g;

export function renderTemplate(def: TemplateDef, ctx: RenderContext): RenderResult {
  const res = buildResolutions(def, ctx);

  // 1. Resolve optional [[...]] blocks: keep & substitute if fully resolvable, else drop.
  let sql = def.sql.replace(RE_BLOCK, (_, inner) =>
    fragmentResolves(inner, res) ? substitute(inner, res) : '',
  );

  // 2. Substitute placeholders outside blocks.
  sql = substitute(sql, res);

  // 3. Tidy whitespace from dropped blocks.
  sql = sql.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // 4. Missing = required params + declared roles that are unresolved AND still
  //    referenced in the *outside-block* SQL (i.e. not optional).
  const outsideOnly = def.sql.replace(RE_BLOCK, '');
  const missing: string[] = [];
  for (const p of def.params) {
    if (!p.required) continue;
    const referencedOutside =
      outsideOnly.includes(`{{${p.name}}}`) || new RegExp(`:${p.name}\\b`).test(outsideOnly);
    const r = res.params.get(p.name);
    if (referencedOutside && r && 'missing' in r) missing.push(p.name);
  }
  for (const role of def.roles) {
    const referencedOutside = outsideOnly.includes(`{{role:${role}}}`);
    const r = res.roles.get(role);
    if (referencedOutside && r && 'missing' in r) missing.push(`role:${role}`);
  }
  return { sql, missing };
}
```

- [ ] **Step 5: 통과 확인** — Run: `pnpm --filter renderer test templateRender` → PASS (모든 케이스).

- [ ] **Step 6: 커밋**
```bash
git add apps/renderer/src/lib/templateTypes.ts apps/renderer/src/lib/templateRender.ts apps/renderer/src/lib/templateRender.test.ts
git commit -m "feat(renderer): 템플릿 렌더 엔진 (값/식별자/역할/선택블록) (#105)"
```

---

## Task 5: 렌더러 — 역할 자동 추천 (TDD)

**Files:**
- Create: `apps/renderer/src/lib/suggestBindings.ts`
- Test: `apps/renderer/src/lib/suggestBindings.test.ts`

- [ ] **Step 1: 실패 테스트** — `suggestBindings.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { suggestBindings } from './suggestBindings';

describe('suggestBindings', () => {
  it('binds tenant from tenantColumns when present in schema', () => {
    const b = suggestBindings(['id', 'hospitalId', 'deletedAt', 'phone'], ['hospitalId', 'tenantId']);
    expect(b.tenant).toBe('hospitalId');
    expect(b.soft_delete).toBe('deletedAt');
  });
  it('falls back to name matching for tenant when tenantColumns absent', () => {
    const b = suggestBindings(['id', 'org_id', 'is_deleted'], []);
    expect(b.tenant).toBe('org_id');
    expect(b.soft_delete).toBe('is_deleted');
  });
  it('omits a role when no candidate matches', () => {
    const b = suggestBindings(['id', 'name'], []);
    expect(b.tenant).toBeUndefined();
    expect(b.soft_delete).toBeUndefined();
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm --filter renderer test suggestBindings` → FAIL.

- [ ] **Step 3: 구현** — `suggestBindings.ts`:
```ts
// Suggest role→column bindings for a connection from its column names + the
// safe-mode tenant columns. Pure, best-effort: returns only confident matches.
const PATTERNS: Record<string, RegExp> = {
  tenant: /^(tenant|hospital|org|company|account)_?id$|^(tenant|hospital|org)$/i,
  soft_delete: /^(deleted_?at|is_?deleted|removed_?at)$/i,
};

export function suggestBindings(columns: string[], tenantColumns: string[]): Record<string, string> {
  const lower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  const out: Record<string, string> = {};

  // tenant: prefer a configured tenant column that exists, else pattern match.
  for (const tc of tenantColumns) {
    if (lower.has(tc.toLowerCase())) {
      out.tenant = lower.get(tc.toLowerCase())!;
      break;
    }
  }
  for (const [role, re] of Object.entries(PATTERNS)) {
    if (out[role]) continue;
    const hit = columns.find((c) => re.test(c));
    if (hit) out[role] = hit;
  }
  return out;
}
```

- [ ] **Step 4: 통과 확인** — Run: `pnpm --filter renderer test suggestBindings` → PASS.

- [ ] **Step 5: 커밋**
```bash
git add apps/renderer/src/lib/suggestBindings.ts apps/renderer/src/lib/suggestBindings.test.ts
git commit -m "feat(renderer): 역할 바인딩 자동 추천 (#105)"
```

---

## Task 6: 렌더러 — 결과 요약 생성 (TDD)

**Files:**
- Create: `apps/renderer/src/lib/templateSummary.ts`
- Test: `apps/renderer/src/lib/templateSummary.test.ts`

- [ ] **Step 1: 실패 테스트** — `templateSummary.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildSummary, formatSummary } from './templateSummary';

const cols = ['phone', 'duplicateCount'];
const rows = [['010-1', 3], ['010-2', 2]];

describe('templateSummary', () => {
  it('builds a deterministic summary with row count and top rows', () => {
    const s = buildSummary('phone 중복 조회', cols, rows);
    expect(s.title).toBe('phone 중복 조회');
    expect(s.rowCount).toBe(2);
    expect(s.lines.length).toBeGreaterThan(0);
  });

  it('formats plain / slack / jira', () => {
    const s = buildSummary('T', cols, rows);
    expect(formatSummary(s, 'plain')).toContain('2');
    expect(formatSummary(s, 'slack')).toContain('*');   // mrkdwn bold
    expect(formatSummary(s, 'jira')).toContain('#');     // jira heading/list marker
  });

  it('handles empty result', () => {
    const s = buildSummary('T', cols, []);
    expect(s.rowCount).toBe(0);
    expect(formatSummary(s, 'plain')).toMatch(/0|없/);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm --filter renderer test templateSummary` → FAIL.

- [ ] **Step 3: 구현** — `templateSummary.ts`:
```ts
export interface Summary {
  title: string;
  rowCount: number;
  columns: string[];
  lines: string[]; // up to 5 sample lines, "col=val, col=val"
}

export type SummaryFormat = 'plain' | 'slack' | 'jira';

export function buildSummary(title: string, columns: string[], rows: unknown[][]): Summary {
  const lines = rows.slice(0, 5).map((r) =>
    columns.map((c, i) => `${c}=${r[i] == null ? 'NULL' : String(r[i])}`).join(', '),
  );
  return { title, rowCount: rows.length, columns, lines };
}

export function formatSummary(s: Summary, fmt: SummaryFormat): string {
  const head =
    s.rowCount === 0 ? `결과 없음 (0행)` : `총 ${s.rowCount.toLocaleString()}행`;
  if (fmt === 'slack') {
    const body = s.lines.map((l) => `• ${l}`).join('\n');
    return `*${s.title}*\n${head}${body ? '\n' + body : ''}`;
  }
  if (fmt === 'jira') {
    // Jira wiki markup: h3. heading + '# ' numbered list (contains '#').
    const body = s.lines.map((l) => `# ${l}`).join('\n');
    return `h3. ${s.title}\n${head}${body ? '\n' + body : ''}`;
  }
  const body = s.lines.map((l) => `- ${l}`).join('\n');
  return `${s.title}\n${head}${body ? '\n' + body : ''}`;
}
```

- [ ] **Step 4: 통과 확인** — Run: `pnpm --filter renderer test templateSummary` → PASS.

- [ ] **Step 5: 커밋**
```bash
git add apps/renderer/src/lib/templateSummary.ts apps/renderer/src/lib/templateSummary.test.ts
git commit -m "feat(renderer): 결과 요약 생성 (일반/Slack/Jira) (#105)"
```

---

## Task 7: 렌더러 — 빌트인 템플릿 정의 + 무결성 테스트 (TDD)

**Files:**
- Create: `apps/renderer/src/lib/builtinTemplates.ts`
- Test: `apps/renderer/src/lib/builtinTemplates.test.ts`

- [ ] **Step 1: 실패 테스트** — `builtinTemplates.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BUILTIN_TEMPLATES } from './builtinTemplates';
import { renderTemplate } from './templateRender';

describe('builtinTemplates', () => {
  it('every template has unique id, a category, description, and params', () => {
    const ids = new Set<string>();
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      expect(t.category).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(5);
      expect(t.source).toBe('builtin');
    }
  });

  it('every {{ident}}/:value placeholder in sql has a matching param; every {{role:X}} is declared', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const names = new Set(t.params.map((p) => p.name));
      const noRoles = t.sql.replace(/\{\{role:(\w+)\}\}/g, '');
      for (const m of noRoles.matchAll(/\{\{(\w+)\}\}/g)) expect(names.has(m[1])).toBe(true);
      for (const m of noRoles.matchAll(/:(\w+)/g)) expect(names.has(m[1])).toBe(true);
      for (const m of t.sql.matchAll(/\{\{role:(\w+)\}\}/g)) expect(t.roles).toContain(m[1]);
    }
  });

  it('the dup-by-column template renders against a bound schema', () => {
    const dup = BUILTIN_TEMPLATES.find((t) => t.id === 'dup-by-column')!;
    const r = renderTemplate(dup, {
      driver: 'mysql',
      inputs: { table: 'User', dupColumn: 'phone', tenantValue: '153' },
      roles: { tenant: 'hospitalId', soft_delete: 'deletedAt' },
      validIdentifiers: new Set(['user', 'phone']),
    });
    expect(r.missing).toEqual([]);
    expect(r.sql).toContain('FROM `User`');
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm --filter renderer test builtinTemplates` → FAIL.

- [ ] **Step 3: 구현** — `builtinTemplates.ts` (8개 정의; 아래 예시 형식대로, 모든 SQL은 SELECT, tenant/soft_delete는 `[[…]]`로 감쌈). 핵심 2개를 완전 기술하고 나머지 6개는 동일 패턴으로 작성:
```ts
import type { TemplateDef } from './templateTypes';

export const BUILTIN_TEMPLATES: TemplateDef[] = [
  {
    id: 'dup-by-column', source: 'builtin', category: 'CS 조사',
    name: '컬럼 기준 중복 행 찾기',
    description: '한 테이블에서 특정 컬럼 값이 중복되는 행을 찾습니다. phone/chartNumber 중복 환자, 엑셀 업로드 오류 조사에 사용합니다.',
    roles: ['tenant', 'soft_delete'],
    params: [
      { name: 'table', label: '테이블', kind: 'identifier', identifierKind: 'table', required: true },
      { name: 'dupColumn', label: '중복 검사 컬럼', kind: 'identifier', identifierKind: 'column', required: true },
      { name: 'tenantValue', label: 'tenant 값 (선택)', kind: 'value', valueType: 'number' },
    ],
    sql: `SELECT {{dupColumn}}, COUNT(*) AS duplicateCount
FROM {{table}}
WHERE {{dupColumn}} IS NOT NULL AND {{dupColumn}} <> ''
[[  AND {{role:tenant}} = :tenantValue]]
[[  AND {{role:soft_delete}} IS NULL]]
GROUP BY {{dupColumn}}
HAVING COUNT(*) > 1
ORDER BY duplicateCount DESC`,
  },
  {
    id: 'group-count-recent', source: 'builtin', category: '운영 점검',
    name: '그룹별 최근 N일 집계',
    description: '최근 N일간 특정 컬럼 기준으로 행 수를 집계합니다. 병원별 최근 30일 내원 수 확인 등에 사용합니다.',
    roles: ['soft_delete'],
    params: [
      { name: 'table', label: '테이블', kind: 'identifier', identifierKind: 'table', required: true },
      { name: 'groupColumn', label: '그룹 컬럼', kind: 'identifier', identifierKind: 'column', required: true },
      { name: 'dateColumn', label: '날짜 컬럼', kind: 'identifier', identifierKind: 'column', required: true },
      { name: 'days', label: '최근 N일', kind: 'value', valueType: 'number', required: true, default: '30' },
    ],
    sql: `SELECT {{groupColumn}}, COUNT(*) AS cnt
FROM {{table}}
WHERE {{dateColumn}} >= (CURRENT_DATE - INTERVAL :days DAY)
[[  AND {{role:soft_delete}} IS NULL]]
GROUP BY {{groupColumn}}
ORDER BY cnt DESC`,
  },
  // … 나머지 6개 동일 패턴으로 추가:
  // 'entity-history' (CS 조사): {{table}},{{idColumn}},:idValue → 특정 엔티티 내역
  // 'rows-by-value'  (CS 조사): {{table}},{{column}},:value [[tenant]]
  // 'null-check'     (운영 점검): {{table}},{{column}} WHERE col IS NULL OR col=''
  // 'recent-rows'    (운영 점검): {{table}},{{createdColumn}} ORDER BY created DESC LIMIT :limit
  // 'recent-since'   (개발 QA): {{table}},{{createdColumn}} WHERE created >= :since
  // 'distinct-dist'  (개발 QA): {{table}},{{column}} GROUP BY col ORDER BY cnt DESC LIMIT :limit
];
```
> 나머지 6개는 위 두 개와 **동일한 구조**(SELECT만, 식별자는 `{{}}`, 값은 `:`, tenant/soft_delete는 `[[]]`)로 작성한다. `:limit`/`:days`/`:since` 등 값 파라미터는 `valueType` 명시, `required`/`default` 지정. 각 `description`은 한 문장 이상.

> **dialect 주의:** `CURRENT_DATE - INTERVAL :days DAY`는 mysql/postgres에서 동작하지만 sqlite/sqlserver는 다르다. v1 빌트인은 **mysql/postgres 표적**으로 두고 `driver` 필드를 비워(any) 두되, 날짜 산술 템플릿(`group-count-recent`,`recent-since`)은 description에 "MySQL/PostgreSQL" 표기. (sqlite/sqlserver 전용 변형은 후속.)

- [ ] **Step 4: 통과 확인** — Run: `pnpm --filter renderer test builtinTemplates && pnpm --filter renderer test` → PASS(전체 렌더러 테스트 그린).

- [ ] **Step 5: 커밋**
```bash
git add apps/renderer/src/lib/builtinTemplates.ts apps/renderer/src/lib/builtinTemplates.test.ts
git commit -m "feat(renderer): 빌트인 범용 템플릿 8종 + 무결성 테스트 (#105)"
```

---

## Task 8: 렌더러 — 템플릿 IPC 배선 + 타입

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/renderer/src/global.d.ts`

- [ ] **Step 1: preload** — `apps/desktop/src/preload/index.ts`의 `listSavedQueries`/`saveQuery`/`deleteSavedQuery`(line 144-146) 근처에 추가:
```ts
  listTemplates: (workspaceId: string) => ipcRenderer.invoke('list-templates', workspaceId),
  saveTemplate: (template: any) => ipcRenderer.invoke('save-template', template),
  deleteTemplate: (id: string) => ipcRenderer.invoke('delete-template', id),
```

- [ ] **Step 2: main** — `apps/desktop/src/main/index.ts`의 saved-query 핸들러(line 1200-1232) 근처에 추가, `requestEngine` 패턴:
```ts
  ipcMain.handle('list-templates', async (_e, workspaceId) => {
    try {
      const data = await requestEngine({ method: 'GET', path: `/templates?workspaceId=${encodeURIComponent(workspaceId)}` });
      return { success: true, data };
    } catch (err: any) { return { success: false, error: err.message }; }
  });
  ipcMain.handle('save-template', async (_e, template) => {
    try {
      const data = await requestEngine({ method: 'POST', path: '/templates', body: template });
      return { success: true, data };
    } catch (err: any) { return { success: false, error: err.message }; }
  });
  ipcMain.handle('delete-template', async (_e, id) => {
    try {
      const data = await requestEngine({ method: 'DELETE', path: `/templates?id=${encodeURIComponent(id)}` });
      return { success: true, data };
    } catch (err: any) { return { success: false, error: err.message }; }
  });
```

- [ ] **Step 3: 렌더러 타입** — `apps/renderer/src/global.d.ts`의 ElectronAPI에 추가:
```ts
  listTemplates: (workspaceId: string) => Promise<{ success: boolean; data?: UserTemplate[]; error?: string }>;
  saveTemplate: (template: UserTemplate) => Promise<{ success: boolean; data?: UserTemplate; error?: string }>;
  deleteTemplate: (id: string) => Promise<{ success: boolean; error?: string }>;
```
같은 파일에 타입(엔진 Template JSON 매핑) 추가:
```ts
export interface UserTemplate {
  id: string; workspaceId: string; name: string; description: string;
  category: string; sqlText: string; parameters: string; driver: string;
  createdAt?: string; updatedAt?: string;
}
```
그리고 `ConnectionProfile`(또는 프로필 타입)에 `domainBindings?: string` 추가(line 53 부근의 profile 인터페이스).

- [ ] **Step 4: 빌드 + 커밋** — Run: `pnpm --filter desktop build && pnpm --filter renderer build`.
```bash
git add apps/desktop/src/preload/index.ts apps/desktop/src/main/index.ts apps/renderer/src/global.d.ts
git commit -m "feat(renderer): template IPC + domainBindings 타입 (#105)"
```

---

## Task 9: 렌더러 — DomainBindingsDialog (역할→컬럼 매핑)

**Files:**
- Create: `apps/renderer/src/components/DomainBindingsDialog.tsx`

- [ ] **Step 1: 구현** — 연결의 컬럼 목록(introspection: `window.electronAPI.getSchemaCompletion(profileId, database)` 또는 기존 컬럼 조회)으로 역할별 드롭다운을 만들고, 초기값은 `suggestBindings` + 기존 `profile.domainBindings`. 저장 시 `updateProfile`로 `domainBindings` JSON 반영.

```tsx
import { useEffect, useState } from 'react';
import { suggestBindings } from '../lib/suggestBindings';

const ROLES: { key: string; label: string; hint: string }[] = [
  { key: 'tenant', label: 'Tenant 컬럼', hint: '병원/조직 구분 컬럼 (예: hospitalId)' },
  { key: 'soft_delete', label: 'Soft-delete 컬럼', hint: '삭제 표시 컬럼 (예: deletedAt)' },
];

interface Props {
  profile: any;                 // ConnectionProfile (has id, database, domainBindings, tenantColumns)
  columns: string[];            // distinct column names across the connection's tables
  onClose: () => void;
  onSaved: () => void;
}

export function DomainBindingsDialog({ profile, columns, onClose, onSaved }: Props) {
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let existing: Record<string, string> = {};
    try { existing = profile.domainBindings ? JSON.parse(profile.domainBindings) : {}; } catch { /* ignore */ }
    const tenantCols = (profile.tenantColumns ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const suggested = suggestBindings(columns, tenantCols);
    setBindings({ ...suggested, ...existing }); // existing wins over suggestion
  }, [profile, columns]);

  async function save() {
    setSaving(true);
    const cleaned = Object.fromEntries(Object.entries(bindings).filter(([, v]) => v));
    await window.electronAPI.updateProfile({ ...profile, domainBindings: JSON.stringify(cleaned) });
    setSaving(false);
    onSaved();
    onClose();
  }

  return (
    <div className="risk-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="risk-dialog">
        <header className="risk-header"><span className="risk-verb">도메인 설정 · {profile.name}</span></header>
        <section className="risk-body">
          <p className="risk-note">의미 역할을 실제 컬럼에 매핑하면 템플릿이 자동으로 사용합니다. (스키마에서 자동 추천됨)</p>
          {ROLES.map((r) => (
            <div key={r.key} className="form-field">
              <label>{r.label}</label>
              <select value={bindings[r.key] ?? ''} onChange={(e) => setBindings((b) => ({ ...b, [r.key]: e.target.value }))}>
                <option value="">(미설정)</option>
                {columns.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <span className="dialog-hint">{r.hint}</span>
            </div>
          ))}
        </section>
        <footer className="risk-footer">
          <div className="risk-actions">
            <button onClick={onClose}>취소</button>
            <button className="btn btn-primary" disabled={saving} onClick={save}>저장</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
```
> `columns`는 호출측(App/TemplatesPanel)이 `getSchemaCompletion`(ColumnRef[])에서 distinct 컬럼명을 모아 전달. `updateProfile`은 기존 IPC.

- [ ] **Step 2: 빌드 확인** — Run: `pnpm --filter renderer build`.

- [ ] **Step 3: 커밋**
```bash
git add apps/renderer/src/components/DomainBindingsDialog.tsx
git commit -m "feat(renderer): DomainBindingsDialog 역할→컬럼 매핑 (#105)"
```

---

## Task 10: 렌더러 — TemplateRunner (파라미터 폼 + 실행 + 결과 + 후속)

**Files:**
- Create: `apps/renderer/src/components/TemplateRunner.tsx`

핵심 컴포넌트. 입력: `template: TemplateDef`, `profile`, `columns`/`tables`(introspection), `roles`(profile.domainBindings parsed), `onOpenInEditor(sql)`. 흐름: 파라미터 폼 → `renderTemplate` → 미충족 required 없으면 "실행" 활성 → `executeQueryStream`로 실행(기존 스트리밍 수신 패턴 재사용) → `ResultGrid` → 후속 바(CSV/요약 복사/에디터).

- [ ] **Step 1: 구현** — (스트리밍 수신은 QueryEditor의 단일-statement 수집 패턴을 참고; 여기서는 간단화해 onQueryStreamChunk 구독으로 columns/rows 누적):

```tsx
import { useMemo, useState } from 'react';
import type { TemplateDef } from '../lib/templateTypes';
import { renderTemplate } from '../lib/templateRender';
import { buildSummary, formatSummary, type SummaryFormat } from '../lib/templateSummary';
import { toCsv } from '../lib/gridExport';
import { ResultGrid } from './ResultGrid';

interface Props {
  template: TemplateDef;
  profileId: string;
  driver: string;
  database: string;
  tables: string[];
  columns: string[];
  roles: Record<string, string>;
  onOpenInEditor: (sql: string) => void;
}

export function TemplateRunner({ template, profileId, driver, database, tables, columns, roles, onOpenInEditor }: Props) {
  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(template.params.filter((p) => p.default).map((p) => [p.name, p.default!])),
  );
  const [result, setResult] = useState<{ columns: string[]; rows: unknown[][] } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validIdentifiers = useMemo(
    () => new Set([...tables, ...columns].map((s) => s.toLowerCase())),
    [tables, columns],
  );
  const rendered = useMemo(
    () => renderTemplate(template, { driver: driver as any, inputs, roles, validIdentifiers }),
    [template, inputs, roles, validIdentifiers, driver],
  );

  async function run() {
    if (rendered.missing.length > 0) return;
    setRunning(true); setError(null); setResult(null);
    const queryId = `tpl-${Date.now()}`;
    const cols: string[] = [];
    const rows: unknown[][] = [];
    const off = window.electronAPI.onQueryStreamChunk((qid, chunk: any) => {
      if (qid !== queryId) return;
      if (chunk.type === 'meta') cols.push(...chunk.columns);
      else if (chunk.type === 'row') rows.push(chunk.data ?? chunk.row);
      else if (chunk.type === 'error') { setError(chunk.message ?? 'error'); setRunning(false); off?.(); }
      else if (chunk.type === 'done') { setResult({ columns: cols, rows }); setRunning(false); off?.(); }
    });
    const res = await window.electronAPI.executeQueryStream(queryId, profileId, rendered.sql, { acknowledged: true });
    if (!res.success) { setError(res.error ?? 'failed'); setRunning(false); off?.(); }
  }

  function copySummary(fmt: SummaryFormat) {
    if (!result) return;
    const s = buildSummary(template.name, result.columns, result.rows);
    navigator.clipboard?.writeText(formatSummary(s, fmt));
  }
  function downloadCsv() {
    if (!result) return;
    const blob = new Blob([toCsv(result.columns, result.rows)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${template.id}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="template-runner">
      <header className="template-runner-head">
        <h3>{template.name}</h3>
        <p className="template-desc">{template.description}</p>
      </header>
      <div className="template-params">
        {template.params.map((p) => (
          <div key={p.name} className="form-field">
            <label>{p.label}{p.required ? ' *' : ''}</label>
            {p.kind === 'identifier' ? (
              <select value={inputs[p.name] ?? ''} onChange={(e) => setInputs((s) => ({ ...s, [p.name]: e.target.value }))}>
                <option value="">(선택)</option>
                {(p.identifierKind === 'table' ? tables : columns).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : p.kind === 'enum' ? (
              <select value={inputs[p.name] ?? ''} onChange={(e) => setInputs((s) => ({ ...s, [p.name]: e.target.value }))}>
                <option value="">(선택)</option>
                {(p.options ?? []).map((o) => <option key={o.label} value={o.value ?? o.label}>{o.label}</option>)}
              </select>
            ) : (
              <input type={p.valueType === 'number' ? 'number' : p.valueType === 'date' ? 'date' : 'text'}
                value={inputs[p.name] ?? ''} onChange={(e) => setInputs((s) => ({ ...s, [p.name]: e.target.value }))} />
            )}
          </div>
        ))}
      </div>
      <details className="template-sql-preview"><summary>SQL 미리보기</summary><pre className="risk-sql">{rendered.sql}</pre></details>
      <div className="template-actions">
        <button className="btn btn-primary" disabled={rendered.missing.length > 0 || running} onClick={run}>
          {running ? '실행 중…' : '실행'}
        </button>
        <button className="btn" onClick={() => onOpenInEditor(rendered.sql)} disabled={rendered.missing.length > 0}>에디터에서 열기</button>
      </div>
      {error && <p className="risk-warn-text">{error}</p>}
      {result && (
        <>
          <div className="template-followups">
            <button onClick={downloadCsv}>CSV</button>
            <button onClick={() => copySummary('plain')}>요약 복사</button>
            <button onClick={() => copySummary('slack')}>Slack</button>
            <button onClick={() => copySummary('jira')}>Jira</button>
          </div>
          <ResultGrid columns={result.columns} rows={result.rows} />
        </>
      )}
    </div>
  );
}
```
> `onQueryStreamChunk`의 반환(구독 해제 함수) 유무는 기존 preload 구현을 확인해 맞춘다. 해제 함수가 없으면 컴포넌트 unmount/완료 시 무시해도 동작에는 문제 없음(중복 누적 방지 위해 queryId 가드 사용). 실제 chunk 필드명(`data` vs `row`)은 QueryEditor 구현을 참고해 일치시킨다.

- [ ] **Step 2: 빌드 확인** — Run: `pnpm --filter renderer build`.

- [ ] **Step 3: 커밋**
```bash
git add apps/renderer/src/components/TemplateRunner.tsx
git commit -m "feat(renderer): TemplateRunner 파라미터 폼+실행+후속 (#105)"
```

---

## Task 11: 렌더러 — TemplatesPanel + SaveTemplateDialog

**Files:**
- Create: `apps/renderer/src/components/TemplatesPanel.tsx`
- Create: `apps/renderer/src/components/SaveTemplateDialog.tsx`

- [ ] **Step 1: TemplatesPanel** — 빌트인 + 사용자 템플릿을 카테고리별로 묶어 목록 표시, 검색, "도메인 설정"·"새 템플릿" 버튼. 사용자 템플릿은 `listTemplates('default')`로 로드해 `UserTemplate`→`TemplateDef`(source:'user', params=JSON.parse)로 매핑. 선택 시 `onSelectTemplate(def)`.

```tsx
import { useEffect, useMemo, useState } from 'react';
import { BUILTIN_TEMPLATES } from '../lib/builtinTemplates';
import type { TemplateDef } from '../lib/templateTypes';

interface Props {
  onSelectTemplate: (t: TemplateDef) => void;
  onOpenDomainSettings: () => void;
  onNewTemplate: () => void;
  reloadKey?: number; // bump to re-fetch user templates after save/delete
}

export function TemplatesPanel({ onSelectTemplate, onOpenDomainSettings, onNewTemplate, reloadKey }: Props) {
  const [user, setUser] = useState<TemplateDef[]>([]);
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    window.electronAPI.listTemplates('default').then((res) => {
      if (!alive || !res.success || !res.data) return;
      setUser(res.data.map((u) => {
        let params = [];
        try { params = JSON.parse(u.parameters || '[]'); } catch { /* ignore */ }
        return { id: u.id, name: u.name, description: u.description, category: u.category || '내 템플릿',
          sql: u.sqlText, params, roles: [], driver: u.driver, source: 'user' } as TemplateDef;
      }));
    });
    return () => { alive = false; };
  }, [reloadKey]);

  const all = useMemo(() => [...BUILTIN_TEMPLATES, ...user], [user]);
  const filtered = useMemo(
    () => all.filter((t) => (t.name + t.description).toLowerCase().includes(q.toLowerCase())),
    [all, q],
  );
  const byCat = useMemo(() => {
    const m = new Map<string, TemplateDef[]>();
    for (const t of filtered) { const a = m.get(t.category) ?? []; a.push(t); m.set(t.category, a); }
    return [...m.entries()];
  }, [filtered]);

  return (
    <div className="templates-panel">
      <div className="templates-toolbar">
        <input className="input" placeholder="템플릿 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-sm" onClick={onOpenDomainSettings}>도메인 설정</button>
        <button className="btn btn-sm" onClick={onNewTemplate}>+ 새 템플릿</button>
      </div>
      {byCat.map(([cat, items]) => (
        <div key={cat} className="templates-cat">
          <div className="templates-cat-head">{cat}</div>
          {items.map((t) => (
            <button key={t.id} className="template-item" onClick={() => onSelectTemplate(t)} title={t.description}>
              <span className="template-item-name">{t.name}</span>
              <span className="template-item-desc">{t.description}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: SaveTemplateDialog** — 에디터의 현재 SQL을 받아 이름·설명·카테고리·SQL을 입력하고 `:name`/`{{name}}`을 스캔해 파라미터 초안을 만든 뒤 `saveTemplate`로 저장:

```tsx
import { useMemo, useState } from 'react';
import type { TemplateParam } from '../lib/templateTypes';

function scanParams(sql: string): TemplateParam[] {
  const out: TemplateParam[] = [];
  const seen = new Set<string>();
  const noRoles = sql.replace(/\{\{role:(\w+)\}\}/g, '');
  for (const m of noRoles.matchAll(/\{\{(\w+)\}\}/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push({ name: m[1], label: m[1], kind: 'identifier', identifierKind: 'column', required: true }); }
  }
  for (const m of noRoles.matchAll(/:(\w+)/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push({ name: m[1], label: m[1], kind: 'value', valueType: 'string', required: true }); }
  }
  return out;
}

interface Props { initialSql?: string; onClose: () => void; onSaved: () => void; }

export function SaveTemplateDialog({ initialSql = '', onClose, onSaved }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('내 템플릿');
  const [sql, setSql] = useState(initialSql);
  const params = useMemo(() => scanParams(sql), [sql]);

  async function save() {
    if (!name.trim() || !sql.trim()) return;
    await window.electronAPI.saveTemplate({
      id: '', workspaceId: 'default', name, description, category,
      sqlText: sql, parameters: JSON.stringify(params), driver: '',
    } as any);
    onSaved(); onClose();
  }

  return (
    <div className="risk-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="risk-dialog">
        <header className="risk-header"><span className="risk-verb">새 템플릿 저장</span></header>
        <section className="risk-body">
          <div className="form-field"><label>이름 *</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="form-field"><label>설명</label><input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="form-field"><label>카테고리</label><input value={category} onChange={(e) => setCategory(e.target.value)} /></div>
          <div className="form-field"><label>SQL (`:값`, `{'{{컬럼}}'}` 자리표시자)</label>
            <textarea rows={6} value={sql} onChange={(e) => setSql(e.target.value)} /></div>
          {params.length > 0 && <p className="dialog-hint">감지된 파라미터: {params.map((p) => p.name).join(', ')}</p>}
        </section>
        <footer className="risk-footer"><div className="risk-actions">
          <button onClick={onClose}>취소</button>
          <button className="btn btn-primary" disabled={!name.trim() || !sql.trim()} onClick={save}>저장</button>
        </div></footer>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 빌드 확인** — Run: `pnpm --filter renderer build`.

- [ ] **Step 4: 커밋**
```bash
git add apps/renderer/src/components/TemplatesPanel.tsx apps/renderer/src/components/SaveTemplateDialog.tsx
git commit -m "feat(renderer): TemplatesPanel + SaveTemplateDialog (#105)"
```

---

## Task 12: 렌더러 — App.tsx 통합 + CSS

**Files:**
- Modify: `apps/renderer/src/App.tsx`
- Modify: `apps/renderer/src/App.css`

- [ ] **Step 1: App.tsx 통합** — 다음을 추가(기존 sideTab Saved/History 구조와 main-pane 분기를 따른다):
  1. 사이드바 focused-panel의 탭에 **Templates** 추가(`sideTab: 'saved'|'history'|'templates'`). `templates`일 때 `<TemplatesPanel onSelectTemplate={openTemplate} onOpenDomainSettings={openDomainDialog} onNewTemplate={openSaveTemplate} reloadKey={tplReload} />`.
  2. 상태: `const [templateView, setTemplateView] = useState<Record<string, TemplateDef|null>>({})`, `domainDialog`/`saveTemplateDialog`/`tplReload` 상태.
  3. `openTemplate(def)` = focused 연결에 대해 `setTemplateView({ ...m, [id]: def })`(메인 페인이 Runner를 표시). 메인 페인 분기에서 redis/mongo/er/openTable 검사 뒤, `templateView[id]`가 있으면 `<TemplateRunner template={templateView[id]} profileId={id} driver={profile.driver} database={db} tables={tables} columns={columns} roles={parseBindings(profile.domainBindings)} onOpenInEditor={(sql) => { setTemplateView({...m,[id]:null}); handleSelectQuery(sql); }} />`.
  4. `tables`/`columns`는 기존 introspection 상태에서 가져오거나 `getSchemaCompletion`(ColumnRef[])로 distinct table/column 계산해 전달. `parseBindings`는 `JSON.parse(domainBindings||'{}')` 안전 래퍼.
  5. `domainDialog` 열리면 `<DomainBindingsDialog profile={focusedProfile} columns={columns} onClose={...} onSaved={() => { reloadProfiles(); }} />`. `saveTemplateDialog` 열리면 `<SaveTemplateDialog initialSql={selectedQueryText} onClose={...} onSaved={() => setTplReload(n=>n+1)} />`.

> 정확한 삽입 위치는 App.tsx의 sidebar focused-panel(Saved/History 버튼)과 main-pane dispatch(redis/mongo/er/openTable/QueryEditor 분기)를 읽고 동일 패턴으로 끼운다. QueryEditor·다른 뷰 흐름을 깨지 않는다(Templates는 추가 분기일 뿐).

- [ ] **Step 2: CSS** — `App.css` 끝에 추가:
```css
.templates-panel { display: flex; flex-direction: column; gap: 6px; padding: 8px; overflow: auto; }
.templates-toolbar { display: flex; gap: 6px; align-items: center; }
.templates-toolbar .input { flex: 1; }
.templates-cat-head { font-size: 11px; text-transform: uppercase; opacity: 0.6; margin: 8px 0 2px; }
.template-item { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%;
  text-align: left; background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 6px 8px; cursor: pointer; }
.template-item:hover { background: var(--hover, #2a2a2a); border-color: var(--border, #333); }
.template-item-name { font-weight: 600; font-size: 13px; }
.template-item-desc { font-size: 11px; opacity: 0.7; line-height: 1.3; }
.template-runner { display: flex; flex-direction: column; gap: 12px; padding: 16px; overflow: auto; height: 100%; }
.template-runner-head h3 { margin: 0; }
.template-desc { opacity: 0.75; font-size: 13px; margin: 4px 0 0; }
.template-params { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.template-sql-preview pre { max-height: 160px; overflow: auto; }
.template-actions, .template-followups { display: flex; gap: 8px; }
.template-followups { margin-top: 8px; }
```

- [ ] **Step 3: 빌드 + 테스트 확인** — Run: `pnpm --filter renderer test && pnpm --filter renderer build && pnpm --filter desktop build` → 전부 PASS.

- [ ] **Step 4: 커밋**
```bash
git add apps/renderer/src/App.tsx apps/renderer/src/App.css
git commit -m "feat(renderer): App에 Templates 탭·Runner·도메인설정 통합 + CSS (#105)"
```

---

## Task 13: 검증 — 전체 빌드/테스트 + CDP 라이브

**Files:** (없음 — 검증)

- [ ] **Step 1: 엔진 전체** — Run: `/Users/smlee/sdk/go/bin/go test ./engine/... && /Users/smlee/sdk/go/bin/go build ./engine/...` → PASS.

- [ ] **Step 2: 렌더러 전체 + 빌드** — Run: `pnpm --filter renderer test && pnpm --filter renderer build && pnpm --filter desktop build` → PASS.

- [ ] **Step 3: CDP 라이브** — 앱 빌드 후 Playwright/CDP로 dev-mysql 검증(`erg_*` 임시 테이블):
  1. 연결 후 사이드바 **Templates** 탭 → 카테고리·설명 표시 확인.
  2. **도메인 설정** 열기 → 자동 추천(tenant←hospitalId 등) 프리필 확인 → 저장.
  3. "컬럼 기준 중복 행 찾기" 선택 → 폼에서 table=erg 테이블, dupColumn=중복컬럼 선택, tenantValue 입력 → SQL 미리보기에 `[[]]` 블록 반영 확인 → **실행** → 결과 그리드.
  4. 후속: CSV 다운로드, 요약 복사(클립보드), 에디터에서 열기 동작 확인.
  5. **새 템플릿**: 에디터 SQL을 템플릿으로 저장 → 목록에 표시 → 실행 확인.
  스크린샷 기록.

- [ ] **Step 4: 정리** — `erg_*` 임시 테이블 drop. 변경 있으면 커밋.

---

## Self-Review

**1. Spec coverage:**
- A 렌더링 문법 → Task 4
- B 파라미터 모델 + 빌트인 → Task 4(types) + Task 7
- C 도메인 바인딩 + 자동추천 → Task 1(engine) + Task 5(suggest) + Task 9(dialog)
- D 사용자 커스텀 템플릿 → Task 2·3(engine) + Task 8(IPC) + Task 11(SaveDialog)
- E 후속 액션 → Task 6(summary) + Task 10(Runner: CSV/요약/에디터)
- F UI → Task 9·10·11·12
- 완료기준 7+1 모두 매핑.

**2. Placeholder scan:** 빌트인 6개 템플릿은 "동일 패턴으로 작성"으로 위임했으나, 2개 완전 예시 + 각 6개의 id/카테고리/자리표시자 구성을 명시했고 무결성 테스트(Task 7)가 누락·불일치를 강제로 잡는다 — 실질 placeholder 아님. App.tsx 통합(Task 12)은 정확한 삽입 위치를 "기존 패턴 따라"로 안내(대형 파일이라 패턴 참조가 적절).

**3. Type consistency:** `TemplateDef`/`TemplateParam`/`RenderContext`/`RenderResult`(templateTypes.ts), `UserTemplate`(global.d.ts), 엔진 `Template`(camelCase JSON: id/workspaceId/name/description/category/sqlText/parameters/driver) ↔ IPC body/handler 디코드 일치. `renderTemplate(def, ctx)` 시그니처가 Task 4 정의와 Task 10 호출에서 일치. `buildSummary`/`formatSummary`(Task 6) ↔ Task 10 호출 일치. `suggestBindings(columns, tenantColumns)`(Task 5) ↔ Task 9 호출 일치.
