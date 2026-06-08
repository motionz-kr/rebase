package sqlite

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	_ "modernc.org/sqlite"
)

func newMcpRepo(t *testing.T) (*SQLiteMcpServerRepository, *sql.DB) {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := db.Exec(`
		CREATE TABLE workspaces (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL
		);
	`); err != nil {
		t.Fatalf("schema workspaces: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO workspaces (id, name) VALUES ('default', 'Default')`); err != nil {
		t.Fatalf("seed workspace: %v", err)
	}
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS mcp_servers (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			name TEXT NOT NULL,
			command TEXT NOT NULL,
			args TEXT NOT NULL DEFAULT '[]',
			enabled INTEGER NOT NULL DEFAULT 1,
			trusted INTEGER NOT NULL DEFAULT 0,
			created_at DATETIME NOT NULL,
			updated_at DATETIME NOT NULL,
			FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
		);
	`); err != nil {
		t.Fatalf("schema mcp_servers: %v", err)
	}
	return NewSQLiteMcpServerRepository(db), db
}

func TestMcpServerRepo_RoundTrip(t *testing.T) {
	repo, db := newMcpRepo(t)
	defer db.Close()
	ctx := context.Background()

	s := &domain.McpServer{ID: "s1", WorkspaceID: "default", Name: "everything",
		Command: "npx", Args: `["-y","srv"]`, Enabled: true, Trusted: false,
		CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := repo.Create(ctx, s); err != nil {
		t.Fatalf("create: %v", err)
	}

	list, err := repo.List(ctx, "default")
	if err != nil || len(list) != 1 || list[0].Command != "npx" {
		t.Fatalf("list: %v %+v", err, list)
	}
	s.Trusted = true
	if err := repo.Update(ctx, s); err != nil {
		t.Fatalf("update: %v", err)
	}
	again, _ := repo.List(ctx, "default")
	if !again[0].Trusted {
		t.Fatal("trusted not persisted")
	}

	if err := repo.Delete(ctx, "s1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	empty, _ := repo.List(ctx, "default")
	if len(empty) != 0 {
		t.Fatal("expected empty after delete")
	}
}
