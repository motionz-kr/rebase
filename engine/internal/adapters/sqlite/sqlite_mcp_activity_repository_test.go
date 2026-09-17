package sqlite

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	_ "modernc.org/sqlite"
)

func newMCPActivityRepo(t *testing.T) *SQLiteMCPActivityRepository {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`CREATE TABLE mcp_activity_events (
		id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, profile_id TEXT NOT NULL DEFAULT '',
		server_id TEXT NOT NULL DEFAULT '', direction TEXT NOT NULL, event TEXT NOT NULL,
		tool TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, error_message TEXT NOT NULL DEFAULT '',
		duration_ms INTEGER NOT NULL DEFAULT 0, created_at DATETIME NOT NULL
	)`); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	return NewSQLiteMCPActivityRepository(db)
}

func TestSQLiteMCPActivityRepositoryRoundTripAndFilter(t *testing.T) {
	repo := newMCPActivityRepo(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	if err := repo.Append(ctx, &domain.MCPActivityEvent{
		ID: "a1", WorkspaceID: "default", ProfileID: "p1", Direction: "inbound",
		Event: "tool_call", Tool: "list_tables", Status: "success", DurationMs: 12, CreatedAt: now,
	}); err != nil {
		t.Fatalf("append: %v", err)
	}
	if err := repo.Append(ctx, &domain.MCPActivityEvent{
		ID: "a2", WorkspaceID: "default", ProfileID: "p2", Direction: "inbound",
		Event: "tool_call", Tool: "run_select", Status: "error", Error: "denied", CreatedAt: now.Add(time.Second),
	}); err != nil {
		t.Fatalf("append second: %v", err)
	}
	got, err := repo.List(ctx, domain.MCPActivityFilter{WorkspaceID: "default", ProfileID: "p1", Limit: 10})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 || got[0].Tool != "list_tables" || got[0].DurationMs != 12 {
		t.Fatalf("filtered activity = %+v", got)
	}
}
