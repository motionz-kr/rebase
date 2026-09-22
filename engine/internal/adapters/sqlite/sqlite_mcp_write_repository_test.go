package sqlite

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	_ "modernc.org/sqlite"
)

func newMCPWriteRepo(t *testing.T) *SQLiteMCPWriteProposalRepository {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.Exec(`CREATE TABLE mcp_write_proposals (
		id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, profile_id TEXT NOT NULL,
		sql_text TEXT NOT NULL, risk TEXT NOT NULL, reasons_json TEXT NOT NULL,
		status TEXT NOT NULL, rows_affected INTEGER NOT NULL DEFAULT 0,
		error_message TEXT NOT NULL DEFAULT '', created_at DATETIME NOT NULL,
		updated_at DATETIME NOT NULL, approved_at DATETIME, executed_at DATETIME
	)`)
	if err != nil {
		t.Fatalf("create schema: %v", err)
	}
	return NewSQLiteMCPWriteProposalRepository(db)
}

func TestSQLiteMCPWriteProposalRepositoryRoundTripAndStatusFilter(t *testing.T) {
	repo := newMCPWriteRepo(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	want := &domain.MCPWriteProposal{
		ID: "proposal-1", WorkspaceID: "default", ProfileID: "profile-1",
		SQL: "UPDATE users SET active = 0 WHERE id = 7", Risk: "safe",
		Reasons: []string{"scoped update"}, Status: domain.MCPWritePending,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := repo.Create(context.Background(), want); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.Get(context.Background(), "default", "proposal-1")
	if err != nil || got == nil || got.SQL != want.SQL || got.Status != domain.MCPWritePending || len(got.Reasons) != 1 {
		t.Fatalf("get = %+v, err = %v", got, err)
	}
	got.Status = domain.MCPWriteApproved
	got.UpdatedAt = now.Add(time.Second)
	if err := repo.Update(context.Background(), got); err != nil {
		t.Fatalf("update: %v", err)
	}
	list, err := repo.List(context.Background(), "default", "profile-1", domain.MCPWriteApproved, 10)
	if err != nil || len(list) != 1 || list[0].ID != want.ID {
		t.Fatalf("approved list = %+v, err = %v", list, err)
	}
}
