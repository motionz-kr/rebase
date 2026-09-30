package sqlite

import (
	"context"
	"database/sql"
	"reflect"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
	_ "modernc.org/sqlite"
)

func newProfileRepo(t *testing.T) *SQLiteProfileRepository {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	runner := NewMigrationRunner(db)
	migrations := []Migration{
		{
			Version: 1,
			Name:    "create_connection_profiles",
			SQL: `
				CREATE TABLE connection_profiles (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					driver TEXT NOT NULL,
					host TEXT NOT NULL,
					port INTEGER NOT NULL,
					database TEXT NOT NULL,
					username TEXT NOT NULL,
					secret_ref TEXT NOT NULL,
					tls_mode TEXT NOT NULL,
					mcp_enabled INTEGER NOT NULL DEFAULT 0,
					mcp_data_exposure TEXT NOT NULL DEFAULT 'metadata',
					mcp_write_mode TEXT NOT NULL DEFAULT 'disabled',
					mcp_allowed_databases TEXT NOT NULL DEFAULT '',
					mcp_allowed_schemas TEXT NOT NULL DEFAULT '',
					mcp_allowed_tables TEXT NOT NULL DEFAULT '',
					read_only INTEGER NOT NULL DEFAULT 0,
					connection_uri TEXT NOT NULL DEFAULT '',
					safe_mode INTEGER NOT NULL DEFAULT 0,
					tenant_columns TEXT NOT NULL DEFAULT '',
					domain_bindings TEXT NOT NULL DEFAULT '',
					domain_glossary TEXT NOT NULL DEFAULT '',
					domain_notes TEXT NOT NULL DEFAULT '',
					created_at DATETIME NOT NULL,
					updated_at DATETIME NOT NULL
				);
			`,
			Checksum: "profiles-v1",
		},
	}
	migrations = append(migrations, SSMProfileMigration)
	if err := runner.Run(migrations); err != nil {
		t.Fatalf("failed to run profiles migration: %v", err)
	}
	return NewSQLiteProfileRepository(db)
}

func TestSQLiteProfileRepository_Contract(t *testing.T) {
	ports.VerifyProfileRepositoryContract(t, newProfileRepo(t))
}

