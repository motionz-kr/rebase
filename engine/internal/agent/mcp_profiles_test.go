package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type fakeAgentDatabaseDiscovery struct {
	result domain.DatabaseDiscoveryResult
}

func (f fakeAgentDatabaseDiscovery) Discover(context.Context) (domain.DatabaseDiscoveryResult, error) {
	return f.result, nil
}

type fakeAgentConnectionProposals struct{ input domain.MCPConnectionProposal }

func (f *fakeAgentConnectionProposals) Propose(_ context.Context, input domain.MCPConnectionProposal) (*domain.MCPConnectionProposal, error) {
	f.input = input
	return &input, nil
}
func (*fakeAgentConnectionProposals) List(context.Context, string, string, int) ([]domain.MCPConnectionProposal, error) {
	return nil, nil
}
func (*fakeAgentConnectionProposals) Resolve(context.Context, string, string, string) error {
	return nil
}

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

func TestMultiProfileRegistryCanDiscoverLocalDatabasesWithoutAProfile(t *testing.T) {
	candidate := domain.DiscoveredDatabase{ID: domain.CandidateID("mysql", "127.0.0.1", 3306), Driver: "mysql", Host: "127.0.0.1", Port: 3306, Source: "local"}
	discovery := fakeAgentDatabaseDiscovery{result: domain.DatabaseDiscoveryResult{Candidates: []domain.DiscoveredDatabase{candidate}}}
	registry := NewMultiProfileRegistryWithDiscovery(nil, discovery)

	var found bool
	for _, spec := range registry.Specs() {
		if spec.Name == "discover_local_databases" {
			found = true
			properties, _ := spec.Schema["properties"].(map[string]any)
			if len(properties) != 0 {
				t.Fatalf("discovery tool accepts unexpected caller-supplied fields: %#v", properties)
			}
		}
	}
	if !found {
		t.Fatal("discover_local_databases tool is missing")
	}

	got, err := registry.Dispatch(context.Background(), "discover_local_databases", map[string]any{"host": "attacker.example", "port": 3306})
	if err != nil {
		t.Fatalf("discover_local_databases: %v", err)
	}
	result, ok := got.(domain.DatabaseDiscoveryResult)
	if !ok || len(result.Candidates) != 1 || result.Candidates[0].Host != "127.0.0.1" {
		t.Fatalf("discovery result = %#v", got)
	}
}

func TestMCPConnectionProposalToolOnlyAcceptsDiscoveredSafeFields(t *testing.T) {
	candidate := domain.DiscoveredDatabase{ID: domain.CandidateID("mysql", "127.0.0.1", 3306), Driver: "mysql", Host: "127.0.0.1", Port: 3306, Source: "docker", SourceName: "local-mysql"}
	discovery := fakeAgentDatabaseDiscovery{result: domain.DatabaseDiscoveryResult{Candidates: []domain.DiscoveredDatabase{candidate}}}
	proposals := &fakeAgentConnectionProposals{}
	registry := NewMultiProfileRegistryWithManagement(nil, nil, discovery, proposals, nil)

	var proposalSpec *ports.ToolSpec
	for _, spec := range registry.Specs() {
		if spec.Name == "propose_connection_profile" {
			proposalSpec = &spec
		}
	}
	if proposalSpec == nil {
		t.Fatal("propose_connection_profile tool is missing")
	}
	properties, _ := proposalSpec.Schema["properties"].(map[string]any)
	for _, forbidden := range []string{"host", "port", "password", "secretRef", "mcpEnabled", "mcpWriteMode", "mcpAllowedDatabases"} {
		if _, exists := properties[forbidden]; exists {
			t.Errorf("tool schema allows forbidden field %q", forbidden)
		}
	}
	if _, err := registry.Dispatch(context.Background(), "propose_connection_profile", map[string]any{
		"operation": "create", "candidateId": candidate.ID, "name": "Local test",
		"password": "do-not-accept", "mcpWriteMode": "full_access",
	}); err == nil {
		t.Fatal("tool should reject credentials and permission fields")
	}
	if _, err := registry.Dispatch(context.Background(), "propose_connection_profile", map[string]any{
		"operation": "create", "candidateId": candidate.ID, "name": "Local test", "database": "testdb", "username": "tester",
	}); err != nil {
		t.Fatalf("safe proposal: %v", err)
	}
	if proposals.input.Host != "" || proposals.input.Port != 0 || proposals.input.Database != "testdb" || proposals.input.Username != "tester" {
		t.Fatalf("proposal unexpectedly included endpoint/permission data: %+v", proposals.input)
	}
}

