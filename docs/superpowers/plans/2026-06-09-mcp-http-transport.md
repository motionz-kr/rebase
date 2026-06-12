# MCP HTTP 전송 (sub-project 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 에이전트가 원격 MCP 서버(Streamable HTTP 전송)에 연결해 도구를 사용하고, 인증은 정적 헤더/베어러 토큰(키체인)으로 처리한다.

**Architecture:** `mcpclient`를 `transport` 인터페이스로 리팩터해 프로토콜 로직(initialize/tools.list/tools.call)을 공유하고, stdio(기존)와 http(신규 Streamable HTTP) 두 전송을 둔다. `McpServer`에 `Transport`/`URL`을 더하고(마이그 v11), 인증 헤더는 키체인 blob `mcp_headers_<id>`에 둔다. 핸들러가 전송에 따라 `DialStdio`/`DialHTTP`로 분기한다.

**Tech Stack:** Go 1.25 엔진(net/http, httptest), React 19 + Vitest 렌더러, Electron IPC. Go: `/Users/smlee/sdk/go/bin/go`.

---

## 구현 가드레일 (스펙 반영)

- **출시된 stdio 회귀 금지**: 리팩터 후 기존 `engine/internal/adapters/mcpclient/client_test.go`는 **수정 없이 그대로 통과**해야 한다(`newClient`/`initialize`/`ListTools`/`Call` 표면 보존). 이게 HT1의 하드 게이트.
- **httpTransport는 per-POST 단순 매칭**: stdio의 mutex+id-loop를 복사하지 말 것. POST 하나당 응답 하나.
- **타임아웃**: `/test`만 15s, 실제 도구 `Call`·`/agent/run`은 요청 ctx 그대로.

## File Structure

**엔진 (Go)**
- Create `engine/internal/adapters/mcpclient/transport.go` — `transport` 인터페이스 + `stdioTransport`(기존 파이프 로직 이전) + `httpTransport`(Streamable HTTP) + SSE 파서.
- Create `engine/internal/adapters/mcpclient/transport_test.go` — httpTransport httptest 테스트.
- Modify `engine/internal/adapters/mcpclient/client.go` — `Client{t transport}` + `newClient`/`DialStdio`/`DialHTTP` + protocol 메서드 위임.
- Modify `engine/internal/domain/mcpserver.go` — `Transport`/`URL` + `TransportKind()`.
- Modify `engine/internal/domain/mcpserver_test.go` — TransportKind 테스트.
- Modify `engine/cmd/app-engine/main.go` — 마이그 v11.
- Modify `engine/internal/adapters/sqlite/sqlite_mcpserver_repository.go` — transport/url 컬럼.
- Modify `engine/internal/adapters/sqlite/sqlite_mcpserver_repository_test.go` — 인라인 DDL + 왕복.
- Modify `engine/internal/transport/http/mcpserver.go` — Dial 분기 + headersFor + body 확장 + 타임아웃.
- Modify `engine/internal/transport/http/agent.go` — dial 클로저 분기.

**렌더러 (TS/React)**
- Modify `apps/renderer/src/lib/mcpServerForm.ts` — `parseHeaders` + `validateServer` http url.
- Modify `apps/renderer/src/lib/mcpServerForm.test.ts`.
- Modify `apps/renderer/src/components/McpServersPanel.tsx` — 전송 select + url/headers + payload 분기 + 행 배지.
- Modify `apps/renderer/src/global.d.ts` — 타입 확장.

---

## Task 1: mcpclient 전송 추상화 + httpTransport

**Files:**
- Create: `engine/internal/adapters/mcpclient/transport.go`
- Create: `engine/internal/adapters/mcpclient/transport_test.go`
- Modify: `engine/internal/adapters/mcpclient/client.go`
- Unchanged (must stay green): `engine/internal/adapters/mcpclient/client_test.go`

- [ ] **Step 1: Create `transport.go`** (stdioTransport = 기존 로직 이전, httpTransport = 신규):

