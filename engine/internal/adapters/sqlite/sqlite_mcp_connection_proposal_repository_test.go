package sqlite

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	_ "modernc.org/sqlite"
)

func newMCPConnectionProposalRepo(t *testing.T) *SQLiteMCPConnectionProposalRepository {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.Exec(`CREATE TABLE mcp_connection_proposals (
		id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, operation TEXT NOT NULL,
		target_profile_id TEXT NOT NULL DEFAULT '', result_profile_id TEXT NOT NULL DEFAULT '',
		target_updated_at DATETIME, candidate_id TEXT NOT NULL, name TEXT NOT NULL,
		driver TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
		database_name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
		tls_mode TEXT NOT NULL, source TEXT NOT NULL, source_name TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
	)`)
	if err != nil {
		t.Fatalf("create schema: %v", err)
	}
	return NewSQLiteMCPConnectionProposalRepository(db)
}

func TestSQLiteMCPConnectionProposalRepositoryRoundTripAndStatusFilter(t *testing.T) {
	repo := newMCPConnectionProposalRepo(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	targetUpdated := now.Add(-time.Minute)
	want := &domain.MCPConnectionProposal{
		ID: "proposal-1", WorkspaceID: "default", Operation: domain.MCPConnectionProposalUpdate,
		TargetProfileID: "profile-1", TargetUpdatedAt: &targetUpdated,
		CandidateID: domain.CandidateID("postgres", "127.0.0.1", 5433), Name: "Local PG",
		Driver: "postgres", Host: "127.0.0.1", Port: 5433, Database: "app_test", Username: "tester",
		TLSMode: "none", Source: "docker", SourceName: "pg-test", Status: domain.MCPConnectionProposalPending,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := repo.Create(context.Background(), want); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.Get(context.Background(), "default", want.ID)
	if err != nil || got == nil || got.Status != want.Status || got.Database != want.Database || got.TargetUpdatedAt == nil || !got.TargetUpdatedAt.Equal(targetUpdated) {
		t.Fatalf("get = %+v, err = %v", got, err)
	}
	got.Status = domain.MCPConnectionProposalApplied
	got.UpdatedAt = now.Add(time.Second)
	if err := repo.Update(context.Background(), got); err != nil {
		t.Fatalf("update: %v", err)
	}
	list, err := repo.List(context.Background(), "default", domain.MCPConnectionProposalApplied, 10)
	if err != nil || len(list) != 1 || list[0].ID != want.ID {
		t.Fatalf("applied list = %+v, err = %v", list, err)
	}
}
