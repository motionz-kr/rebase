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
		ReadOnly: true, CreatedAt: time.Now(), UpdatedAt: time.Now(),
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
