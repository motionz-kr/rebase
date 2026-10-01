package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func TestMultiProfileRegistryListsConnectionsAndRoutesWithProfileScope(t *testing.T) {
	first := NewSQLRegistry(&fakeSQL{}, domain.ConnectionProfile{
		ID: "profile-a", Driver: "mysql", McpAllowedTables: `["only_a"]`,
	}, "", "db_a")
	second := NewSQLRegistry(&fakeSQL{}, domain.ConnectionProfile{
		ID: "profile-b", Driver: "postgres", McpAllowedTables: `["shared_table"]`,
	}, "", "db_b")
	registry := NewMultiProfileRegistry([]MCPConnectionTarget{
		{ID: "profile-a", Name: "Production", Driver: "mysql", Database: "db_a", Registry: first},
		{ID: "profile-b", Name: "Analytics", Driver: "postgres", Database: "db_b", Registry: second},
	})

	connections, err := registry.Dispatch(context.Background(), "list_connections", map[string]any{})
	if err != nil {
		t.Fatalf("list_connections: %v", err)
	}
	listed, ok := connections.([]map[string]any)
	if !ok || len(listed) != 2 {
		t.Fatalf("connections = %#v, want two connection entries", connections)
	}
	if listed[0]["connectionId"] != "profile-a" || listed[0]["name"] != "Production" || listed[1]["database"] != "db_b" {
		t.Fatalf("unexpected connection listing: %#v", listed)
	}

	if _, err := registry.Dispatch(context.Background(), "run_select", map[string]any{
		"connectionId": "profile-a", "sql": "SELECT * FROM shared_table",
	}); err == nil || !strings.Contains(err.Error(), "MCP table access denied") {
		t.Fatalf("profile-a should enforce its table scope, error = %v", err)
	}

	if _, err := registry.Dispatch(context.Background(), "run_select", map[string]any{
		"connectionId": "profile-b", "sql": "SELECT * FROM shared_table",
	}); err != nil {
		t.Fatalf("profile-b should apply its own scope and allow shared_table: %v", err)
	}
}

func TestMultiProfileRegistryAddsRequiredConnectionIDAndUnionsPolicyTools(t *testing.T) {
	readOnly := NewSQLRegistry(&fakeSQL{}, domain.ConnectionProfile{ID: "read-only", Driver: "mysql"}, "", "one")
	fullAccess := NewSQLRegistryWithMCPWrites(&fakeSQL{}, domain.ConnectionProfile{ID: "writable", Driver: "mysql"}, "", "two", MCPWriteConfig{
		Mode: domain.MCPWriteModeFullAccess,
	})
	registry := NewMultiProfileRegistry([]MCPConnectionTarget{
		{ID: "read-only", Name: "Read only", Driver: "mysql", Database: "one", Registry: readOnly},
		{ID: "writable", Name: "Writable", Driver: "mysql", Database: "two", Registry: fullAccess},
	})

	var runSelect, executeWrite, listConnections bool
	for _, spec := range registry.Specs() {
		switch spec.Name {
		case "run_select":
			runSelect = true
			properties, _ := spec.Schema["properties"].(map[string]any)
			if _, ok := properties["connectionId"]; !ok {
				t.Fatal("run_select input schema must include connectionId")
			}
			required, _ := spec.Schema["required"].([]string)
			if !contains(required, "connectionId") || !contains(required, "sql") {
				t.Fatalf("run_select required = %#v, want connectionId and sql", required)
			}
		case "execute_write":
			executeWrite = true
		case "list_connections":
			listConnections = true
		}
	}
	if !runSelect || !executeWrite || !listConnections {
		t.Fatalf("unified tools missing: list=%t run_select=%t execute_write=%t", listConnections, runSelect, executeWrite)
	}

	if _, err := registry.Dispatch(context.Background(), "execute_write", map[string]any{
		"connectionId": "read-only", "sql": "DELETE FROM users",
	}); err == nil || !strings.Contains(err.Error(), "not enabled") {
		t.Fatalf("execute_write should not be available on the read-only profile, error = %v", err)
	}
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
