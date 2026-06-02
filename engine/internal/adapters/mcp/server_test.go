package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/agent"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// fakeSQL satisfies the (unexported) sqlReader the registry needs.
type fakeSQL struct{}

func (fakeSQL) ListTables(context.Context, domain.ConnectionProfile, string, string) ([]ports.TableInfo, error) {
	return []ports.TableInfo{{Name: "users"}, {Name: "orders"}}, nil
}
func (fakeSQL) DescribeTable(context.Context, domain.ConnectionProfile, string, string, string) (ports.TableDescription, error) {
	return ports.TableDescription{Columns: []ports.ColumnInfo{{Name: "id"}}}, nil
}
func (fakeSQL) GetTableDDL(context.Context, domain.ConnectionProfile, string, string, string) (string, error) {
	return "CREATE TABLE users (id INT)", nil
}
func (fakeSQL) ListIndexes(context.Context, domain.ConnectionProfile, string, string, string) ([]ports.Index, error) {
	return nil, nil
}
func (fakeSQL) ListForeignKeys(context.Context, domain.ConnectionProfile, string, string, string) ([]ports.ForeignKey, error) {
	return nil, nil
}
func (fakeSQL) ExecuteQueryStream(_ context.Context, _ domain.ConnectionProfile, _ string, _ string, _ bool, onStart func(int64), onHeader func([]string) error, onRow func([]any) error) (int64, error) {
	return 0, nil
}

func newServer() *Server {
	reg := agent.NewSQLRegistry(fakeSQL{}, domain.ConnectionProfile{}, "", "devdb")
	return NewServer(reg)
}

func req(t *testing.T, s *Server, body string) map[string]any {
	t.Helper()
	resp := s.Handle(context.Background(), []byte(body))
	if resp == nil {
		return nil
	}
	b, _ := json.Marshal(resp)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}

func TestInitializeHandshake(t *testing.T) {
	m := req(t, newServer(), `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	result, _ := m["result"].(map[string]any)
	if result == nil || result["protocolVersion"] != protocolVersion {
		t.Fatalf("initialize result wrong: %v", m)
	}
	caps, _ := result["capabilities"].(map[string]any)
	if _, ok := caps["tools"]; !ok {
		t.Errorf("should advertise tools capability: %v", result)
	}
}

func TestNotificationHasNoReply(t *testing.T) {
	if resp := newServer().Handle(context.Background(), []byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)); resp != nil {
		t.Errorf("notification should produce no response, got %+v", resp)
	}
}

func TestToolsListIncludesRegistryTools(t *testing.T) {
	m := req(t, newServer(), `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	b, _ := json.Marshal(m["result"])
	s := string(b)
	for _, want := range []string{"list_tables", "describe_table", "run_select", "propose_write", "inputSchema"} {
		if !strings.Contains(s, want) {
			t.Errorf("tools/list missing %q: %s", want, s)
		}
	}
}

func TestToolsCallDispatches(t *testing.T) {
	m := req(t, newServer(), `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_tables","arguments":{}}}`)
	result, _ := m["result"].(map[string]any)
	content, _ := result["content"].([]any)
	if len(content) == 0 {
		t.Fatalf("tools/call returned no content: %v", m)
	}
	first, _ := content[0].(map[string]any)
	if text, _ := first["text"].(string); !strings.Contains(text, "users") {
		t.Errorf("list_tables via MCP should return users: %v", result)
	}
}

func TestToolsCallUnknownIsError(t *testing.T) {
	m := req(t, newServer(), `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"nope","arguments":{}}}`)
	result, _ := m["result"].(map[string]any)
	if result["isError"] != true {
		t.Errorf("unknown tool should set isError: %v", m)
	}
}

func TestUnknownMethod(t *testing.T) {
	m := req(t, newServer(), `{"jsonrpc":"2.0","id":5,"method":"bogus"}`)
	if m["error"] == nil {
		t.Errorf("unknown method should return an error: %v", m)
	}
}