```go
package mcpclient

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"sync"
)

// transport carries JSON-RPC requests/notifications to one MCP server. Two
// implementations share the protocol layer (Client): stdioTransport (spawned
// process over pipes) and httpTransport (Streamable HTTP).
type transport interface {
	request(ctx context.Context, method string, params any) (json.RawMessage, error)
	notify(ctx context.Context, method string, params any) error
	Close() error
}

// --- stdio (moved verbatim from the old Client) ---

type stdioTransport struct {
	mu  sync.Mutex
	w   io.Writer
	r   *bufio.Reader
	cmd *exec.Cmd // nil in tests
	id  int
}

func newStdio(w io.Writer, r io.Reader) *stdioTransport {
	return &stdioTransport{w: w, r: bufio.NewReader(r)}
}

func (t *stdioTransport) notify(_ context.Context, method string, params any) error {
	b, _ := json.Marshal(rpcReq{Jsonrpc: "2.0", Method: method, Params: params})
	_, err := t.w.Write(append(b, '\n'))
	return err
}

func (t *stdioTransport) request(_ context.Context, method string, params any) (json.RawMessage, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.id++
	id := t.id
	b, _ := json.Marshal(rpcReq{Jsonrpc: "2.0", ID: &id, Method: method, Params: params})
	if _, err := t.w.Write(append(b, '\n')); err != nil {
		return nil, err
	}
	for {
		line, err := t.r.ReadBytes('\n')
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

func (t *stdioTransport) Close() error {
	if wc, ok := t.w.(io.Closer); ok {
		_ = wc.Close()
	}
	if t.cmd != nil && t.cmd.Process != nil {
		_ = t.cmd.Process.Kill()
		_ = t.cmd.Wait()
	}
	return nil
}

// --- http (Streamable HTTP, MCP 2025-03) ---

type httpTransport struct {
	url     string
	headers map[string]string
	client  *http.Client
	mu      sync.Mutex
	id      int
	session string
}

func newHTTP(url string, headers map[string]string) *httpTransport {
	return &httpTransport{url: url, headers: headers, client: &http.Client{}}
}

func (t *httpTransport) post(ctx context.Context, body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range t.headers {
		req.Header.Set(k, v)
	}
	t.mu.Lock()
	sid := t.session
	t.mu.Unlock()
	if sid != "" {
		req.Header.Set("Mcp-Session-Id", sid)
	}
	return t.client.Do(req)
}

func (t *httpTransport) notify(ctx context.Context, method string, params any) error {
	b, _ := json.Marshal(rpcReq{Jsonrpc: "2.0", Method: method, Params: params})
	resp, err := t.post(ctx, b)
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("http %d", resp.StatusCode)
	}
	return nil
}

func (t *httpTransport) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	t.mu.Lock()
	t.id++
	id := t.id
	t.mu.Unlock()
	b, _ := json.Marshal(rpcReq{Jsonrpc: "2.0", ID: &id, Method: method, Params: params})
	resp, err := t.post(ctx, b)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		t.mu.Lock()
		t.session = sid
		t.mu.Unlock()
	}
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		return readSSEResponse(resp.Body, id)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return parseRPCResult(body, id)
}

func (t *httpTransport) Close() error { return nil } // connectionless

// readSSEResponse reads SSE event blocks (blank-line separated), joins each
// block's `data:` lines with "\n", and returns the first JSON-RPC message whose
// id matches. Non-matching messages (server notifications) are skipped.
func readSSEResponse(body io.Reader, id int) (json.RawMessage, error) {
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	var dataLines []string
	flush := func() (json.RawMessage, bool, error) {
		if len(dataLines) == 0 {
			return nil, false, nil
		}
		raw := []byte(strings.Join(dataLines, "\n"))
		dataLines = dataLines[:0]
		var resp rpcResp
		if json.Unmarshal(raw, &resp) != nil || resp.ID == nil || *resp.ID != id {
			return nil, false, nil
		}
		if resp.Error != nil {
			return nil, true, fmt.Errorf("rpc error %d: %s", resp.Error.Code, resp.Error.Message)
		}
		return resp.Result, true, nil
	}
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			if res, done, err := flush(); done || err != nil {
				return res, err
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
		// event:/id:/retry:/comment lines are ignored
	}
	if res, done, err := flush(); done || err != nil {
		return res, err
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("event stream ended without response for id %d", id)
}

func parseRPCResult(body []byte, id int) (json.RawMessage, error) {
	var resp rpcResp
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, err
	}
	if resp.ID == nil || *resp.ID != id {
		return nil, fmt.Errorf("response id mismatch")
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("rpc error %d: %s", resp.Error.Code, resp.Error.Message)
	}
	return resp.Result, nil
}
```

