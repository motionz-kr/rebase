package application

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/adapters/keychain"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlite"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	_ "modernc.org/sqlite"
)

func TestIntegration_Persistence(t *testing.T) {
	ctx := context.Background()

	tmpDir, err := os.MkdirTemp("", "db-persistence-test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	dbPath := filepath.Join(tmpDir, "metadata.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}
	defer db.Close()

	runner := sqlite.NewMigrationRunner(db)
	migrations := []sqlite.Migration{
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
					created_at DATETIME NOT NULL,
					updated_at DATETIME NOT NULL
				);
			`,
			Checksum: "profiles-v1",
		},
	}

	if err := runner.Run(migrations); err != nil {
		t.Fatalf("failed to run migrations: %v", err)
	}

	repo := sqlite.NewSQLiteProfileRepository(db)
	store := keychain.NewKeyringStore("AntigravityDBIntegrationTest")
	service := NewConnectionService(repo, store)

	p := &domain.ConnectionProfile{
		Name:     "Integration Test MySQL",
		Driver:   "mysql",
		Host:     "127.0.0.1",
		Port:     3306,
		Database: "mydb",
		Username: "root",
		TLSMode:  "none",
	}
	password := "integration-password-123"

	if err := service.CreateProfile(ctx, p, password); err != nil {
		t.Fatalf("failed to create profile: %v", err)
	}

	gotProfile, gotPassword, err := service.GetProfile(ctx, p.ID)
	if err != nil {
		t.Fatalf("failed to get profile: %v", err)
	}
	if gotProfile.Name != p.Name || gotPassword != password {
		t.Errorf("profile/password mismatch: %+v vs %+v, password %s vs %s", gotProfile, p, gotPassword, password)
	}

	list, err := service.ListProfiles(ctx)
	if err != nil {
		t.Fatalf("failed to list profiles: %v", err)
	}
	if len(list) != 1 {
		t.Errorf("expected 1 profile in list, got %d", len(list))
	}

	if err := service.DeleteProfile(ctx, p.ID); err != nil {
		t.Fatalf("failed to delete profile: %v", err)
	}

	_, _, err = service.GetProfile(ctx, p.ID)
	if err == nil {
		t.Error("expected error getting deleted profile, got nil")
	}
}
