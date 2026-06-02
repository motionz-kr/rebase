# Agent P1 — Engine Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the network-free core of Agent Mode — the `LLMProvider` port, a read-only DB tool registry, a dangerous-statement classifier, and the `AgentService` loop — all driven by a fake provider so the whole architecture is unit/integration tested before any real LLM or UI is wired.

**Architecture:** A new `engine/internal/agent` package holds the loop, tool registry, and safety classifier. The `LLMProvider` port lives in `ports` (mirroring `SQLConnector`/`RedisConnector`). Tools wrap the existing `ports.SQLConnector`. The loop calls a provider, dispatches tool calls against the current connection, feeds results back, and stops on done / max-steps / cancel. A `fakeProvider` in tests scripts provider behaviour so the loop is fully deterministic.

**Tech Stack:** Go 1.25 (stdlib `testing`, `regexp`, `encoding/json`). No new dependencies. Module `github.com/smlee/database-local-engine`.

**Spec:** `docs/superpowers/specs/2026-06-02-llm-agent-mode-design.md` · **ADR:** `docs/adr/0006-llm-agent-cli-driving.md` · **Issues:** #12 (loop), #13 (tools), #14 (classifier).

---

## File Structure

- Create `engine/internal/ports/llm.go` — `LLMProvider` interface + neutral types (messages, tool specs, tool calls, streaming events, provider status).
- Create `engine/internal/agent/danger.go` — pure `ClassifyStatement(sql)` dangerous-op classifier.
- Create `engine/internal/agent/danger_test.go` — classifier tests.
- Create `engine/internal/agent/tools.go` — `Tool` interface, `Registry`, and read tools (`list_tables`, `describe_table`) over `ports.SQLConnector`.
- Create `engine/internal/agent/tools_test.go` — registry/tool tests with a fake connector.
- Create `engine/internal/agent/service.go` — `AgentService` loop (provider + registry + max-steps + cancel).
- Create `engine/internal/agent/service_test.go` — loop tests with a fake provider.

No existing files are modified in this slice (transport/IPC wiring is a later slice), keeping it isolated and safe.

---

## Task 1: Dangerous-statement classifier (pure, TDD)

**Files:**
- Create: `engine/internal/agent/danger.go`
- Test: `engine/internal/agent/danger_test.go`

- [ ] **Step 1: Write the failing test**

```go
package agent

import "testing"

func TestClassifyStatement(t *testing.T) {
	cases := []struct {
		name string
		sql  string
		want Risk
	}{
		{"plain select", "SELECT * FROM users WHERE id = 1", RiskSafe},
		{"insert", "INSERT INTO users (id) VALUES (1)", RiskSafe},
		{"update with where", "UPDATE users SET name='a' WHERE id=1", RiskSafe},
		{"update no where", "UPDATE users SET name='a'", RiskDangerous},
		{"delete no where", "DELETE FROM users", RiskDangerous},
		{"delete with where", "DELETE FROM users WHERE id=1", RiskSafe},
		{"drop table", "DROP TABLE users", RiskDangerous},
		{"truncate", "TRUNCATE TABLE users", RiskDangerous},
		{"alter drop col", "ALTER TABLE users DROP COLUMN x", RiskDangerous},
		{"where only inside string is not a real where", "DELETE FROM logs -- WHERE keep", RiskDangerous},
		{"lowercase drop", "drop table users", RiskDangerous},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ClassifyStatement(c.sql)
			if got.Risk != c.want {
				t.Fatalf("ClassifyStatement(%q).Risk = %q, want %q (reasons=%v)", c.sql, got.Risk, c.want, got.Reasons)
			}
			if c.want == RiskDangerous && len(got.Reasons) == 0 {
				t.Errorf("dangerous result should explain why")
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/agent/ -run TestClassifyStatement`
Expected: build failure — `undefined: ClassifyStatement`, `Risk`, `RiskSafe`, `RiskDangerous`.

- [ ] **Step 3: Write minimal implementation**

```go
package agent

import (
	"regexp"
	"strings"
)

type Risk string

const (
	RiskSafe      Risk = "safe"
	RiskDangerous Risk = "dangerous"
)

// Classification is the result of inspecting a single SQL statement.
type Classification struct {
	Risk    Risk     `json:"risk"`
	Reasons []string `json:"reasons"`
}

var (
	reLineComment  = regexp.MustCompile(`--[^\n]*`)
	reBlockComment = regexp.MustCompile(`(?s)/\*.*?\*/`)
	reString       = regexp.MustCompile(`'(?:[^']|'')*'`)
	reWhitespace   = regexp.MustCompile(`\s+`)
	reWhere        = regexp.MustCompile(`(?i)\bWHERE\b`)
)