- [ ] **Step 2: Rewrite `client.go`** to delegate to `transport`. Replace the file body (keep package doc, `rpcReq`/`rpcResp` type defs, imports trimmed) with:

```go
// Package mcpclient is an outbound MCP client that speaks JSON-RPC 2.0 to an
// external server over a pluggable transport (stdio or Streamable HTTP):
// initialize, tools/list, tools/call.
package mcpclient

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type Client struct {
	t transport
}

// newClient wraps a stdio transport over the given pipes (used by tests).
func newClient(w io.Writer, r io.Reader) *Client {
	return &Client{t: newStdio(w, r)}
}

// DialStdio spawns the server process, performs the initialize handshake, and
// returns a ready client. env is merged onto the current environment.
func DialStdio(ctx context.Context, command string, args []string, env map[string]string) (*Client, error) {
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
	st := newStdio(stdin, stdout)
	st.cmd = cmd
	c := &Client{t: st}
	if err := c.initialize(ctx); err != nil {
		_ = c.Close()
		return nil, err
	}
	return c, nil
}

// DialHTTP connects to a Streamable HTTP MCP server at url with the given
// request headers (e.g. Authorization), performing the initialize handshake.
func DialHTTP(ctx context.Context, url string, headers map[string]string) (*Client, error) {
	c := &Client{t: newHTTP(url, headers)}
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

func (c *Client) initialize(ctx context.Context) error {
	_, err := c.t.request(ctx, "initialize", map[string]any{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "rebase", "version": "0.1.0"},
	})
	if err != nil {
		return err
	}
	return c.t.notify(ctx, "notifications/initialized", map[string]any{})
}

// ListTools returns the server's tool catalog mapped to ports.ToolSpec.
func (c *Client) ListTools(ctx context.Context) ([]ports.ToolSpec, error) {
	raw, err := c.t.request(ctx, "tools/list", map[string]any{})
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

// Call invokes a tool. MCP content text parts are concatenated; JSON text is
// decoded, otherwise returned as a string. isError surfaces as a Go error.
func (c *Client) Call(ctx context.Context, name string, args map[string]any) (any, error) {
	raw, err := c.t.request(ctx, "tools/call", map[string]any{"name": name, "arguments": args})
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

// Close releases the transport (terminates a stdio process; no-op for HTTP).
func (c *Client) Close() error { return c.t.Close() }
```

IMPORTANT: `client.go` now needs `io` imported (for `newClient(w io.Writer, r io.Reader)`). Add `"io"` to client.go imports. `transport.go` already imports `io`. Both files are `package mcpclient` so `rpcReq`/`rpcResp`/`newStdio`/`newHTTP`/`readSSEResponse`/`parseRPCResult` are shared.

- [ ] **Step 3: Verify the OLD stdio test still passes UNCHANGED:**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/mcpclient/ -run 'TestListTools|TestCall' -v`
Expected: PASS (the existing `client_test.go` `newClient`/`initialize`/`ListTools`/`Call` work via stdioTransport). Do NOT modify `client_test.go`.

- [ ] **Step 4: Add httpTransport test** `transport_test.go`:

```go
package mcpclient

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// httpEcho is a Streamable HTTP MCP server: initialize → session header;
// tools/list → one tool "echo"; tools/call → JSON or SSE depending on the path.
func newHTTPEcho(t *testing.T, sse bool) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Test") != "1" {
			t.Errorf("missing custom header X-Test")
		}
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		id := req["id"]
		method, _ := req["method"].(string)
		w.Header().Set("Mcp-Session-Id", "sess-1")
		writeJSON := func(result any) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
		}
		switch method {
		case "initialize":
			writeJSON(map[string]any{"protocolVersion": "2024-11-05"})
		case "tools/list":
			writeJSON(map[string]any{"tools": []map[string]any{{"name": "echo", "description": "Echo"}}})
		case "tools/call":
			result := map[string]any{"content": []map[string]any{{"type": "text", "text": "ok"}}}
			if sse {
				w.Header().Set("Content-Type", "text/event-stream")
				b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
				fmt.Fprintf(w, "event: message\ndata: %s\n\n", b)
			} else {
				writeJSON(result)
			}
		default: // notifications: 202
			w.WriteHeader(http.StatusAccepted)
		}
	}))
}

