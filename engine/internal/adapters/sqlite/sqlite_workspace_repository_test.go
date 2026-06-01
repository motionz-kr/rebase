package sqlite

import (
	"database/sql"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/ports"
	_ "modernc.org/sqlite"
)

func TestSQLiteWorkspaceRepository_Contract(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}
	defer db.Close()

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
					created_at DATETIME NOT NULL,
					updated_at DATETIME NOT NULL
				);
			`,
			Checksum: "profiles-v1",
		},
		{
			Version: 2,
			Name:    "create_workspace_saved_queries_history",
			SQL: `
				CREATE TABLE workspaces (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					remote_id TEXT,
					version INTEGER NOT NULL DEFAULT 1,
					sync_state TEXT NOT NULL DEFAULT 'local',
					created_at DATETIME NOT NULL,
					updated_at DATETIME NOT NULL
				);
				CREATE TABLE saved_queries (
					id TEXT PRIMARY KEY,
					workspace_id TEXT NOT NULL,
					profile_id TEXT NOT NULL,
					name TEXT NOT NULL,
					query_text TEXT NOT NULL,
					is_favorite INTEGER NOT NULL DEFAULT 0,
					remote_id TEXT,
					version INTEGER NOT NULL DEFAULT 1,
					sync_state TEXT NOT NULL DEFAULT 'local',
					created_at DATETIME NOT NULL,
					updated_at DATETIME NOT NULL,
					FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
					FOREIGN KEY (profile_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
				);
				CREATE TABLE query_history (
					id TEXT PRIMARY KEY,
					workspace_id TEXT NOT NULL,
					profile_id TEXT NOT NULL,
					query_text TEXT NOT NULL,
					executed_at DATETIME NOT NULL,
					duration_ms INTEGER NOT NULL,
					success INTEGER NOT NULL,
					error_message TEXT,
					row_count INTEGER,
					remote_id TEXT,
					version INTEGER NOT NULL DEFAULT 1,
					sync_state TEXT NOT NULL DEFAULT 'local',
					FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
					FOREIGN KEY (profile_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
				);
			`,
			Checksum: "workspace-queries-v1",
		},
	}

	if err := runner.Run(migrations); err != nil {
		t.Fatalf("failed to run migrations: %v", err)
	}

	// For foreign key constraint tests in contract, we may need profiles. But SQLite by default might have FK constraints off or on.
	// The contract test creates queries referring to 'prof-1' and 'ws-2'. To avoid FK violations if enabled:
	// We'll insert a stub profile and workspaces before running contract test, or we can just run it since FK is off by default in sqlite memory db unless "PRAGMA foreign_keys = ON" is executed.
	// Just to be safe, let's insert the profile and workspace that the contract test uses, or keep FK check off.
	// Contract uses ws2 ("ws-2") and prof-1 ("prof-1").
	_, _ = db.Exec("INSERT INTO connection_profiles (id, name, driver, host, port, database, username, secret_ref, tls_mode, created_at, updated_at) VALUES ('prof-1', 'stub', 'mysql', 'localhost', 3306, 'db', 'user', 'sec', 'none', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")

	repo := NewSQLiteWorkspaceRepository(db)
	ports.VerifyWorkspaceRepositoryContract(t, repo)
}
