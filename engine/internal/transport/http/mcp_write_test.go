package http

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlite"
	"github.com/smlee/database-local-engine/engine/internal/application"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
	_ "modernc.org/sqlite"
)

func TestMCPWriteApprovalExecutesExactProposalAndRecordsDuration(t *testing.T) {
	dbFile, err := os.CreateTemp("", "rebase-mcp-write-*.db")
	if err != nil {
		t.Fatal(err)
	}
	dbPath := dbFile.Name()
	_ = dbFile.Close()
	t.Cleanup(func() { _ = os.Remove(dbPath) })

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items(id, value) VALUES (1, 'before');`); err != nil {
		t.Fatal(err)
	}

	proposalDB, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer proposalDB.Close()
	if _, err := proposalDB.Exec(`CREATE TABLE mcp_write_proposals (
		id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, profile_id TEXT NOT NULL,
		sql_text TEXT NOT NULL, risk TEXT NOT NULL, reasons_json TEXT NOT NULL,
		status TEXT NOT NULL, rows_affected INTEGER NOT NULL, error_message TEXT NOT NULL,
		created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, approved_at DATETIME, executed_at DATETIME
	)`); err != nil {
		t.Fatal(err)
	}
	proposals := sqlite.NewSQLiteMCPWriteProposalRepository(proposalDB)
	now := time.Now().UTC()
	proposal := &domain.MCPWriteProposal{
		ID: "proposal-1", WorkspaceID: "default", ProfileID: "profile-1",
		SQL: "UPDATE items SET value = 'after' WHERE id = 1", Risk: "medium",
		Reasons: []string{"updates one row"}, Status: domain.MCPWritePending, CreatedAt: now, UpdatedAt: now,
	}
	if err := proposals.Create(context.Background(), proposal); err != nil {
		t.Fatal(err)
	}

	repo := ports.NewFakeProfileRepository()
	store := ports.NewFakeSecretStore()
	profile := &domain.ConnectionProfile{
		ID: "profile-1", Name: "SQLite test", Driver: "sqlite", Database: dbPath,
		McpEnabled: true, McpWriteMode: domain.MCPWriteModeApproval, SecretRef: "secret-1",
		CreatedAt: now, UpdatedAt: now,
	}
	if err := repo.Create(context.Background(), profile); err != nil {
		t.Fatal(err)
	}
	if err := store.Set(context.Background(), profile.SecretRef, ""); err != nil {
		t.Fatal(err)
	}

	handler := NewMCPWriteHandler("token", application.NewConnectionService(repo, store), proposals, nil)
	req := httptest.NewRequest("POST", "/mcp/write-proposals", strings.NewReader(`{"id":"proposal-1","action":"approve"}`))
	req.Header.Set("X-App-Engine-Token", "token")
	res := httptest.NewRecorder()
	handler.Proposals().ServeHTTP(res, req)
	if res.Code != 200 {
		t.Fatalf("approve status = %d, body=%s", res.Code, res.Body.String())
	}
	var response mcpWriteProposalDTO
	if err := json.Unmarshal(res.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Status != domain.MCPWriteExecuted || response.RowsAffected != 1 {
		t.Fatalf("approval response = %+v", response)
	}

	var value string
	if err := db.QueryRow(`SELECT value FROM items WHERE id = 1`).Scan(&value); err != nil {
		t.Fatal(err)
	}
	if value != "after" {
		t.Fatalf("value = %q, want after", value)
	}
	stored, err := proposals.Get(context.Background(), "default", "proposal-1")
	if err != nil {
		t.Fatal(err)
	}
	if stored.ExecutedAt == nil || stored.ApprovedAt == nil {
		t.Fatalf("timestamps not recorded: %+v", stored)
	}
}
