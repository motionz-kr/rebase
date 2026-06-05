package sqlite

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	_ "modernc.org/sqlite"
)

// seedDB creates a temp .db with two tables (FK), a view, and two indexes.
func seedDB(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("open seed db: %v", err)
	}
	defer db.Close()
	stmts := []string{
		`CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`,
		`CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER REFERENCES authors(id))`,
		`CREATE VIEW book_titles AS SELECT title FROM books`,
		`CREATE UNIQUE INDEX idx_authors_name ON authors(name)`,
		`CREATE INDEX idx_books_author ON books(author_id)`,
		`INSERT INTO authors (id, name) VALUES (1, 'Ann'), (2, 'Bob')`,
		`INSERT INTO books (id, title, author_id) VALUES (1, 'Go', 1), (2, 'SQL', 2)`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("seed %q: %v", s, err)
		}
	}
	return path
}

func sqliteProfile(path string, readOnly bool) domain.ConnectionProfile {
	return domain.ConnectionProfile{Name: "t", Driver: "sqlite", Database: path, ReadOnly: readOnly}
}

func TestSQLite_TestConnection(t *testing.T) {
	c := NewSQLiteConnector()
	if err := c.TestConnection(context.Background(), sqliteProfile(seedDB(t), false), ""); err != nil {
		t.Fatalf("TestConnection: %v", err)
	}
}

func TestSQLite_ListDatabases_ListTables_ListViews(t *testing.T) {
	c := NewSQLiteConnector()
	p := sqliteProfile(seedDB(t), false)
	ctx := context.Background()

	dbs, err := c.ListDatabases(ctx, p, "")
	if err != nil || len(dbs) != 1 || dbs[0].Name != "test.db" {
		t.Fatalf("ListDatabases = %+v, err=%v", dbs, err)
	}
	tables, err := c.ListTables(ctx, p, "", "test.db")
	if err != nil {
		t.Fatalf("ListTables: %v", err)
	}
	if len(tables) != 2 || tables[0].Name != "authors" || tables[1].Name != "books" {
		t.Fatalf("ListTables = %+v", tables)
	}
	views, err := c.ListViews(ctx, p, "", "test.db")
	if err != nil || len(views) != 1 || views[0].Name != "book_titles" {
		t.Fatalf("ListViews = %+v, err=%v", views, err)
	}
}

func TestSQLite_GetTableDDL_GetViewDDL(t *testing.T) {
	c := NewSQLiteConnector()
	p := sqliteProfile(seedDB(t), false)
	ctx := context.Background()
	ddl, err := c.GetTableDDL(ctx, p, "", "test.db", "authors")
	if err != nil || ddl == "" {
		t.Fatalf("GetTableDDL = %q, err=%v", ddl, err)
	}
	vddl, err := c.GetViewDDL(ctx, p, "", "test.db", "book_titles")
	if err != nil || vddl == "" {
		t.Fatalf("GetViewDDL = %q, err=%v", vddl, err)
	}
}
