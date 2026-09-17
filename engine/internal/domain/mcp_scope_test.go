package domain

import (
	"strings"
	"testing"
)

func TestMCPAccessScopeAllowsOnlyConfiguredObjects(t *testing.T) {
	scope := MCPAccessScope{
		AllowedDatabases: []string{"app_db"},
		AllowedSchemas:   []string{"public"},
		AllowedTables:    []string{"users", "public.orders"},
	}

	if !scope.AllowsDatabase("app_db") || scope.AllowsDatabase("billing_db") {
		t.Fatalf("database allowlist mismatch")
	}
	if !scope.AllowsSchema("public") || scope.AllowsSchema("private") {
		t.Fatalf("schema allowlist mismatch")
	}
	if !scope.AllowsTable("public", "users") || !scope.AllowsTable("public", "orders") {
		t.Fatalf("table allowlist should accept exact and schema-qualified entries")
	}
	if scope.AllowsTable("public", "payments") || scope.AllowsTable("private", "orders") {
		t.Fatalf("table allowlist should reject unconfigured objects")
	}
}

func TestMCPAccessScopeEmptyListsPreserveLegacyAccess(t *testing.T) {
	var scope MCPAccessScope
	if !scope.AllowsDatabase("any") || !scope.AllowsSchema("any") || !scope.AllowsTable("any", "any") {
		t.Fatalf("empty scope should preserve legacy behavior")
	}
}

func TestConnectionProfileMCPAccessScopeRoundTripsJSONLists(t *testing.T) {
	p := ConnectionProfile{
		McpAllowedDatabases: `["app_db"]`,
		McpAllowedSchemas:   `["public"]`,
		McpAllowedTables:    `["users"]`,
	}
	scope := p.MCPAccessScope()
	if len(scope.AllowedDatabases) != 1 || scope.AllowedDatabases[0] != "app_db" {
		t.Fatalf("database scope: %+v", scope)
	}
	if len(scope.AllowedSchemas) != 1 || scope.AllowedSchemas[0] != "public" {
		t.Fatalf("schema scope: %+v", scope)
	}
	if len(scope.AllowedTables) != 1 || scope.AllowedTables[0] != "users" {
		t.Fatalf("table scope: %+v", scope)
	}
}

func TestSafeMCPErrorOmitsSQLAndCredentials(t *testing.T) {
	got := SafeMCPError("syntax error near SELECT * FROM users WHERE email = 'secret@example.com' with password token")
	if strings.Contains(got, "SELECT") || strings.Contains(got, "secret@example.com") || strings.Contains(got, "password") {
		t.Fatalf("sensitive MCP error details leaked: %q", got)
	}
	if got != "operation failed; sensitive details omitted" {
		t.Fatalf("unexpected safe MCP error: %q", got)
	}
}