func TestHTTPTransport_JSON(t *testing.T) {
	srv := newHTTPEcho(t, false)
	defer srv.Close()
	c, err := DialHTTP(context.Background(), srv.URL, map[string]string{"X-Test": "1"})
	if err != nil {
		t.Fatalf("DialHTTP: %v", err)
	}
	defer c.Close()
	specs, err := c.ListTools(context.Background())
	if err != nil || len(specs) != 1 || specs[0].Name != "echo" {
		t.Fatalf("ListTools: %v %+v", err, specs)
	}
	out, err := c.Call(context.Background(), "echo", map[string]any{"x": 1})
	if err != nil || out != "ok" {
		t.Fatalf("Call: %v %v", out, err)
	}
}

func TestHTTPTransport_SSE(t *testing.T) {
	srv := newHTTPEcho(t, true)
	defer srv.Close()
	c, err := DialHTTP(context.Background(), srv.URL, map[string]string{"X-Test": "1"})
	if err != nil {
		t.Fatalf("DialHTTP: %v", err)
	}
	defer c.Close()
	out, err := c.Call(context.Background(), "echo", nil)
	if err != nil || out != "ok" {
		t.Fatalf("SSE Call: %v %v", out, err)
	}
}

func TestHTTPTransport_HTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusUnauthorized)
	}))
	defer srv.Close()
	_, err := DialHTTP(context.Background(), srv.URL, map[string]string{"X-Test": "1"})
	if err == nil {
		t.Fatal("expected initialize to fail on 401")
	}
}
```

- [ ] **Step 5: Run httpTransport tests** + full mcpclient package + race:

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/mcpclient/ -race -v`
Expected: ALL pass (old stdio tests + 3 new http tests). Then `/Users/smlee/sdk/go/bin/go vet ./engine/internal/adapters/mcpclient/`.

- [ ] **Step 6: Commit**

```bash
git add engine/internal/adapters/mcpclient/
git commit -m "feat(engine): mcpclient 전송 추상화 + Streamable HTTP 전송 (#36)"
```

---

## Task 2: 도메인 Transport/URL + 마이그 v11 + repo

**Files:**
- Modify: `engine/internal/domain/mcpserver.go`
- Modify: `engine/internal/domain/mcpserver_test.go`
- Modify: `engine/cmd/app-engine/main.go`
- Modify: `engine/internal/adapters/sqlite/sqlite_mcpserver_repository.go`
- Modify: `engine/internal/adapters/sqlite/sqlite_mcpserver_repository_test.go`

- [ ] **Step 1: 도메인 실패 테스트** — append to `mcpserver_test.go`:

```go
func TestMcpServerTransportKind(t *testing.T) {
	if (McpServer{}).TransportKind() != "stdio" {
		t.Error("empty Transport should default to stdio")
	}
	if (McpServer{Transport: "http"}).TransportKind() != "http" {
		t.Error("http should pass through")
	}
	if (McpServer{Transport: "  "}).TransportKind() != "stdio" {
		t.Error("blank should default to stdio")
	}
}
```

- [ ] **Step 2: Run FAIL** — `/Users/smlee/sdk/go/bin/go test ./engine/internal/domain/ -run TestMcpServerTransportKind` → FAIL.

- [ ] **Step 3: 도메인 구현** — in `mcpserver.go`, add two fields to the `McpServer` struct (after `Trusted bool`):

```go
	Transport string `json:"transport"` // "stdio" | "http" (blank = stdio)
	URL       string `json:"url"`       // endpoint for http transport
```

And add the method (after `ArgsList`):

```go
// TransportKind returns the transport, defaulting blank to "stdio".
func (s McpServer) TransportKind() string {
	if strings.TrimSpace(s.Transport) == "" {
		return "stdio"
	}
	return s.Transport
}
```

(`strings` is already imported.)

- [ ] **Step 4: Run PASS** — `/Users/smlee/sdk/go/bin/go test ./engine/internal/domain/ -run TestMcpServerTransportKind` → PASS.

- [ ] **Step 5: 마이그 v11** — in `engine/cmd/app-engine/main.go`, AFTER the `Version: 10` entry (`mcp-servers-v1`), add:

