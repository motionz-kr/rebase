package sqlite

import (
	"context"
	"database/sql"
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

func TestProfileMCPFieldsRoundTrip(t *testing.T) {
	repo := newProfileRepo(t)
	ctx := context.Background()
	p := &domain.ConnectionProfile{
		ID: "p1", Name: "x", Driver: "mysql", Host: "h", Port: 3306, Database: "d",
		Username: "u", SecretRef: "s", TLSMode: "none",
		McpEnabled: true, McpDataExposure: "unrestricted",
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := repo.Create(ctx, p); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.GetByID(ctx, "p1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !got.McpEnabled || got.McpDataExposure != "unrestricted" {
		t.Errorf("mcp fields not persisted: %+v", got)
	}

	got.McpEnabled = false
	got.McpDataExposure = "metadata"
	if err := repo.Update(ctx, got); err != nil {
		t.Fatalf("update: %v", err)
	}
	again, _ := repo.GetByID(ctx, "p1")
	if again.McpEnabled || again.McpDataExposure != "metadata" {
		t.Errorf("mcp fields not updated: %+v", again)
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
