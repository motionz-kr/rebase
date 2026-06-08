# Agent stdio MCP 클라이언트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱 내 에이전트가 외부 stdio MCP 서버에 아웃바운드 연결해 그 도구를 `mcp__<server>__<tool>` 프록시로 자기 카탈로그에 병합하고, 서버별 신뢰 플래그(신뢰=자동, 비신뢰=propose)로 안전하게 호출한다.

**Architecture:** 신규 `mcpclient` 패키지가 외부 프로세스를 spawn하고 JSON-RPC 2.0(initialize/tools/list/tools/call)로 통신한다. `mcp_servers` 테이블(워크스페이스 스코프)에 서버 설정을 저장하고 env는 키체인 blob에 둔다. `/agent/run` 시작 시 `AttachMCPServers`가 활성 서버를 붙여 프록시 도구로 등록한다. UI는 기존 `McpConnectPanel` 옆 `McpServersPanel`.

**Tech Stack:** Go 1.25 엔진(clean architecture, SQLite 메타데이터, os/exec), React 19 + Vitest 렌더러, Electron IPC. Go: `/Users/smlee/sdk/go/bin/go`.

---

## File Structure

**엔진 (Go)**
- Create `engine/internal/adapters/mcpclient/client.go` — stdio JSON-RPC MCP 클라이언트.
- Create `engine/internal/adapters/mcpclient/client_test.go` — fake 서버(io.Pipe) 단위 테스트.
- Create `engine/internal/domain/mcpserver.go` — `McpServer` 타입 + `ArgsList()`.
- Create `engine/internal/domain/mcpserver_test.go`.
- Modify `engine/cmd/app-engine/main.go` — 마이그레이션 v10 + repo/handler 배선 + 라우트.
- Create `engine/internal/adapters/sqlite/sqlite_mcpserver_repository.go` — CRUD.
- Create `engine/internal/adapters/sqlite/sqlite_mcpserver_repository_test.go`.
- Create `engine/internal/agent/external.go` — `Registry.RegisterExternal` + `AttachMCPServers`.
- Create `engine/internal/agent/external_test.go`.
- Create `engine/internal/transport/http/mcpserver.go` — `/mcp/servers*` 핸들러.
- Modify `engine/internal/transport/http/agent.go` — Run()에 `AttachMCPServers` 배선 + AgentHandler 필드.

**렌더러 (TS/React)**
- Create `apps/renderer/src/lib/mcpServerForm.ts` — 폼 파싱/검증 + 프록시 도구명 라벨.
- Create `apps/renderer/src/lib/mcpServerForm.test.ts`.
- Create `apps/renderer/src/components/McpServersPanel.tsx`.
- Modify `apps/renderer/src/components/AgentChat.tsx` — 외부 도구 제안 렌더 + 실행.
- Modify `apps/renderer/src/global.d.ts` — IPC 타입.
- Modify `apps/desktop/src/main/index.ts` + `apps/desktop/src/preload/index.ts` — IPC.
- Modify `apps/renderer/src/App.css` — 패널 스타일.

---

## Task 1: MCP 클라이언트 (stdio JSON-RPC)

**Files:**
- Create: `engine/internal/adapters/mcpclient/client.go`
- Test: `engine/internal/adapters/mcpclient/client_test.go`

- [ ] **Step 1: 실패 테스트 작성** — `client_test.go`:

```go
package mcpclient

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"testing"
)

// fakeServer answers JSON-RPC requests on r, writing responses to w.
func fakeServer(r io.Reader, w io.Writer) {
	sc := bufio.NewScanner(r)
	enc := json.NewEncoder(w)
	for sc.Scan() {
		var req map[string]any
		if json.Unmarshal(sc.Bytes(), &req) != nil {
			continue
		}
		id, hasID := req["id"]
		if !hasID {
			continue // notification
		}
		method, _ := req["method"].(string)
		resp := map[string]any{"jsonrpc": "2.0", "id": id}
		switch method {
		case "initialize":
			resp["result"] = map[string]any{"protocolVersion": "2024-11-05"}
		case "tools/list":
			resp["result"] = map[string]any{"tools": []map[string]any{
				{"name": "echo", "description": "Echo text", "inputSchema": map[string]any{"type": "object"}},
			}}
		case "tools/call":
			params, _ := req["params"].(map[string]any)
			args, _ := params["arguments"].(map[string]any)
			resp["result"] = map[string]any{"content": []map[string]any{
				{"type": "text", "text": "echo:" + asString(args["text"])},
			}}
		default:
			resp["error"] = map[string]any{"code": -32601, "message": "method not found"}
		}
		_ = enc.Encode(resp)
	}
}

func asString(v any) string { s, _ := v.(string); return s }

func newTestClient(t *testing.T) *Client {
	c2sR, c2sW := io.Pipe()
	s2cR, s2cW := io.Pipe()
	go fakeServer(c2sR, s2cW)
	c := newClient(c2sW, s2cR)
	if err := c.initialize(context.Background()); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	return c
}

func TestListTools(t *testing.T) {
	c := newTestClient(t)
	specs, err := c.ListTools(context.Background())
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(specs) != 1 || specs[0].Name != "echo" || specs[0].Description != "Echo text" {
		t.Fatalf("unexpected specs: %+v", specs)
	}
}

func TestCall(t *testing.T) {
	c := newTestClient(t)
	out, err := c.Call(context.Background(), "echo", map[string]any{"text": "hi"})
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if out != "echo:hi" {
		t.Fatalf("got %v", out)
	}
}
```

- [ ] **Step 2: 실패 확인** — `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/mcpclient/` → FAIL (no package).

- [ ] **Step 3: 구현** — `client.go`:

