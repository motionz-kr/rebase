package agent

import (
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func TestValidateMCPQueryScopeAllowsConfiguredReferences(t *testing.T) {
	scope := domain.MCPAccessScope{
		AllowedDatabases: []string{"app_db"},
		AllowedSchemas:   []string{"public"},
		AllowedTables:    []string{"users", "public.orders"},
	}
	if err := ValidateMCPQueryScope("postgres", "app_db", scope, "SELECT * FROM public.users JOIN public.orders ON users.id = orders.user_id"); err != nil {
		t.Fatalf("allowed query rejected: %v", err)
	}
}

func TestValidateMCPQueryScopeRejectsOutOfScopeReferences(t *testing.T) {
	scope := domain.MCPAccessScope{AllowedDatabases: []string{"app_db"}, AllowedSchemas: []string{"public"}, AllowedTables: []string{"users"}}
	cases := []string{
		"SELECT * FROM private.users",
		"SELECT * FROM public.payments",
		"SELECT * FROM billing_db.users",
	}
	for _, query := range cases {
		if err := ValidateMCPQueryScope("postgres", "app_db", scope, query); err == nil {
			t.Errorf("expected query to be rejected: %s", query)
		}
	}
}

func TestValidateMCPQueryScopeRejectsAmbiguousRestrictedSQL(t *testing.T) {
	scope := domain.MCPAccessScope{AllowedTables: []string{"users"}}
	if err := ValidateMCPQueryScope("postgres", "app_db", scope, "SELECT * FROM"); err == nil {
		t.Fatal("malformed restricted query should be rejected")
	}
}

func TestValidateMCPTableRefUsesMySQLDatabaseQualification(t *testing.T) {
	scope := domain.MCPAccessScope{AllowedDatabases: []string{"app_db"}, AllowedTables: []string{"users"}}
	if err := ValidateMCPTableRef("mysql", "app_db", scope, "app_db.users"); err != nil {
		t.Fatalf("qualified MySQL table rejected: %v", err)
	}
	if err := ValidateMCPTableRef("mysql", "app_db", scope, "other_db.users"); err == nil {
		t.Fatal("other database should be rejected")
	}
}

func TestFilterMCPTableNames(t *testing.T) {
	scope := domain.MCPAccessScope{AllowedTables: []string{"users"}}
	got := FilterMCPTableNames("postgres", "app_db", scope, []string{"users", "orders"})
	if strings.Join(got, ",") != "users" {
		t.Fatalf("filtered tables = %v", got)
	}
}
