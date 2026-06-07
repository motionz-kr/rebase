package application

import (
	"context"
	"database/sql"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlite"
	_ "modernc.org/sqlite"
)

func TestTemplateService_SaveAssignsIDAndLists(t *testing.T) {
	db, _ := sql.Open("sqlite", ":memory:")
	defer db.Close()
	db.Exec(`CREATE TABLE templates (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
		description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', sql_text TEXT NOT NULL,
		parameters TEXT NOT NULL DEFAULT '[]', driver TEXT NOT NULL DEFAULT '',
		created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL);`)
	svc := NewTemplateService(sqlite.NewSQLiteTemplateRepository(db))
	ctx := context.Background()
	tpl, err := svc.SaveTemplate(ctx, "", "default", "Dup", "desc", "CS", "SELECT 1", "[]", "mysql")
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if tpl.ID == "" {
		t.Fatal("expected generated ID")
	}
	list, err := svc.ListTemplates(ctx, "default")
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v len=%d", err, len(list))
	}
}