```go
// Package mcpclient is an outbound MCP client over stdio: it spawns an external
// MCP server process and speaks newline-delimited JSON-RPC 2.0 (initialize,
// tools/list, tools/call). Requests are serialized (one in flight at a time).
package mcpclient

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type Client struct {
	mu  sync.Mutex
	w   io.Writer
	r   *bufio.Reader
	cmd *exec.Cmd // nil in tests
	id  int
}

func newClient(w io.Writer, r io.Reader) *Client {
	br := bufio.NewReader(r)
	return &Client{w: w, r: br}
}

// Dial spawns the server process, performs the initialize handshake, and
// returns a ready client. env is merged onto the current environment.
func Dial(ctx context.Context, command string, args []string, env map[string]string) (*Client, error) {
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("spawn %q: %w", command, err)
	}
	c := newClient(stdin, stdout)
	c.cmd = cmd
	if err := c.initialize(ctx); err != nil {
		_ = c.Close()
		return nil, err
	}
	return c, nil
}

type rpcReq struct {
	Jsonrpc string `json:"jsonrpc"`
	ID      *int   `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcResp struct {
	ID     *int            `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// notify writes a JSON-RPC notification (no id, no reply expected).
func (c *Client) notify(method string, params any) error {
	b, _ := json.Marshal(rpcReq{Jsonrpc: "2.0", Method: method, Params: params})
	_, err := c.w.Write(append(b, '\n'))
	return err
}

// request sends a request and reads responses until the matching id arrives,
// skipping notifications/logs the server may interleave.
func (c *Client) request(method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.id++
	id := c.id
	b, _ := json.Marshal(rpcReq{Jsonrpc: "2.0", ID: &id, Method: method, Params: params})
	if _, err := c.w.Write(append(b, '\n')); err != nil {
		return nil, err
	}
	for {
		line, err := c.r.ReadBytes('\n')
		if err != nil {
			return nil, err
		}
		var resp rpcResp
		if json.Unmarshal(line, &resp) != nil || resp.ID == nil {
			continue
		}
		if *resp.ID != id {
			continue
		}
		if resp.Error != nil {
			return nil, fmt.Errorf("rpc error %d: %s", resp.Error.Code, resp.Error.Message)
		}
		return resp.Result, nil
	}
}

func (c *Client) initialize(ctx context.Context) error {
	_ = ctx
	_, err := c.request("initialize", map[string]any{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "rebase", "version": "0.1.0"},
	})
	if err != nil {
		return err
	}
	return c.notify("notifications/initialized", map[string]any{})
}

// ListTools returns the server's tool catalog mapped to ports.ToolSpec.
func (c *Client) ListTools(ctx context.Context) ([]ports.ToolSpec, error) {
	_ = ctx
	raw, err := c.request("tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var out struct {
		Tools []struct {
			Name        string         `json:"name"`
			Description string         `json:"description"`
			InputSchema map[string]any `json:"inputSchema"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	specs := make([]ports.ToolSpec, 0, len(out.Tools))
	for _, t := range out.Tools {
		specs = append(specs, ports.ToolSpec{Name: t.Name, Description: t.Description, Schema: t.InputSchema})
	}
	return specs, nil
}

// Call invokes a tool and returns its result. MCP content text parts are
// concatenated; if the text parses as JSON it is returned as the decoded value,
// otherwise as a string. isError surfaces as a Go error.
func (c *Client) Call(ctx context.Context, name string, args map[string]any) (any, error) {
	_ = ctx
	raw, err := c.request("tools/call", map[string]any{"name": name, "arguments": args})
	if err != nil {
		return nil, err
	}
	var out struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	text := ""
	for _, p := range out.Content {
		text += p.Text
	}
	if out.IsError {
		return nil, fmt.Errorf("%s", text)
	}
	var decoded any
	if json.Unmarshal([]byte(text), &decoded) == nil {
		return decoded, nil
	}
	return text, nil
}

// Close terminates the server process (best-effort).
func (c *Client) Close() error {
	if wc, ok := c.w.(io.Closer); ok {
		_ = wc.Close()
	}
	if c.cmd != nil && c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
		_ = c.cmd.Wait()
	}
	return nil
}
```

- [ ] **Step 4: 통과 확인** — `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/mcpclient/ -v` → PASS (2 tests).

- [ ] **Step 5: 커밋**

```bash
git add engine/internal/adapters/mcpclient/
git commit -m "feat(engine): stdio MCP 클라이언트 (initialize/tools.list/tools.call) (#36)"
```

---

## Task 2: 도메인 McpServer + 마이그레이션 v10 + repo

**Files:**
- Create: `engine/internal/domain/mcpserver.go`
- Test: `engine/internal/domain/mcpserver_test.go`
- Modify: `engine/cmd/app-engine/main.go` (마이그레이션 슬라이스, v9 뒤)
- Create: `engine/internal/adapters/sqlite/sqlite_mcpserver_repository.go`
- Test: `engine/internal/adapters/sqlite/sqlite_mcpserver_repository_test.go`

- [ ] **Step 1: 도메인 실패 테스트** — `mcpserver_test.go`:

```go
package domain

import "testing"

func TestMcpServerArgsList(t *testing.T) {
	s := McpServer{Args: `["-y","@modelcontextprotocol/server-everything"]`}
	got := s.ArgsList()
	if len(got) != 2 || got[0] != "-y" || got[1] != "@modelcontextprotocol/server-everything" {
		t.Fatalf("got %#v", got)
	}
	if len((McpServer{Args: ""}).ArgsList()) != 0 {
		t.Fatal("empty Args should yield no elements")
	}
	if len((McpServer{Args: "not json"}).ArgsList()) != 0 {
		t.Fatal("invalid Args should yield no elements")
	}
}
```

- [ ] **Step 2: 실패 확인** — `/Users/smlee/sdk/go/bin/go test ./engine/internal/domain/ -run TestMcpServerArgsList` → FAIL.

- [ ] **Step 3: 도메인 구현** — `mcpserver.go`:

```go
package domain