```go
		{
			Version: 11,
			Name:    "add_mcp_server_transport",
			SQL: `
				ALTER TABLE mcp_servers ADD COLUMN transport TEXT NOT NULL DEFAULT 'stdio';
				ALTER TABLE mcp_servers ADD COLUMN url TEXT NOT NULL DEFAULT '';
			`,
			Checksum: "mcp-servers-transport-v1",
		},
```

- [ ] **Step 6: repo — add columns to all queries** in `sqlite_mcpserver_repository.go`. Place `transport, url` after `trusted`, before `created_at`. FOUR edits:

Create INSERT:
```go
		INSERT INTO mcp_servers (id, workspace_id, name, command, args, enabled, trusted, transport, url, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, s.ID, s.WorkspaceID, s.Name, s.Command, s.Args, s.Enabled, s.Trusted, s.Transport, s.URL, s.CreatedAt, s.UpdatedAt)
```

List SELECT + Scan:
```go
		SELECT id, workspace_id, name, command, args, enabled, trusted, transport, url, created_at, updated_at
		FROM mcp_servers WHERE workspace_id = ? ORDER BY name
```
```go
		if err := rows.Scan(&s.ID, &s.WorkspaceID, &s.Name, &s.Command, &s.Args, &s.Enabled, &s.Trusted, &s.Transport, &s.URL, &s.CreatedAt, &s.UpdatedAt); err != nil {
```

Update SET:
```go
		UPDATE mcp_servers SET name = ?, command = ?, args = ?, enabled = ?, trusted = ?, transport = ?, url = ?, updated_at = ?
		WHERE id = ?
	`, s.Name, s.Command, s.Args, s.Enabled, s.Trusted, s.Transport, s.URL, s.UpdatedAt, s.ID)
```

- [ ] **Step 7: repo test — extend inline DDL + assert** in `sqlite_mcpserver_repository_test.go`. In the `newMcpRepo` helper's inline `CREATE TABLE mcp_servers`, add `transport TEXT NOT NULL DEFAULT 'stdio',` and `url TEXT NOT NULL DEFAULT '',` (after `trusted`). Extend the round-trip test: set `Transport: "http", URL: "https://x"` on the server, and after List assert `list[0].Transport == "http" && list[0].URL == "https://x"`.

- [ ] **Step 8: Run** — `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/ -run TestMcpServerRepo` → PASS. Then full package + build: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/ ./engine/internal/domain/ && /Users/smlee/sdk/go/bin/go build ./engine/...`.

- [ ] **Step 9: Commit**

```bash
git add engine/internal/domain/mcpserver.go engine/internal/domain/mcpserver_test.go engine/cmd/app-engine/main.go engine/internal/adapters/sqlite/
git commit -m "feat(engine): McpServer transport/url + 마이그레이션 v11 (#36)"
```

---

## Task 3: 핸들러 전송 분기 + 헤더 키체인 + 타임아웃

**Files:**
- Modify: `engine/internal/transport/http/mcpserver.go`
- Modify: `engine/internal/transport/http/agent.go`

정수 검증 없는 배선 작업 — 빌드/전체 테스트로 검증.

- [ ] **Step 1: Dial 분기 헬퍼 + headersFor** in `mcpserver.go`. Add near `envFor`:

```go
// headersFor retrieves stored auth headers for a server from the keychain.
func (h *McpServerHandler) headersFor(ctx context.Context, serverID string) map[string]string {
	out := map[string]string{}
	if blob, err := h.secrets.Get(ctx, "mcp_headers_"+serverID); err == nil && blob != "" {
		_ = json.Unmarshal([]byte(blob), &out)
	}
	return out
}

// dialServer opens a client for a stored server, branching on transport.
func (h *McpServerHandler) dialServer(ctx context.Context, s domain.McpServer) (*mcpclient.Client, error) {
	if s.TransportKind() == "http" {
		return mcpclient.DialHTTP(ctx, s.URL, h.headersFor(ctx, s.ID))
	}
	return mcpclient.DialStdio(ctx, s.Command, s.ArgsList(), h.envFor(ctx, s.ID))
}
```