func TestProfileRepository_ReadOnlyRoundTrips(t *testing.T) {
	repo := newProfileRepo(t)
	ctx := context.Background()

	p := &domain.ConnectionProfile{
		ID: "ro1", Name: "local", Driver: "sqlite", Host: "", Port: 0,
		Database: "/tmp/x.db", Username: "", SecretRef: "", TLSMode: "none",
		ReadOnly: true, ConnectionURI: "mongodb://x", CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := repo.Create(ctx, p); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.GetByID(ctx, "ro1")
	if err != nil {
		t.Fatalf("getByID: %v", err)
	}
	if !got.ReadOnly {
		t.Fatalf("expected ReadOnly=true to round-trip, got false")
	}
	if got.ConnectionURI != "mongodb://x" {
		t.Fatalf("expected ConnectionURI to round-trip, got %q", got.ConnectionURI)
	}
}

func TestProfileRepository_SafeModeRoundTrips(t *testing.T) {
	repo := newProfileRepo(t)
	ctx := context.Background()

	p := &domain.ConnectionProfile{
		ID: "sm1", Name: "prod", Driver: "mysql", Host: "h", Port: 3306,
		Database: "d", Username: "u", SecretRef: "s", TLSMode: "none",
		SafeMode: true, TenantColumns: "hospitalId,orgId",
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := repo.Create(ctx, p); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.GetByID(ctx, "sm1")
	if err != nil {
		t.Fatalf("getByID: %v", err)
	}
	if !got.SafeMode {
		t.Fatalf("expected SafeMode=true to round-trip")
	}
	if got.TenantColumns != "hospitalId,orgId" {
		t.Fatalf("expected TenantColumns to round-trip, got %q", got.TenantColumns)
	}
}

func TestProfileRepository_MCPAccessScopeRoundTrips(t *testing.T) {
	repo := newProfileRepo(t)
	ctx := context.Background()
	p := &domain.ConnectionProfile{
		ID: "scope1", Name: "scoped", Driver: "postgres", Host: "h", Port: 5432,
		Database: "app_db", Username: "u", SecretRef: "s", TLSMode: "none",
	}
	p.SetMCPAccessScope(domain.MCPAccessScope{
		AllowedDatabases: []string{"app_db"},
		AllowedSchemas:   []string{"public"},
		AllowedTables:    []string{"users", "public.orders"},
	})
	if err := repo.Create(ctx, p); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.GetByID(ctx, p.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	scope := got.MCPAccessScope()
	if len(scope.AllowedTables) != 2 || scope.AllowedTables[1] != "public.orders" {
		t.Fatalf("scope did not round-trip: %+v", scope)
	}
}

func TestProfileRepository_DomainBindingsRoundTrips(t *testing.T) {
	repo := newProfileRepo(t)
	ctx := context.Background()
	p := &domain.ConnectionProfile{
		ID: "db1", Name: "x", Driver: "mysql", Host: "h", Port: 3306, Database: "d",
		Username: "u", SecretRef: "s", TLSMode: "none",
		DomainBindings: `{"tenant":"hospitalId","soft_delete":"deletedAt"}`,
		CreatedAt:      time.Now(), UpdatedAt: time.Now(),
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

func TestProfileMCPFieldsRoundTrip(t *testing.T) {
	repo := newProfileRepo(t)
	ctx := context.Background()
	p := &domain.ConnectionProfile{
		ID: "p1", Name: "x", Driver: "mysql", Host: "h", Port: 3306, Database: "d",
		Username: "u", SecretRef: "s", TLSMode: "none",
		McpEnabled: true, McpDataExposure: "unrestricted", McpWriteMode: domain.MCPWriteModeApproval,
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := repo.Create(ctx, p); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.GetByID(ctx, "p1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !got.McpEnabled || got.McpDataExposure != "unrestricted" || got.McpWriteMode != domain.MCPWriteModeApproval {
		t.Errorf("mcp fields not persisted: %+v", got)
	}

	got.McpEnabled = false
	got.McpDataExposure = "metadata"
	got.McpWriteMode = domain.MCPWriteModeDisabled
	if err := repo.Update(ctx, got); err != nil {
		t.Fatalf("update: %v", err)
	}
	again, _ := repo.GetByID(ctx, "p1")
	if again.McpEnabled || again.McpDataExposure != "metadata" || again.McpWriteMode != domain.MCPWriteModeDisabled {
		t.Errorf("mcp fields not updated: %+v", again)
	}
}

func TestProfileMCPFullAccessRoundTrip(t *testing.T) {
	repo := newProfileRepo(t)
	ctx := context.Background()
	p := &domain.ConnectionProfile{
		ID: "p-full", Name: "full", Driver: "sqlite", Database: "d.sqlite",
		McpEnabled: true, McpWriteMode: domain.MCPWriteModeFullAccess,
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := repo.Create(ctx, p); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.GetByID(ctx, p.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.McpWriteMode != domain.MCPWriteModeFullAccess {
		t.Fatalf("MCP full access mode = %q", got.McpWriteMode)
	}
}

func TestProfileRepo_DomainGlossaryRoundTrip(t *testing.T) {
	repo := newProfileRepo(t)
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

func TestSSMProfileRoundTrip(t *testing.T) {
	repo := newProfileRepo(t)
	ctx := context.Background()
	p := &domain.ConnectionProfile{ID: "ssm", Name: "prod", Driver: "mysql", Host: "private.db", Port: 3306, Database: "app", ConnectionMode: "ssm", SSM: &domain.SSMConfig{Profile: "prod", Region: "ap-northeast-2", InstanceID: "i-0123456789abcdef0"}, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := repo.Create(ctx, p); err != nil {
		t.Fatal(err)
	}
	got, err := repo.GetByID(ctx, p.ID)
	if err != nil || got.ConnectionMode != "ssm" || got.SSM == nil || *got.SSM != *p.SSM {
		t.Fatal(got, err)
	}
	list, err := repo.List(ctx)
	if err != nil || len(list) != 1 || list[0].SSM == nil || list[0].SSM.Profile != "prod" {
		t.Fatal(list, err)
	}
	got.SSM.Region = "us-east-1"
	got.SSM.DocumentName = "Revisit-RdsPortForwarding"
	got.SSM.DestinationMode = "document"
	got.Host, got.Port = "", 0
	if err = repo.Update(ctx, got); err != nil {
		t.Fatal(err)
	}
	got, err = repo.GetByID(ctx, p.ID)
	if err != nil || got.SSM.Region != "us-east-1" || got.SSM.DocumentName != "Revisit-RdsPortForwarding" || got.SSM.DestinationMode != "document" || got.Host != "" || got.Port != 0 {
		t.Fatal(got, err)
	}
	got.ConnectionMode = "direct"
	got.SSM = nil
	if err = repo.Update(ctx, got); err != nil {
		t.Fatal(err)
	}
	got, err = repo.GetByID(ctx, p.ID)
	if err != nil || got.SSM != nil || got.ConnectionMode != "direct" {
		t.Fatal(got, err)
	}
}

func TestSSMMigrationPreservesLegacyProfileAndPolicies(t *testing.T) {
	repo := newProfileRepo(t)
	ctx := context.Background()
	p := &domain.ConnectionProfile{
		ID: "legacy", Name: "existing production", Driver: "mysql", Host: "db.internal", Port: 3306, Database: "app", Username: "readonly", SecretRef: "existing-keychain-ref", TLSMode: "require",
		McpEnabled: true, McpDataExposure: "unrestricted", McpWriteMode: domain.MCPWriteModeApproval,
		McpAllowedDatabases: "app", McpAllowedSchemas: "public", McpAllowedTables: "users",
		ReadOnly: true, SafeMode: true, TenantColumns: "orgId", DomainBindings: `{"tenant":"orgId"}`,
		DomainGlossary: `[{"kind":"table","table":"users","meaning":"사용자"}]`, DomainNotes: "preserve existing policies",
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := repo.Create(ctx, p); err != nil {
		t.Fatal(err)
	}
	// Restore the pre-v18 schema in an isolated in-memory DB with an existing row.
	for _, query := range []string{"ALTER TABLE connection_profiles DROP COLUMN connection_mode", "ALTER TABLE connection_profiles DROP COLUMN ssm_config", "DELETE FROM schema_migrations WHERE version = 18"} {
		if _, err := repo.db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	runner := NewMigrationRunner(repo.db)
	for i := 0; i < 2; i++ {
		if err := runner.Run([]Migration{SSMProfileMigration}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := repo.GetByID(ctx, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !got.CreatedAt.Equal(p.CreatedAt) || !got.UpdatedAt.Equal(p.UpdatedAt) {
		t.Fatal("migration changed timestamps")
	}
	got.CreatedAt, got.UpdatedAt = p.CreatedAt, p.UpdatedAt
	if !reflect.DeepEqual(got, p) {
		t.Fatalf("legacy profile was altered: got %+v; want %+v", got, p)
	}
	if err := got.ValidateConnectionRoute(); err != nil {
		t.Fatal("legacy direct route must remain usable:", err)
	}
}

func TestCorruptStoredSSMConfigurationFailsClosed(t *testing.T) {
	repo := newProfileRepo(t)
	ctx := context.Background()
	p := &domain.ConnectionProfile{ID: "corrupt", Name: "SSM", Driver: "mysql", Host: "db.internal", Port: 3306, Database: "app", ConnectionMode: "ssm", CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := repo.Create(ctx, p); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.db.Exec("UPDATE connection_profiles SET ssm_config = '{broken' WHERE id = ?", p.ID); err != nil {
		t.Fatal(err)
	}
	if got, err := repo.GetByID(ctx, p.ID); err == nil || got != nil {
		t.Fatal("corrupt route must not become a direct profile", got, err)
	}
	if list, err := repo.List(ctx); err == nil || list != nil {
		t.Fatal("corrupt route must not be silently omitted or defaulted", list, err)
	}
}