import (
	"encoding/json"
	"strings"
	"time"
)

// McpServer is one external stdio MCP server configured for a workspace. Args
// is a JSON array string; env (secrets) lives in the keychain, not here.
type McpServer struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspaceId"`
	Name        string    `json:"name"`
	Command     string    `json:"command"`
	Args        string    `json:"args"` // JSON array
	Enabled     bool      `json:"enabled"`
	Trusted     bool      `json:"trusted"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// ArgsList parses Args JSON into a slice. Invalid/empty yields nil.
func (s McpServer) ArgsList() []string {
	if strings.TrimSpace(s.Args) == "" {
		return nil
	}
	var out []string
	_ = json.Unmarshal([]byte(s.Args), &out)
	return out
}
```

- [ ] **Step 4: 통과 확인** — `/Users/smlee/sdk/go/bin/go test ./engine/internal/domain/ -run TestMcpServerArgsList` → PASS.

- [ ] **Step 5: 마이그레이션 v10** — `engine/cmd/app-engine/main.go` migrations 슬라이스에서 `Version: 9` 항목 뒤에 추가:

```go
		{
			Version: 10,
			Name:    "create_mcp_servers",
			SQL: `
				CREATE TABLE IF NOT EXISTS mcp_servers (
					id TEXT PRIMARY KEY,
					workspace_id TEXT NOT NULL,
					name TEXT NOT NULL,
					command TEXT NOT NULL,
					args TEXT NOT NULL DEFAULT '[]',
					enabled INTEGER NOT NULL DEFAULT 1,
					trusted INTEGER NOT NULL DEFAULT 0,
					created_at DATETIME NOT NULL,
					updated_at DATETIME NOT NULL,
					FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
				);
			`,
			Checksum: "mcp-servers-v1",
		},
```

- [ ] **Step 6: repo 실패 테스트** — `sqlite_mcpserver_repository_test.go` (기존 `sqlite_template_repository_test.go`의 in-memory DB + 인라인 DDL 셋업 패턴을 그대로 따른다; `workspaces` 테이블 + 위 `mcp_servers` DDL 생성):

```go
func TestMcpServerRepo_RoundTrip(t *testing.T) {
	repo, db := newMcpRepo(t) // 헬퍼: in-memory DB + workspaces + mcp_servers DDL
	defer db.Close()
	ctx := context.Background()

	s := &domain.McpServer{ID: "s1", WorkspaceID: "default", Name: "everything",
		Command: "npx", Args: `["-y","srv"]`, Enabled: true, Trusted: false,
		CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := repo.Create(ctx, s); err != nil { t.Fatalf("create: %v", err) }

	list, err := repo.List(ctx, "default")
	if err != nil || len(list) != 1 || list[0].Command != "npx" {
		t.Fatalf("list: %v %+v", err, list)
	}
	s.Trusted = true
	if err := repo.Update(ctx, s); err != nil { t.Fatalf("update: %v", err) }
	again, _ := repo.List(ctx, "default")
	if !again[0].Trusted { t.Fatal("trusted not persisted") }

	if err := repo.Delete(ctx, "s1"); err != nil { t.Fatalf("delete: %v", err) }
	empty, _ := repo.List(ctx, "default")
	if len(empty) != 0 { t.Fatal("expected empty after delete") }
}
```

테스트 상단에 `newMcpRepo` 헬퍼를 작성: `sql.Open("sqlite", ":memory:")` (기존 template 테스트가 쓰는 드라이버 import와 동일), `workspaces(id TEXT PRIMARY KEY, ...)` 최소 테이블 + `INSERT INTO workspaces` default + 위 `mcp_servers` DDL 실행 후 `NewSQLiteMcpServerRepository(db)` 반환. (기존 template 테스트 파일의 헬퍼 형태를 복붙·수정.)

- [ ] **Step 7: 실패 확인** — `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/ -run TestMcpServerRepo` → FAIL (no repo).

- [ ] **Step 8: repo 구현** — `sqlite_mcpserver_repository.go` (template repo와 동형: Create/List(workspaceID)/Update/Delete + scan):