(`domain` import may need adding to mcpserver.go — check; the DTO/body already reference domain types so it's likely present.)

- [ ] **Step 2: POST body — add transport/url/headers** in `Servers()` POST branch. Extend the body struct:
```go
			var body struct {
				ID        string             `json:"id"`
				Name      string             `json:"name"`
				Command   string             `json:"command"`
				Args      []string           `json:"args"`
				Enabled   bool               `json:"enabled"`
				Trusted   bool               `json:"trusted"`
				Transport string             `json:"transport"`
				URL       string             `json:"url"`
				Env       *map[string]string `json:"env"`
				Headers   *map[string]string `json:"headers"`
			}
```
Set `Transport: body.Transport, URL: body.URL` on the `domain.McpServer` built for Create/Update (alongside Command/Args). Store headers in keychain (present-only, mirror the env block):
```go
			if body.Headers != nil {
				b, _ := json.Marshal(*body.Headers)
				_ = h.secrets.Set(r.Context(), "mcp_headers_"+id, string(b))
			}
```
Also add `Transport`/`URL` to the GET DTO (`mcpServerDTO` struct + `toDTO`): add fields `Transport string json:"transport"`, `URL string json:"url"` and map `s.Transport`/`s.URL`.
DELETE: also delete `mcp_headers_<id>` alongside `mcp_env_<id>` (`_ = h.secrets.Delete(ctx, "mcp_headers_"+id)`).

- [ ] **Step 3: Test handler — transport branch + 15s timeout** in `Test()`. Extend body:
```go
		var body struct {
			Transport string            `json:"transport"`
			URL       string            `json:"url"`
			Command   string            `json:"command"`
			Args      []string          `json:"args"`
			Env       map[string]string `json:"env"`
			Headers   map[string]string `json:"headers"`
		}
```
Keep the existing 15s context (`ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second); defer cancel()`). Replace the `mcpclient.Dial(...)` call with a branch:
```go
		var client *mcpclient.Client
		var derr error
		if body.Transport == "http" {
			client, derr = mcpclient.DialHTTP(ctx, body.URL, body.Headers)
		} else {
			client, derr = mcpclient.DialStdio(ctx, body.Command, body.Args, body.Env)
		}
```
(rest unchanged: on derr → `{error}`, else ListTools → Close → `{tools}`.)

- [ ] **Step 4: Call handler — use dialServer, NO 15s cap** in `Call()`. Replace `mcpclient.Dial(ctx, found.Command, found.ArgsList(), env)` with `h.dialServer(r.Context(), *found)` (use the request context directly — do NOT wrap in a 15s timeout, since tool calls can be long). Remove the now-unused local `env := h.envFor(...)` line if present (dialServer handles it).

- [ ] **Step 5: /agent/run dial closure — branch** in `agent.go`. Replace the closure body (the `mcpclient.Dial(ctx, s.Command, s.ArgsList(), env)` section, ~line 326-336) with a transport branch:
```go
			dial := func(ctx context.Context, s domain.McpServer) (agent.McpCaller, error) {
				if s.TransportKind() == "http" {
					headers := map[string]string{}
					if blob, e := h.secrets.Get(ctx, "mcp_headers_"+s.ID); e == nil && blob != "" {
						_ = json.Unmarshal([]byte(blob), &headers)
					}
					c, err := mcpclient.DialHTTP(ctx, s.URL, headers)
					if err != nil {
						return nil, err
					}
					return c, nil
				}
				env := map[string]string{}
				if blob, e := h.secrets.Get(ctx, "mcp_env_"+s.ID); e == nil && blob != "" {
					_ = json.Unmarshal([]byte(blob), &env)
				}
				c, err := mcpclient.DialStdio(ctx, s.Command, s.ArgsList(), env)
				if err != nil {
					return nil, err
				}
				return c, nil
			}
```
(The agent-run ctx flows into DialHTTP/DialStdio → tool calls honor it; no artificial cap.)

- [ ] **Step 6: Build + full engine test + vet**

Run: `/Users/smlee/sdk/go/bin/go build ./engine/... && /Users/smlee/sdk/go/bin/go vet ./engine/... && /Users/smlee/sdk/go/bin/go test ./engine/...`
Expected: builds, vet clean, ALL tests pass (stdio servers + zero-server runs unchanged → no regression).

- [ ] **Step 7: Commit**

```bash
git add engine/internal/transport/http/mcpserver.go engine/internal/transport/http/agent.go
git commit -m "feat(engine): MCP 핸들러 전송 분기(http) + 헤더 키체인 + 타임아웃 정책 (#36)"
```

---

## Task 4: 렌더러 순수 로직 (parseHeaders + validate)

**Files:**
- Modify: `apps/renderer/src/lib/mcpServerForm.ts`
- Modify: `apps/renderer/src/lib/mcpServerForm.test.ts`

- [ ] **Step 1: 실패 테스트** — append to `mcpServerForm.test.ts` (and add `parseHeaders` to the import):

```ts
describe('parseHeaders', () => {
  it('parses Key: Value lines, skipping blanks/comments', () => {
    expect(parseHeaders('Authorization: Bearer abc\n\n# c\nX-Tenant: 7')).toEqual({
      Authorization: 'Bearer abc',
      'X-Tenant': '7',
    });
  });
  it('splits on the first colon only', () => {
    expect(parseHeaders('X-Url: https://a:b/c')).toEqual({ 'X-Url': 'https://a:b/c' });
  });
});

describe('validateServer http', () => {
  it('requires url when transport is http', () => {
    expect(validateServer({ name: 'x', command: '', transport: 'http', url: '' })).toMatch(/URL/);
    expect(validateServer({ name: 'x', command: '', transport: 'http', url: 'https://a' })).toBe('');
  });
  it('still requires command for stdio', () => {
    expect(validateServer({ name: 'x', command: '', transport: 'stdio', url: '' })).toMatch(/명령/);
  });
});
```

- [ ] **Step 2: Run FAIL** — `cd /Users/smlee/projects/product/database && pnpm --filter renderer test mcpServerForm` → FAIL.

- [ ] **Step 3: 구현** — in `mcpServerForm.ts`, add `parseHeaders` (mirror `parseEnv` but split on `:`):

```ts
export function parseHeaders(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const c = t.indexOf(':');
    if (c <= 0) continue;
    out[t.slice(0, c).trim()] = t.slice(c + 1).trim();
  }
  return out;
}
```

And change `validateServer` to accept transport/url and validate accordingly:

```ts
export function validateServer(s: { name: string; command: string; transport?: string; url?: string }): string {
  if (!s.name.trim()) return '서버 이름을 입력하세요.';
  if (s.transport === 'http') {
    if (!(s.url ?? '').trim()) return 'URL을 입력하세요.';
    return '';
  }
  if (!s.command.trim()) return '실행 명령을 입력하세요.';
  return '';
}
```

- [ ] **Step 4: Run PASS** — `pnpm --filter renderer test mcpServerForm` → all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/renderer/src/lib/mcpServerForm.ts apps/renderer/src/lib/mcpServerForm.test.ts
git commit -m "feat(renderer): MCP 헤더 파싱 + http url 검증 (#36)"
```

---

## Task 5: 패널 전송 선택 + URL/헤더 + 타입

**Files:**
- Modify: `apps/renderer/src/global.d.ts`
- Modify: `apps/renderer/src/components/McpServersPanel.tsx`

- [ ] **Step 1: 타입 확장** in `global.d.ts`:
- `McpServer` interface: add `transport: string;` and `url: string;`.
- `McpServerInput` interface: add `transport?: string;`, `url?: string;`, `headers?: Record<string, string>;` and make `command?`/`args?`/`env?` optional (http servers omit them).
- `mcpServersTest` payload type: change to `(payload: { transport?: string; url?: string; command?: string; args?: string[]; env?: Record<string,string>; headers?: Record<string,string> })`.

- [ ] **Step 2: 패널 — 전송 선택 + 조건부 필드** in `McpServersPanel.tsx`:
- Add state: `const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');`, `const [url, setUrl] = useState('');`, `const [headersText, setHeadersText] = useState('');`. Import `parseHeaders` from `../lib/mcpServerForm`.
- In the add form, add a transport `<select>` (stdio/http) bound to `transport`/`setTransport` as the first field.
- Conditionally render: when `transport === 'http'` show URL `<input>` (bound url) + headers `<textarea>` (bound headersText, placeholder `Authorization: Bearer ...`); when `stdio` show the existing command/args/env fields.
- `runTest()`: build payload by transport — `transport==='http' ? { transport:'http', url, headers: parseHeaders(headersText) } : { transport:'stdio', command, args: parseArgs(argsText), env: parseEnv(envText) }`.
- `add()`: `validateServer({ name, command, transport, url })`; on ok call `mcpServersSave` with transport-specific payload:
  - http: `{ name, transport:'http', url, enabled:true, trusted, headers: parseHeaders(headersText) }`
  - stdio: `{ name, transport:'stdio', command, args: parseArgs(argsText), enabled:true, trusted, env: parseEnv(envText) }`
- `toggle()`: include `transport: server.transport, url: server.url` (omit env/headers — preserved server-side) so a toggle doesn't blank the transport/url. (server.transport/url come from the list DTO.)
- List row: add a transport badge showing `s.transport || 'stdio'`; for http show `s.url` instead of the command line.
- Reset the new fields in the post-add clear.

- [ ] **Step 3: Verify** — `cd /Users/smlee/projects/product/database && pnpm --filter renderer build 2>&1 | tail -4 && pnpm --filter renderer lint 2>&1 | tail -4 && pnpm --filter renderer test 2>&1 | tail -4`. All clean/pass. Fix any `no-explicit-any`/type issues.

- [ ] **Step 4: Commit**

```bash
git add apps/renderer/src/global.d.ts apps/renderer/src/components/McpServersPanel.tsx
git commit -m "feat(renderer): MCP 패널 http 전송(URL/헤더) 지원 (#36)"
```

---

## Task 6: 전체 검증 (빌드/테스트 + CDP 라이브)

**Files:**
- Throwaway: `apps/desktop/e2e/mcp-http.verify.spec.ts` + `apps/desktop/e2e/fixtures/echo-http-mcp-server.mjs` (커밋하지 않음)

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

- [ ] **Step 2: CDP 라이브** — write a throwaway Node Streamable HTTP MCP server fixture (`echo-http-mcp-server.mjs`: an `http.createServer` listening on a fixed port, e.g. 39999, that reads a JSON-RPC POST body and replies with `application/json` — initialize → `{protocolVersion}` + `Mcp-Session-Id` header; tools/list → one `echo` tool; tools/call → `{content:[{type:text,text:'echo:'+args.text}]}`; notifications → 202). Then a Playwright spec (reuse `e2e/fixtures.ts`): start the node server (child_process.spawn) before the app; connect mysql; open the connection edit → MCP tab; in the add form select transport=http, fill URL `http://127.0.0.1:39999`, add header line, trusted on; "연결 테스트" → assert `echo` tool shown; "추가"; then open Agent and ask to use echo with 'hi' → assert `mcp__echo__echo` called + `echo:hi`. Screenshot `docs/verify-mcp-http.png`. Stop the node server in afterAll.

- [ ] **Step 3: 결과 확인 + 정리** — view screenshot → delete throwaway spec + fixture + png. Confirm no leftover.

- [ ] **Step 4: Commit (검증 자체 코드 변경 없으면 스킵)**

---

## Self-Review (작성자 체크)

**스펙 커버리지**
- Streamable HTTP 전송(POST→JSON/SSE, Mcp-Session-Id) → Task 1(httpTransport) ✅
- 전송 추상화(stdio 보존) → Task 1(transport 인터페이스, 기존 테스트 무수정) ✅
- McpServer transport/url + 마이그v11 → Task 2 ✅
- 헤더 키체인(mcp_headers_<id>, present-only) → Task 3 ✅
- 핸들러 전송 분기(3곳) + 타임아웃(test=15s, call=ctx) → Task 3 ✅
- 렌더러 parseHeaders + http url 검증 → Task 4 ✅
- 패널 전송 선택/URL/헤더 + 타입 → Task 5 ✅
- 라이브 검증(http echo 서버) → Task 6 ✅
- OAuth/레거시 SSE → 범위 외 ✅

**플레이스홀더 스캔:** Task 3/5는 순수 코드가 아니라 정확한 라우트/시그니처/필드 제공 + 기존 패턴 참조. Task 6 throwaway는 fixture 재사용 명시. 없음.

**타입 일관성:** `transport` 인터페이스(`request(ctx,method,params)`/`notify(ctx,method,params)`/`Close`) Task1 정의·사용 일치. `DialStdio`/`DialHTTP`(공개) Task1 정의·Task3 호출 일치. `McpServer.Transport/URL`+`TransportKind()` Task2 정의·Task3 사용 일치. 키체인 키 `mcp_headers_<id>` Task3 일관. 렌더러 `parseHeaders`/`validateServer({name,command,transport?,url?})` Task4 정의·Task5 사용 일치. `McpServerInput`에 transport/url/headers + command/args/env 옵셔널 Task5.
