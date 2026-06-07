package sqlite

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	_ "modernc.org/sqlite"
)

func newTemplateRepo(t *testing.T) *SQLiteTemplateRepository {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(`
		CREATE TABLE templates (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			category TEXT NOT NULL DEFAULT '',
			sql_text TEXT NOT NULL,
			parameters TEXT NOT NULL DEFAULT '[]',
			driver TEXT NOT NULL DEFAULT '',
			created_at DATETIME NOT NULL,
			updated_at DATETIME NOT NULL
		);
	`); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return NewSQLiteTemplateRepository(db)
}

func TestTemplateRepository_RoundTrip(t *testing.T) {
	repo := newTemplateRepo(t)
	ctx := context.Background()
	tpl := &domain.Template{
		ID: "t1", WorkspaceID: "default", Name: "Dup by column",
		Description: "find dups", Category: "CS", SQLText: "SELECT 1",
		Parameters: `[{"name":"table","kind":"identifier"}]`, Driver: "mysql",
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := repo.Create(ctx, tpl); err != nil {
		t.Fatalf("create: %v", err)
	}
	list, err := repo.List(ctx, "default")
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v len=%d", err, len(list))
	}
	if list[0].Name != "Dup by column" || list[0].Parameters != tpl.Parameters {
		t.Fatalf("round-trip mismatch: %+v", list[0])
	}
	if err := repo.Delete(ctx, "t1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if l, _ := repo.List(ctx, "default"); len(l) != 0 {
		t.Fatalf("expected empty after delete")
	}
}