func TestMultiProfileRegistryResolvesNewlyEnabledProfilesAtCallTime(t *testing.T) {
	seed := NewSQLRegistryWithMCPWrites(&fakeSQL{}, domain.ConnectionProfile{ID: "tool-schema", Driver: "mysql"}, "", "seed", MCPWriteConfig{
		Mode: domain.MCPWriteModeFullAccess,
	})
	var current []MCPConnectionTarget
	registry := NewMultiProfileRegistryWithManagement(
		[]MCPConnectionTarget{{ID: "tool-schema", Name: "Schema only", Driver: "mysql", Registry: seed}},
		func(context.Context) ([]MCPConnectionTarget, error) { return current, nil },
		nil, nil, nil,
	)
	if _, err := registry.Dispatch(context.Background(), "list_connections", map[string]any{}); err != nil {
		t.Fatalf("initial list_connections: %v", err)
	}
	if len(registryList(t, registry)) != 0 {
		t.Fatal("an unconfigured registry should list no live database profiles")
	}

	profile := domain.ConnectionProfile{ID: "newly-enabled", Driver: "mysql", McpEnabled: true}
	current = []MCPConnectionTarget{{
		ID: profile.ID, Name: "Test database", Driver: profile.Driver, Database: "testdb",
		Registry: NewSQLRegistry(&fakeSQL{}, profile, "", "testdb"),
	}}
	connections := registryList(t, registry)
	if len(connections) != 1 || connections[0]["connectionId"] != profile.ID {
		t.Fatalf("new profile was not picked up without rebuilding the registry: %#v", connections)
	}
	if _, err := registry.Dispatch(context.Background(), "run_select", map[string]any{
		"connectionId": profile.ID, "sql": "SELECT 1",
	}); err != nil {
		t.Fatalf("dispatch to newly enabled profile: %v", err)
	}
}

func TestSavedProfileListOmitsCredentialBearingFields(t *testing.T) {
	registry := NewMultiProfileRegistryWithManagement(nil, nil, nil, nil, func(context.Context) ([]domain.ConnectionProfile, error) {
		return []domain.ConnectionProfile{{
			ID: "profile-1", Name: "Local DB", Driver: "mysql", Host: "127.0.0.1", Port: 3306,
			Database: "app_test", Username: "tester", SecretRef: "secret-profile-1",
			ConnectionURI: "mysql://tester:password@127.0.0.1:3306/app_test",
			McpEnabled:    true, McpWriteMode: domain.MCPWriteModeDisabled,
		}}, nil
	})
	out, err := registry.Dispatch(context.Background(), "list_saved_connection_profiles", map[string]any{})
	if err != nil {
		t.Fatalf("list_saved_connection_profiles: %v", err)
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"secretRef", "secret-profile-1", "connectionUri", "password"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Errorf("saved profile listing contains %q: %s", forbidden, encoded)
		}
	}
	if !strings.Contains(string(encoded), "profile-1") || !strings.Contains(string(encoded), "disabled") {
		t.Fatalf("saved profile listing omitted usable profile metadata: %s", encoded)
	}
}

func registryList(t *testing.T, registry *Registry) []map[string]any {
	t.Helper()
	out, err := registry.Dispatch(context.Background(), "list_connections", map[string]any{})
	if err != nil {
		t.Fatalf("list_connections: %v", err)
	}
	connections, ok := out.([]map[string]any)
	if !ok {
		t.Fatalf("list_connections returned %T, want []map[string]any", out)
	}
	return connections
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