// normalize strips comments and string literals, then collapses whitespace so
// keyword checks can't be fooled by text inside strings/comments.
func normalize(sql string) string {
	s := reLineComment.ReplaceAllString(sql, " ")
	s = reBlockComment.ReplaceAllString(s, " ")
	s = reString.ReplaceAllString(s, "''")
	s = reWhitespace.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

// ClassifyStatement flags statements that drop/wipe data or mutate without a
// WHERE clause. It is intentionally conservative: anything matching is dangerous.
func ClassifyStatement(sql string) Classification {
	n := normalize(sql)
	upper := strings.ToUpper(n)
	var reasons []string

	switch {
	case strings.HasPrefix(upper, "DROP "):
		reasons = append(reasons, "DROP removes a database object")
	case strings.HasPrefix(upper, "TRUNCATE"):
		reasons = append(reasons, "TRUNCATE empties a table")
	case strings.HasPrefix(upper, "DELETE") && !reWhere.MatchString(n):
		reasons = append(reasons, "DELETE without a WHERE clause affects every row")
	case strings.HasPrefix(upper, "UPDATE") && !reWhere.MatchString(n):
		reasons = append(reasons, "UPDATE without a WHERE clause affects every row")
	}
	if strings.HasPrefix(upper, "ALTER") && strings.Contains(upper, " DROP ") {
		reasons = append(reasons, "ALTER ... DROP removes a column/constraint")
	}

	if len(reasons) > 0 {
		return Classification{Risk: RiskDangerous, Reasons: reasons}
	}
	return Classification{Risk: RiskSafe}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/agent/ -run TestClassifyStatement -v`
Expected: PASS (all sub-tests).

- [ ] **Step 5: Commit**

```bash
git add engine/internal/agent/danger.go engine/internal/agent/danger_test.go
git commit -m "feat(agent): dangerous-statement classifier (TDD)"
```

---

## Task 2: `LLMProvider` port + neutral types

**Files:**
- Create: `engine/internal/ports/llm.go`

This is interface/type-only; it is exercised by Tasks 3–4. No standalone test.

- [ ] **Step 1: Write the types**

```go
package ports

import "context"

type LLMRole string

const (
	RoleUser      LLMRole = "user"
	RoleAssistant LLMRole = "assistant"
	RoleTool      LLMRole = "tool"
)

// LLMMessage is one turn in the conversation. For RoleTool, ToolCallID/ToolName
// identify which tool call this is the result of, and Text holds the result JSON.
type LLMMessage struct {
	Role       LLMRole `json:"role"`
	Text       string  `json:"text"`
	ToolCallID string  `json:"toolCallId,omitempty"`
	ToolName   string  `json:"toolName,omitempty"`
}

// ToolSpec is the schema advertised to the model.
type ToolSpec struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Schema      map[string]any `json:"schema"` // JSON Schema for the parameters object
}

// ToolCall is a model request to run a tool.
type ToolCall struct {
	ID   string         `json:"id"`
	Name string         `json:"name"`
	Args map[string]any `json:"args"`
}

type LLMRequest struct {
	System   string       `json:"system"`
	Messages []LLMMessage `json:"messages"`
	Tools    []ToolSpec   `json:"tools"`
	Model    string       `json:"model"`
}

type LLMEventKind string

const (
	EventText     LLMEventKind = "text"      // incremental assistant text
	EventToolCall LLMEventKind = "tool_call" // model wants to run a tool
	EventDone     LLMEventKind = "done"      // turn complete
	EventError    LLMEventKind = "error"
)

type LLMEvent struct {
	Kind     LLMEventKind `json:"kind"`
	Text     string       `json:"text,omitempty"`
	ToolCall *ToolCall    `json:"toolCall,omitempty"`
	Err      string       `json:"err,omitempty"`
}

type ProviderStatus struct {
	Ready  bool   `json:"ready"`
	Detail string `json:"detail"`
}

// LLMProvider streams a completion. Implementations translate LLMRequest to/from
// their wire format and call emit for each event. Returning an error means a
// transport-level failure (an in-band model error is emitted as EventError).
type LLMProvider interface {
	Complete(ctx context.Context, req LLMRequest, emit func(LLMEvent)) error
	Status(ctx context.Context) (ProviderStatus, error)
}
```

- [ ] **Step 2: Verify it compiles**

Run: `/Users/smlee/sdk/go/bin/go build ./engine/internal/ports/`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add engine/internal/ports/llm.go
git commit -m "feat(agent): LLMProvider port + neutral request/event types"
```

---

## Task 3: Tool registry + read tools (TDD with a fake connector)

**Files:**
- Create: `engine/internal/agent/tools.go`
- Test: `engine/internal/agent/tools_test.go`

Tools wrap `ports.SQLConnector`. The registry exposes `Specs()` (for the model)
and `Dispatch(name, args)` (run a tool, return JSON-serialisable result).

- [ ] **Step 1: Write the failing test**

```go
package agent

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// fakeSQL implements just the SQLConnector methods the read tools use.
type fakeSQL struct {
	tables  []ports.TableInfo
	columns []ports.ColumnInfo
}

func (f *fakeSQL) ListTables(_ context.Context, _ domain.ConnectionProfile, _ string, _ string) ([]ports.TableInfo, error) {
	return f.tables, nil
}
func (f *fakeSQL) DescribeTable(_ context.Context, _ domain.ConnectionProfile, _ string, _ string, _ string) (ports.TableDescription, error) {
	return ports.TableDescription{Columns: f.columns}, nil
}

func TestRegistryDispatchListTables(t *testing.T) {
	conn := &fakeSQL{tables: []ports.TableInfo{{Name: "users"}, {Name: "orders"}}}
	reg := NewSQLRegistry(conn, domain.ConnectionProfile{}, "", "devdb")

	// Specs are advertised to the model.
	if len(reg.Specs()) == 0 {
		t.Fatal("registry should advertise tool specs")
	}

	out, err := reg.Dispatch(context.Background(), "list_tables", map[string]any{})
	if err != nil {
		t.Fatalf("dispatch list_tables: %v", err)
	}
	b, _ := json.Marshal(out)
	if got := string(b); got != `["users","orders"]` {
		t.Fatalf("list_tables = %s, want [\"users\",\"orders\"]", got)
	}
}

func TestRegistryUnknownTool(t *testing.T) {
	reg := NewSQLRegistry(&fakeSQL{}, domain.ConnectionProfile{}, "", "devdb")
	if _, err := reg.Dispatch(context.Background(), "nope", nil); err == nil {
		t.Fatal("expected error for unknown tool")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/agent/ -run TestRegistry`
Expected: build failure — `NewSQLRegistry` undefined.

- [ ] **Step 3: Write minimal implementation**

```go
package agent

import (
	"context"
	"fmt"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// sqlReader is the subset of ports.SQLConnector the read tools need (kept small
// so tests can fake it without implementing the full connector).
type sqlReader interface {
	ListTables(ctx context.Context, p domain.ConnectionProfile, password, database string) ([]ports.TableInfo, error)
	DescribeTable(ctx context.Context, p domain.ConnectionProfile, password, database, table string) (ports.TableDescription, error)
}

type Tool struct {
	Spec ports.ToolSpec
	Run  func(ctx context.Context, args map[string]any) (any, error)
}

type Registry struct {
	tools map[string]Tool
	order []string
}

func (r *Registry) Specs() []ports.ToolSpec {
	specs := make([]ports.ToolSpec, 0, len(r.order))
	for _, name := range r.order {
		specs = append(specs, r.tools[name].Spec)
	}
	return specs
}

func (r *Registry) Dispatch(ctx context.Context, name string, args map[string]any) (any, error) {
	t, ok := r.tools[name]
	if !ok {
		return nil, fmt.Errorf("unknown tool %q", name)
	}
	return t.Run(ctx, args)
}

func (r *Registry) add(t Tool) {
	r.tools[t.Spec.Name] = t
	r.order = append(r.order, t.Spec.Name)
}

func strArg(args map[string]any, key string) string {
	if v, ok := args[key].(string); ok {
		return v
	}
	return ""
}

// NewSQLRegistry builds the read-only tool set bound to one connection profile.
func NewSQLRegistry(conn sqlReader, p domain.ConnectionProfile, password, database string) *Registry {
	r := &Registry{tools: map[string]Tool{}}

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "list_tables",
			Description: "List table names in the current database.",
			Schema:      map[string]any{"type": "object", "properties": map[string]any{}},
		},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			tables, err := conn.ListTables(ctx, p, password, database)
			if err != nil {
				return nil, err
			}
			names := make([]string, len(tables))
			for i, t := range tables {
				names[i] = t.Name
			}
			return names, nil
		},
	})

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "describe_table",
			Description: "Return the columns (name, type, nullable, primaryKey) of a table.",
			Schema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"table": map[string]any{"type": "string"}},
				"required":   []string{"table"},
			},
		},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			desc, err := conn.DescribeTable(ctx, p, password, database, strArg(args, "table"))
			if err != nil {
				return nil, err
			}
			return desc.Columns, nil
		},
	})

	return r
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/agent/ -run TestRegistry -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/internal/agent/tools.go engine/internal/agent/tools_test.go
git commit -m "feat(agent): read-tool registry over SQLConnector (TDD)"
```

---

## Task 4: `AgentService` loop (TDD with a fake provider)

**Files:**
- Create: `engine/internal/agent/service.go`
- Test: `engine/internal/agent/service_test.go`

The loop: call the provider with the conversation + tool specs; on `EventToolCall`
dispatch via the registry and append a `RoleTool` result message; repeat until
`EventDone` or `maxSteps`. All assistant text + tool events are forwarded to the
caller's `emit`. A `fakeProvider` scripts a tool call then a final answer.

- [ ] **Step 1: Write the failing test**

```go
package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// fakeProvider emits scripted turns: turn 0 asks for list_tables, turn 1 answers.
type fakeProvider struct{ turn int }

func (f *fakeProvider) Status(context.Context) (ports.ProviderStatus, error) {
	return ports.ProviderStatus{Ready: true}, nil
}
func (f *fakeProvider) Complete(_ context.Context, req ports.LLMRequest, emit func(ports.LLMEvent)) error {
	if f.turn == 0 {
		f.turn++
		emit(ports.LLMEvent{Kind: ports.EventToolCall, ToolCall: &ports.ToolCall{ID: "c1", Name: "list_tables", Args: map[string]any{}}})
		emit(ports.LLMEvent{Kind: ports.EventDone})
		return nil
	}
	// Second turn should now see the tool result in the conversation.
	last := req.Messages[len(req.Messages)-1]
	if last.Role != ports.RoleTool || !strings.Contains(last.Text, "users") {
		emit(ports.LLMEvent{Kind: ports.EventError, Err: "tool result not fed back"})
		emit(ports.LLMEvent{Kind: ports.EventDone})
		return nil
	}
	emit(ports.LLMEvent{Kind: ports.EventText, Text: "There are 2 tables."})
	emit(ports.LLMEvent{Kind: ports.EventDone})
	return nil
}

func TestServiceRunsToolThenAnswers(t *testing.T) {
	reg := NewSQLRegistry(&fakeSQL{tables: []ports.TableInfo{{Name: "users"}, {Name: "orders"}}},
		domainProfile(), "", "devdb")
	svc := NewAgentService(&fakeProvider{}, reg, 8)

	var text strings.Builder
	var toolCalls int
	err := svc.Run(context.Background(), []ports.LLMMessage{{Role: ports.RoleUser, Text: "how many tables?"}},
		func(e ports.LLMEvent) {
			switch e.Kind {
			case ports.EventText:
				text.WriteString(e.Text)
			case ports.EventToolCall:
				toolCalls++
			}
		})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if toolCalls != 1 {
		t.Errorf("expected 1 tool call, got %d", toolCalls)
	}
	if !strings.Contains(text.String(), "2 tables") {
		t.Errorf("final answer = %q, want it to mention '2 tables'", text.String())
	}
}

func TestServiceMaxSteps(t *testing.T) {
	// A provider that always asks for a tool would loop forever; maxSteps caps it.
	reg := NewSQLRegistry(&fakeSQL{}, domainProfile(), "", "devdb")
	svc := NewAgentService(&loopingProvider{}, reg, 3)
	steps := 0
	err := svc.Run(context.Background(), []ports.LLMMessage{{Role: ports.RoleUser, Text: "x"}},
		func(e ports.LLMEvent) {
			if e.Kind == ports.EventToolCall {
				steps++
			}
		})
	if err == nil {
		t.Fatal("expected a max-steps error")
	}
	if steps > 3 {
		t.Errorf("ran %d steps, should stop at maxSteps=3", steps)
	}
}

type loopingProvider struct{}

func (loopingProvider) Status(context.Context) (ports.ProviderStatus, error) {
	return ports.ProviderStatus{Ready: true}, nil
}
func (loopingProvider) Complete(_ context.Context, _ ports.LLMRequest, emit func(ports.LLMEvent)) error {
	emit(ports.LLMEvent{Kind: ports.EventToolCall, ToolCall: &ports.ToolCall{ID: "x", Name: "list_tables"}})
	emit(ports.LLMEvent{Kind: ports.EventDone})
	return nil
}
```

Add this helper at the bottom of `tools_test.go` (used by both test files):

```go
func domainProfile() domain.ConnectionProfile { return domain.ConnectionProfile{} }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/agent/ -run TestService`
Expected: build failure — `NewAgentService` undefined.

- [ ] **Step 3: Write minimal implementation**

```go
package agent

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type AgentService struct {
	provider ports.LLMProvider
	registry *Registry
	maxSteps int
	system   string
}

func NewAgentService(p ports.LLMProvider, reg *Registry, maxSteps int) *AgentService {
	if maxSteps <= 0 {
		maxSteps = 16
	}
	return &AgentService{provider: p, registry: reg, maxSteps: maxSteps,
		system: "You are a database assistant. Use the provided tools to inspect the schema and answer precisely."}
}

// Run drives the agent loop, forwarding text + tool events to emit. It returns
// an error if the loop exceeds maxSteps or the provider/tool dispatch fails
// fatally.
func (s *AgentService) Run(ctx context.Context, conversation []ports.LLMMessage, emit func(ports.LLMEvent)) error {
	messages := append([]ports.LLMMessage(nil), conversation...)
	specs := s.registry.Specs()

	for step := 0; step < s.maxSteps; step++ {
		if err := ctx.Err(); err != nil {
			return err
		}

		var pending *ports.ToolCall
		req := ports.LLMRequest{System: s.system, Messages: messages, Tools: specs}
		err := s.provider.Complete(ctx, req, func(e ports.LLMEvent) {
			if e.Kind == ports.EventToolCall && e.ToolCall != nil {
				pending = e.ToolCall // dispatch after the turn completes
			}
			emit(e)
		})
		if err != nil {
			return err
		}

		if pending == nil {
			return nil // model produced a final answer
		}

		result, derr := s.registry.Dispatch(ctx, pending.Name, pending.Args)
		var payload string
		if derr != nil {
			payload = fmt.Sprintf(`{"error":%q}`, derr.Error())
		} else {
			b, _ := json.Marshal(result)
			payload = string(b)
		}
		messages = append(messages,
			ports.LLMMessage{Role: ports.RoleAssistant, ToolName: pending.Name, ToolCallID: pending.ID},
			ports.LLMMessage{Role: ports.RoleTool, ToolCallID: pending.ID, ToolName: pending.Name, Text: payload},
		)
	}
	return fmt.Errorf("agent exceeded max steps (%d)", s.maxSteps)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/agent/ -v`
Expected: PASS (classifier + registry + service).

- [ ] **Step 5: Commit**

```bash
git add engine/internal/agent/service.go engine/internal/agent/service_test.go
git commit -m "feat(agent): AgentService loop with tool dispatch + max-steps (TDD)"
```

---

## Task 5: Verify the whole package + vet

- [ ] **Step 1: Full package test + vet + build**

Run:
```bash
/Users/smlee/sdk/go/bin/go test ./engine/internal/agent/ -v
/Users/smlee/sdk/go/bin/go vet ./...
/Users/smlee/sdk/go/bin/go build ./...
```
Expected: all green.

- [ ] **Step 2: Commit (if any cleanup was needed)**

```bash
git add -A && git commit -m "chore(agent): tidy engine foundation slice"
```

---

## Out of scope (next slices)

- **P1b:** `DirectApiAdapter` (Anthropic streaming + tool-calling translation) behind `LLMProvider`; integration-tested. Confirm Go SDK / HTTP streaming specifics during implementation.
- **P1c:** transport endpoint + IPC (`agent-run` streaming channel) wiring the loop to the renderer.
- **P1d:** renderer chat panel + API-key settings; live CDP verification.
- **P3:** wire `ClassifyStatement` into the write-tool gate (this slice only builds the classifier).

## Self-Review

- **Spec coverage:** loop (#12), tools (#13 read subset), classifier (toward #14) — covered. Provider port defined for P1b.
- **Placeholders:** none — every step has runnable code/commands.
- **Type consistency:** `ports.LLMProvider`/`LLMEvent`/`ToolCall`/`ToolSpec`, `agent.Registry.Specs()/Dispatch()`, `NewSQLRegistry`, `NewAgentService` used consistently across tasks. `fakeSQL`/`domainProfile()` shared between test files in the same package.
