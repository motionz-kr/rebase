package sqlite

import (
	"context"
	"database/sql"
	"strings"
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
		query_text TEXT NOT NULL DEFAULT '', duration_ms INTEGER NOT NULL DEFAULT 0, created_at DATETIME NOT NULL
	)`); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	if _, err := db.Exec(`CREATE INDEX idx_mcp_activity_workspace_time ON mcp_activity_events(workspace_id, created_at DESC)`); err != nil {
		t.Fatalf("create activity index: %v", err)
	}
	return NewSQLiteMCPActivityRepository(db)
}

func TestSQLiteMCPActivityRepositoryLoadsQueryDetailsOnDemand(t *testing.T) {
	repo := newMCPActivityRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()
	if err := repo.Append(ctx, &domain.MCPActivityEvent{
		ID: "detail-1", WorkspaceID: "default", Direction: "inbound", Event: "tool_call",
		Tool: "run_select", Status: "success", QueryText: "SELECT * FROM users", CreatedAt: now,
	}); err != nil {
		t.Fatalf("append: %v", err)
	}
	summary, err := repo.ListSummary(ctx, domain.MCPActivityFilter{WorkspaceID: "default", Limit: 10})
	if err != nil || len(summary) != 1 || summary[0].QueryText != "" {
		t.Fatalf("summary = %+v, err = %v", summary, err)
	}
	detail, err := repo.Get(ctx, "default", "detail-1")
	if err != nil || detail == nil || detail.QueryText != "SELECT * FROM users" {
		t.Fatalf("detail = %+v, err = %v", detail, err)
	}
}

func TestSQLiteMCPActivityRepositoryListUsesWorkspaceTimeIndex(t *testing.T) {
	repo := newMCPActivityRepo(t)
	rows, err := repo.db.Query(`EXPLAIN QUERY PLAN SELECT id FROM mcp_activity_events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`, "default", 100)
	if err != nil {
		t.Fatalf("explain activity list: %v", err)
	}
	defer rows.Close()
	used := false
	for rows.Next() {
		var id, parent, notUsed int
		var detail string
		if err := rows.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatalf("scan query plan: %v", err)
		}
		if strings.Contains(detail, "idx_mcp_activity_workspace_time") {
			used = true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("query plan rows: %v", err)
	}
	if !used {
		t.Fatal("activity list should use the workspace/time index")
	}
}

func TestSQLiteMCPActivityRepositoryRoundTripAndFilter(t *testing.T) {
	repo := newMCPActivityRepo(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	if err := repo.Append(ctx, &domain.MCPActivityEvent{
		ID: "a1", WorkspaceID: "default", ProfileID: "p1", Direction: "inbound",
		Event: "tool_call", Tool: "list_tables", QueryText: "SELECT 1", Status: "success", DurationMs: 12, CreatedAt: now,
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
	if len(got) != 1 || got[0].Tool != "list_tables" || got[0].QueryText != "SELECT 1" || got[0].DurationMs != 12 {
		t.Fatalf("filtered activity = %+v", got)
	}
}