```go
package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type SQLiteMcpServerRepository struct{ db *sql.DB }

func NewSQLiteMcpServerRepository(db *sql.DB) *SQLiteMcpServerRepository {
	return &SQLiteMcpServerRepository{db: db}
}

func (r *SQLiteMcpServerRepository) Create(ctx context.Context, s *domain.McpServer) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO mcp_servers (id, workspace_id, name, command, args, enabled, trusted, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, s.ID, s.WorkspaceID, s.Name, s.Command, s.Args, s.Enabled, s.Trusted, s.CreatedAt, s.UpdatedAt)
	return err
}

func (r *SQLiteMcpServerRepository) List(ctx context.Context, workspaceID string) ([]domain.McpServer, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, workspace_id, name, command, args, enabled, trusted, created_at, updated_at
		FROM mcp_servers WHERE workspace_id = ? ORDER BY name
	`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.McpServer
	for rows.Next() {
		var s domain.McpServer
		if err := rows.Scan(&s.ID, &s.WorkspaceID, &s.Name, &s.Command, &s.Args, &s.Enabled, &s.Trusted, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}

func (r *SQLiteMcpServerRepository) Update(ctx context.Context, s *domain.McpServer) error {
	s.UpdatedAt = time.Now()
	res, err := r.db.ExecContext(ctx, `
		UPDATE mcp_servers SET name = ?, command = ?, args = ?, enabled = ?, trusted = ?, updated_at = ?
		WHERE id = ?
	`, s.Name, s.Command, s.Args, s.Enabled, s.Trusted, s.UpdatedAt, s.ID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return errors.New("mcp server not found")
	}
	return nil
}

func (r *SQLiteMcpServerRepository) Delete(ctx context.Context, id string) error {
	res, err := r.db.ExecContext(ctx, "DELETE FROM mcp_servers WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return errors.New("mcp server not found")
	}
	return nil
}
```

- [ ] **Step 9: 통과 확인** — `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/ -run TestMcpServerRepo` → PASS. 전체 패키지도: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/`.

- [ ] **Step 10: 커밋**

```bash
git add engine/internal/domain/mcpserver.go engine/internal/domain/mcpserver_test.go engine/cmd/app-engine/main.go engine/internal/adapters/sqlite/sqlite_mcpserver_repository.go engine/internal/adapters/sqlite/sqlite_mcpserver_repository_test.go
git commit -m "feat(engine): McpServer 도메인 + 마이그레이션 v10 + repo (#36)"
```

---

## Task 3: 도구 병합 — RegisterExternal + AttachMCPServers

**Files:**
- Create: `engine/internal/agent/external.go`
- Test: `engine/internal/agent/external_test.go`

이 작업은 `mcpclient.Client`를 직접 쓰지 않고 작은 인터페이스 `mcpCaller`에 의존해 테스트 가능하게 한다.

- [ ] **Step 1: 실패 테스트** — `external_test.go`:

```go
package agent

import (
	"context"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type fakeCaller struct {
	specs  []ports.ToolSpec
	called map[string]map[string]any
}

func (f *fakeCaller) ListTools(ctx context.Context) ([]ports.ToolSpec, error) { return f.specs, nil }
func (f *fakeCaller) Call(ctx context.Context, name string, args map[string]any) (any, error) {
	if f.called == nil { f.called = map[string]map[string]any{} }
	f.called[name] = args
	return "RAN:" + name, nil
}
func (f *fakeCaller) Close() error { return nil }

func TestAttachMCPServers_Namespacing(t *testing.T) {
	reg := &Registry{tools: map[string]Tool{}}
	fc := &fakeCaller{specs: []ports.ToolSpec{{Name: "read", Description: "Read"}}}
	dial := func(ctx context.Context, s domain.McpServer) (McpCaller, error) { return fc, nil }

	cleanup, warnings := AttachMCPServers(context.Background(), reg,
		[]domain.McpServer{{Name: "Files", Trusted: true, Enabled: true}}, dial)
	defer cleanup()

	if len(warnings) != 0 { t.Fatalf("unexpected warnings: %v", warnings) }
	names := map[string]bool{}
	for _, sp := range reg.Specs() { names[sp.Name] = true }
	if !names["mcp__files__read"] {
		t.Fatalf("expected proxy tool mcp__files__read, got %v", names)
	}
	// trusted → executes immediately
	out, err := reg.Dispatch(context.Background(), "mcp__files__read", map[string]any{"p": 1})
	if err != nil || out != "RAN:read" {
		t.Fatalf("trusted dispatch: %v %v", out, err)
	}
}

func TestAttachMCPServers_UntrustedProposes(t *testing.T) {
	reg := &Registry{tools: map[string]Tool{}}
	fc := &fakeCaller{specs: []ports.ToolSpec{{Name: "write", Description: "Write"}}}
	dial := func(ctx context.Context, s domain.McpServer) (McpCaller, error) { return fc, nil }
	cleanup, _ := AttachMCPServers(context.Background(), reg,
		[]domain.McpServer{{Name: "fs", Trusted: false, Enabled: true}}, dial)
	defer cleanup()

	out, err := reg.Dispatch(context.Background(), "mcp__fs__write", map[string]any{"x": 1})
	if err != nil { t.Fatalf("dispatch: %v", err) }
	m, ok := out.(map[string]any)
	if !ok || m["proposed"] != true || m["server"] != "fs" || m["tool"] != "write" {
		t.Fatalf("expected proposal, got %#v", out)
	}
	if len(fc.called) != 0 { t.Fatal("untrusted tool must NOT execute") }
}

func TestAttachMCPServers_FailureSkips(t *testing.T) {
	reg := &Registry{tools: map[string]Tool{}}
	dial := func(ctx context.Context, s domain.McpServer) (McpCaller, error) {
		return nil, context.DeadlineExceeded
	}
	cleanup, warnings := AttachMCPServers(context.Background(), reg,
		[]domain.McpServer{{Name: "broken", Enabled: true}}, dial)
	defer cleanup()
	if len(warnings) != 1 {
		t.Fatalf("expected 1 warning, got %v", warnings)
	}
	if len(reg.Specs()) != 0 {
		t.Fatal("failed server should add no tools")
	}
}
```

- [ ] **Step 2: 실패 확인** — `/Users/smlee/sdk/go/bin/go test ./engine/internal/agent/ -run TestAttachMCPServers` → FAIL.

- [ ] **Step 3: 구현** — `external.go`:

```go
package agent

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// McpCaller is the slice of an MCP client AttachMCPServers needs (so it can be
// faked in tests). *mcpclient.Client satisfies it. Public so the /agent/run
// handler can build a DialFunc.
type McpCaller interface {
	ListTools(ctx context.Context) ([]ports.ToolSpec, error)
	Call(ctx context.Context, name string, args map[string]any) (any, error)
	Close() error
}

// DialFunc opens a client for one server.
type DialFunc func(ctx context.Context, s domain.McpServer) (McpCaller, error)

// RegisterExternal adds an external (proxy) tool to the registry.
func (r *Registry) RegisterExternal(spec ports.ToolSpec, run func(ctx context.Context, args map[string]any) (any, error)) {
	r.add(Tool{Spec: spec, Run: run})
}

var nameSanitize = regexp.MustCompile(`[^a-z0-9_]+`)

func sanitize(s string) string {
	return strings.Trim(nameSanitize.ReplaceAllString(strings.ToLower(s), "_"), "_")
}

// AttachMCPServers dials each enabled server, lists its tools, and registers
// them as `mcp__<server>__<tool>` proxies. Trusted servers execute immediately;
// untrusted ones return a proposal (propose model). Failed servers are skipped
// with a warning. The returned cleanup closes all opened clients.
func AttachMCPServers(ctx context.Context, reg *Registry, servers []domain.McpServer, dial DialFunc) (func(), []string) {
	var clients []McpCaller
	var warnings []string
	cleanup := func() {
		for _, c := range clients {
			_ = c.Close()
		}
	}
	for _, s := range servers {
		if !s.Enabled {
			continue
		}
		client, err := dial(ctx, s)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("MCP 서버 %q 연결 실패: %v", s.Name, err))
			continue
		}
		clients = append(clients, client)
		specs, err := client.ListTools(ctx)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("MCP 서버 %q 도구 목록 실패: %v", s.Name, err))
			continue
		}
		serverSlug := sanitize(s.Name)
		for _, sp := range specs {
			toolName := sp.Name
			proxyName := fmt.Sprintf("mcp__%s__%s", serverSlug, sanitize(toolName))
			spec := ports.ToolSpec{
				Name:        proxyName,
				Description: fmt.Sprintf("[외부:%s] %s", s.Name, sp.Description),
				Schema:      sp.Schema,
			}
			if s.Trusted {
				c := client
				reg.RegisterExternal(spec, func(ctx context.Context, args map[string]any) (any, error) {
					return c.Call(ctx, toolName, args)
				})
			} else {
				serverName := s.Name
				serverID := s.ID
				reg.RegisterExternal(spec, func(ctx context.Context, args map[string]any) (any, error) {
					return map[string]any{
						"proposed": true,
						"server":   serverName,
						"serverId": serverID, // renderer uses this for /mcp/servers/call
						"tool":     toolName,
						"args":     args,
						"trusted":  false,
					}, nil
				})
			}
		}
	}
	return cleanup, warnings
}
```

- [ ] **Step 4: 통과 확인** — `/Users/smlee/sdk/go/bin/go test ./engine/internal/agent/ -run TestAttachMCPServers -v` → PASS (3 tests). 전체 agent 패키지: `/Users/smlee/sdk/go/bin/go test ./engine/internal/agent/`.

- [ ] **Step 5: 커밋**

```bash
git add engine/internal/agent/external.go engine/internal/agent/external_test.go
git commit -m "feat(engine): 외부 MCP 도구 병합 (RegisterExternal + AttachMCPServers) (#36)"
```

---

## Task 4: HTTP 핸들러 + 라우트 + /agent/run 배선

**Files:**
- Create: `engine/internal/transport/http/mcpserver.go`
- Modify: `engine/internal/transport/http/agent.go` (AgentHandler 필드 + Run 배선)
- Modify: `engine/cmd/app-engine/main.go` (repo/handler 생성 + 라우트)

이 작업은 순수 로직이 아니므로 빌드/스모크로 검증한다(핸들러는 기존 패턴 복제).

- [ ] **Step 1: McpServerHandler 작성** — `mcpserver.go`. 의존: mcp 서버 repo + secretStore + `mcpclient.Dial`. 라우트:
  - `GET /mcp/servers?workspaceId=default` → `repo.List` → JSON 배열(+각 서버의 enabled/trusted).
  - `POST /mcp/servers` body `{id?,name,command,args[],enabled,trusted,env}` → id 없으면 생성(UUID), 있으면 Update. env는 `secretStore.Set("mcp_env_"+id, json(env))`. args는 JSON 문자열로 직렬화해 저장.
  - `DELETE /mcp/servers?id=...` → `repo.Delete` + `secretStore.Delete("mcp_env_"+id)`.
  - `POST /mcp/servers/test` body `{command,args[],env}` → `mcpclient.Dial` → `ListTools` → `Close` → `{tools:[{name,description}]}` 또는 `{error}`.
  - `POST /mcp/servers/call` body `{command,args[],env,tool,toolArgs}` → `Dial`→`Call(tool,toolArgs)`→`Close` → `{result}` 또는 `{error}` (비신뢰 제안의 실제 실행용; 서버 id로 repo 조회 후 env는 키체인에서 로드).
  모든 핸들러는 기존 `agent.go`의 `checkToken` 동등 토큰 검사 + JSON 인코딩 패턴을 따른다. UUID는 기존 코드가 쓰는 방식(예: `crypto/rand` 또는 google/uuid — 기존 repo에서 id 생성 방식 확인 후 동일 사용; 템플릿 저장은 렌더러가 id 생성하므로 여기서도 body.id가 비면 `fmt.Sprintf` 기반 랜덤 또는 기존 util 사용).

  핸들러 구조체:
```go
type McpServerHandler struct {
	token   string
	repo    *sqlite.SQLiteMcpServerRepository
	secrets ports.SecretStore
}
func NewMcpServerHandler(token string, repo *sqlite.SQLiteMcpServerRepository, secrets ports.SecretStore) *McpServerHandler { ... }
```
  env 로드 헬퍼: `func (h *McpServerHandler) envFor(ctx, serverID string) map[string]string` — `secrets.Get("mcp_env_"+serverID)` → JSON unmarshal(없으면 빈 맵).

- [ ] **Step 2: /agent/run 배선** — `agent.go`:
  - AgentHandler 구조체에 필드 추가: `mcpRepo *sqlite.SQLiteMcpServerRepository`, `secrets ports.SecretStore`.
  - Run() 핸들러에서 `svc.SetDomainContext(...)` 직후, 워크스페이스 활성 MCP 서버를 붙인다:
```go
		if h.mcpRepo != nil {
			servers, _ := h.mcpRepo.List(r.Context(), "default")
			dial := func(ctx context.Context, s domain.McpServer) (agent.McpCaller, error) {
				env := map[string]string{}
				if blob, e := h.secrets.Get(ctx, "mcp_env_"+s.ID); e == nil && blob != "" {
					_ = json.Unmarshal([]byte(blob), &env)
				}
				return mcpclient.Dial(ctx, s.Command, s.ArgsList(), env)
			}
			detach, _ := agent.AttachMCPServers(r.Context(), registry, servers, dial)
			defer detach()
		}
```
  참고: `agent.AttachMCPServers`의 `DialFunc`/`mcpCaller`가 비공개면, 이 배선을 위해 `mcpCaller`를 공개 `McpCaller`로 바꾸고 `DialFunc` 시그니처를 공개 타입으로 둔다(Task 3에서 미리 공개 네이밍으로 정의해도 됨 — 구현자는 Task 3의 `mcpCaller`를 `McpCaller`(공개)로 정의하고 테스트/배선을 맞춘다). **결정: Task 3에서 인터페이스를 `McpCaller`(공개), `DialFunc`(공개)로 정의한다.** (Task 3 코드의 `mcpCaller`→`McpCaller`로 통일.)

- [ ] **Step 3: main.go 배선** — repo 생성 + 핸들러 등록 + AgentHandler에 주입:
```go
	mcpServerRepo := sqlite.NewSQLiteMcpServerRepository(db)
	// AgentHandler에 주입 (NewAgentHandler 직후 필드 할당 또는 생성자 확장):
	agentHandler.SetMCP(mcpServerRepo, secretStore) // 신규 setter
	mcpServerHandler := internalHttp.NewMcpServerHandler(*token, mcpServerRepo, secretStore)
	mux.Handle("/mcp/servers", mcpServerHandler.Servers())       // GET/POST/DELETE 분기
	mux.Handle("/mcp/servers/test", mcpServerHandler.Test())
	mux.Handle("/mcp/servers/call", mcpServerHandler.Call())
```
  `SetMCP`는 AgentHandler에 추가하는 작은 setter(`func (h *AgentHandler) SetMCP(repo *sqlite.SQLiteMcpServerRepository, s ports.SecretStore){ h.mcpRepo=repo; h.secrets=s }`).

- [ ] **Step 4: 빌드 + 전체 엔진 테스트**

Run: `/Users/smlee/sdk/go/bin/go build ./engine/... && /Users/smlee/sdk/go/bin/go test ./engine/...`
Expected: 전부 PASS (회귀 없음; mcp 서버 미설정 시 `List`가 빈 슬라이스 → 기존 동작 불변).

- [ ] **Step 5: 커밋**

```bash
git add engine/internal/transport/http/mcpserver.go engine/internal/transport/http/agent.go engine/cmd/app-engine/main.go engine/internal/agent/external.go engine/internal/agent/external_test.go
git commit -m "feat(engine): /mcp/servers 핸들러 + /agent/run에 외부 도구 배선 (#36)"
```

---

## Task 5: 렌더러 순수 로직

**Files:**
- Create: `apps/renderer/src/lib/mcpServerForm.ts`
- Test: `apps/renderer/src/lib/mcpServerForm.test.ts`

- [ ] **Step 1: 실패 테스트** — `mcpServerForm.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseArgs, parseEnv, validateServer, proxyToolLabel } from './mcpServerForm';

describe('parseArgs', () => {
  it('splits on whitespace, ignoring blanks', () => {
    expect(parseArgs('-y  @scope/server   /tmp')).toEqual(['-y', '@scope/server', '/tmp']);
    expect(parseArgs('')).toEqual([]);
  });
});

describe('parseEnv', () => {
  it('parses KEY=VALUE lines, skipping blanks/comments', () => {
    expect(parseEnv('API_KEY=abc\n\n# note\nTOKEN=xyz')).toEqual({ API_KEY: 'abc', TOKEN: 'xyz' });
  });
});

describe('validateServer', () => {
  it('requires name and command', () => {
    expect(validateServer({ name: '', command: 'npx' })).toMatch(/이름/);
    expect(validateServer({ name: 'x', command: '' })).toMatch(/명령/);
    expect(validateServer({ name: 'x', command: 'npx' })).toBe('');
  });
});

describe('proxyToolLabel', () => {
  it('splits mcp__server__tool into parts', () => {
    expect(proxyToolLabel('mcp__files__read_file')).toEqual({ server: 'files', tool: 'read_file' });
    expect(proxyToolLabel('list_tables')).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인** — `cd /Users/smlee/projects/product/database && pnpm --filter renderer test mcpServerForm` → FAIL.

- [ ] **Step 3: 구현** — `mcpServerForm.ts`:

```ts
export function parseArgs(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

export function parseEnv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

export function validateServer(s: { name: string; command: string }): string {
  if (!s.name.trim()) return '서버 이름을 입력하세요.';
  if (!s.command.trim()) return '실행 명령을 입력하세요.';
  return '';
}

export function proxyToolLabel(name: string): { server: string; tool: string } | null {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(name);
  if (!m) return null;
  return { server: m[1], tool: m[2] };
}
```

- [ ] **Step 4: 통과 확인** — `pnpm --filter renderer test mcpServerForm` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/renderer/src/lib/mcpServerForm.ts apps/renderer/src/lib/mcpServerForm.test.ts
git commit -m "feat(renderer): MCP 서버 폼 파싱/검증 순수 로직 (#36)"
```

---

## Task 6: IPC 배선 (main + preload + 타입)

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/renderer/src/global.d.ts`

기존 `mcpSetSettings` 등 IPC 패턴을 그대로 복제한다(엔진 포트로 http.request).

- [ ] **Step 1: main IPC 핸들러** — `apps/desktop/src/main/index.ts`에 기존 `requestEngine`/http.request 헬퍼 패턴으로 추가:
  - `ipcMain.handle('mcp-servers-list', (_e, workspaceId) => GET /mcp/servers?workspaceId=...)`
  - `ipcMain.handle('mcp-servers-save', (_e, server) => POST /mcp/servers (server))`
  - `ipcMain.handle('mcp-servers-delete', (_e, id) => DELETE /mcp/servers?id=...)`
  - `ipcMain.handle('mcp-servers-test', (_e, payload) => POST /mcp/servers/test (payload))`
  - `ipcMain.handle('mcp-servers-call', (_e, payload) => POST /mcp/servers/call (payload))`
  (기존 `mcp-set-settings` 핸들러의 http.request 구조를 복사해 path/method/body만 교체.)

- [ ] **Step 2: preload 브리지** — `apps/desktop/src/preload/index.ts`에 추가:
```ts
  mcpServersList: (workspaceId: string) => ipcRenderer.invoke('mcp-servers-list', workspaceId),
  mcpServersSave: (server: unknown) => ipcRenderer.invoke('mcp-servers-save', server),
  mcpServersDelete: (id: string) => ipcRenderer.invoke('mcp-servers-delete', id),
  mcpServersTest: (payload: unknown) => ipcRenderer.invoke('mcp-servers-test', payload),
  mcpServersCall: (payload: unknown) => ipcRenderer.invoke('mcp-servers-call', payload),
```

- [ ] **Step 3: 타입** — `apps/renderer/src/global.d.ts`의 electronAPI 인터페이스에 추가:
```ts
      mcpServersList: (workspaceId: string) => Promise<ResultWrapper<McpServer[]>>;
      mcpServersSave: (server: McpServerInput) => Promise<ResultWrapper<{ id: string }>>;
      mcpServersDelete: (id: string) => Promise<ResultWrapper<{ ok: boolean }>>;
      mcpServersTest: (payload: { command: string; args: string[]; env: Record<string,string> }) => Promise<ResultWrapper<{ tools?: { name: string; description: string }[]; error?: string }>>;
      mcpServersCall: (payload: { serverId: string; tool: string; toolArgs: Record<string, unknown> }) => Promise<ResultWrapper<{ result?: unknown; error?: string }>>;
```
  같은 파일에 타입 선언 추가:
```ts
interface McpServer { id: string; workspaceId: string; name: string; command: string; args: string[]; enabled: boolean; trusted: boolean; }
interface McpServerInput { id?: string; name: string; command: string; args: string[]; enabled: boolean; trusted: boolean; env: Record<string, string>; }
```

- [ ] **Step 4: 빌드 확인** — `cd /Users/smlee/projects/product/database && pnpm --filter desktop build && pnpm --filter renderer build` → 성공.

- [ ] **Step 5: 커밋**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/renderer/src/global.d.ts
git commit -m "feat(desktop): MCP 서버 IPC 배선 (#36)"
```

---

## Task 7: McpServersPanel + AgentChat 제안 렌더 + CSS

**Files:**
- Create: `apps/renderer/src/components/McpServersPanel.tsx`
- Modify: `apps/renderer/src/components/AgentChat.tsx`
- Modify: `apps/renderer/src/App.tsx` (패널 진입점)
- Modify: `apps/renderer/src/App.css`

- [ ] **Step 1: McpServersPanel 작성** — `McpServersPanel.tsx`:
  - 마운트 시 `mcpServersList('default')` → 목록 표시(이름·command·전송=stdio 배지·활성/신뢰 토글). 토글 변경 시 `mcpServersSave`.
  - 추가 폼: name, command, args(텍스트), env(텍스트). `parseArgs`/`parseEnv`/`validateServer`(Task 5) 사용. "연결 테스트" → `mcpServersTest({command, args, env})` → 도구 목록 또는 에러 표시. "추가" → `mcpServersSave`.
  - 각 항목 삭제 버튼 → `mcpServersDelete(id)`.
  - 스타일 클래스 `.mcp-srv-*`, 테마 토큰(`--bg-input`/`--border`/`--text`/`--text-2`/`--accent`) 사용.
  - 임의 명령 실행 경고 문구: "외부 MCP 서버는 지정한 명령을 로컬에서 실행합니다. 신뢰할 수 있는 서버만 추가하세요."

- [ ] **Step 2: AgentChat 외부 제안 렌더** — `AgentChat.tsx`. 기존 도구 결과/`propose_write` 렌더 로직 근처에서, 도구 결과 객체가 `{proposed:true, server, tool, args}` 형태면 외부 도구 제안 카드를 렌더: 서버·도구·인자(JSON) 표시 + "실행" 버튼 → `window.electronAPI.mcpServersCall({serverId, tool, toolArgs})`(serverId는 목록에서 server 이름→id 매핑; v1은 server 이름으로 호출하되 main에서 이름→id 조회, 또는 제안에 serverId 포함하도록 Task 3/4에서 `server` 외 `serverId`도 넣는다 — **결정: AttachMCPServers 제안 맵에 `serverId`도 포함**(Task 3의 untrusted 분기 map에 `"serverId": s.ID` 추가). 실행 결과를 카드에 표시.
  (이 단계는 빌드 검증만; AgentChat은 큰 파일이므로 기존 메시지 렌더 구조를 읽고 최소 침습적으로 분기 추가.)

- [ ] **Step 3: App 진입점** — 기존 MCP 설정/`McpConnectPanel`을 여는 UI 근처에 `McpServersPanel` 진입(탭 또는 섹션). 기존 패널 마운트 패턴을 따라 상태 토글로 표시.

- [ ] **Step 4: CSS** — `App.css`에 `.mcp-srv-*` + 외부 제안 카드 `.agent-ext-proposal` 스타일(테마 토큰).

- [ ] **Step 5: 빌드/린트/테스트** — `pnpm --filter renderer build && pnpm --filter renderer lint && pnpm --filter renderer test` → 모두 clean/pass.

- [ ] **Step 6: 커밋**

```bash
git add apps/renderer/src/components/McpServersPanel.tsx apps/renderer/src/components/AgentChat.tsx apps/renderer/src/App.tsx apps/renderer/src/App.css
git commit -m "feat(renderer): McpServersPanel + 외부 도구 제안 렌더 (#36)"
```

(Task 3의 untrusted 제안 map에 `"serverId": s.ID` 추가를 잊지 말 것 — Task 4 배선 시 함께 반영.)

---

## Task 8: 전체 검증 (빌드/테스트 + CDP 라이브)

**Files:**
- Throwaway: `apps/desktop/e2e/mcp-client.verify.spec.ts` (+ 경량 stdio MCP 서버 fixture; 커밋하지 않음)

- [ ] **Step 1: 전체 수트**

Run:
```bash
cd /Users/smlee/projects/product/database
/Users/smlee/sdk/go/bin/go test ./engine/... && /Users/smlee/sdk/go/bin/go build ./engine/...
pnpm --filter renderer test 2>&1 | tail -4
pnpm --filter renderer lint 2>&1 | tail -3
pnpm --filter renderer build >/dev/null && echo RENDERER_OK
pnpm --filter desktop build >/dev/null && echo DESKTOP_OK
pnpm build:engine >/dev/null && echo ENGINE_BIN_OK
```
Expected: 엔진 PASS, 렌더러 PASS+lint clean, RENDERER_OK, DESKTOP_OK, ENGINE_BIN_OK.

- [ ] **Step 2: CDP 라이브 검증** — throwaway 스펙 + 경량 stdio MCP 서버를 작성한다. 서버는 Node 한 파일(예: `e2e/fixtures/echo-mcp-server.mjs`)로, stdin에서 JSON-RPC를 읽어 `initialize`/`tools/list`(도구 `echo`)/`tools/call`(echo 텍스트 반환)에 응답한다. 스펙 흐름:
  1. 앱 실행 → MCP 서버 패널 열기 → 서버 추가(name="Echo", command="node", args="<절대경로>/echo-mcp-server.mjs", trusted=ON).
  2. "연결 테스트" → 도구 `echo`가 목록에 표시되는지 단언.
  3. (신뢰 서버) MySQL 연결 후 AgentChat에서 "echo 도구로 'hello'를 보내줘" → 에이전트가 `mcp__echo__echo` 호출 → 결과에 `echo:hello` 포함 확인. (AI 경로는 키체인 OAuth.)
  4. 비신뢰 경로: trusted OFF로 바꾼 뒤 동일 질의 → 제안 카드 표시 → "실행" → 결과 표시.
  5. 스크린샷 `docs/verify-mcp-client.png`.
  fixture는 기존 `e2e/fixtures.ts`(격리 userDataDir/ENGINE_DB_PATH) 사용.

- [ ] **Step 3: 결과 확인 + 정리** — 스크린샷 확인 → throwaway 스펙·fixture·png 삭제. 임시 `erg_*`/잔여 없음 확인.

- [ ] **Step 4: 커밋(필요 시)** — 검증 중 코드 수정이 있었으면 커밋, 아니면 스킵.

---

## Self-Review (작성자 체크)

**스펙 커버리지**
- MCP 클라이언트(stdio) → Task 1 ✅
- 서버 레지스트리/영속화 → Task 2 ✅; 설정 UI → Task 7 ✅
- 도구 카탈로그 병합 + 출처(`mcp__server__tool`, `[외부:]`) → Task 3 ✅
- 서버별 활성/신뢰 + 안전(propose) → Task 2(enabled/trusted) + Task 3(trusted 분기) + Task 7(제안 렌더) ✅
- env 키체인 → Task 4(secretStore.Set/Get `mcp_env_<id>`) ✅
- HTTP/SSE → 범위 외(2차) ✅

**플레이스홀더 스캔:** Task 4·7은 순수 코드가 아니므로 기존 패턴(template repo, mcp-set-settings IPC, propose_write 렌더)을 명시 참조 + 정확한 라우트/시그니처 제공. Task 8 throwaway는 fixture 재사용 명시.

**타입 일관성:** `McpServer`(Go: ID/WorkspaceID/Name/Command/Args/Enabled/Trusted; TS: 동형 + args:string[]) — Go는 Args=JSON문자열, TS/IPC는 args=string[](main에서 JSON 직렬화). `McpCaller`/`DialFunc`(공개), `AttachMCPServers(ctx, reg, servers, dial)` 시그니처 Task 3 정의·Task 4 호출 일치. 프록시 이름 `mcp__<server>__<tool>` Task 3 생성·Task 5 `proxyToolLabel` 파싱 일치. 비신뢰 제안 map에 `proposed/server/serverId/tool/args/trusted` — Task 3에서 `serverId` 포함(Task 7 실행에 필요).
