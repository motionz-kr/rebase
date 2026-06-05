package sqlite

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
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

func TestSQLite_DescribeTable(t *testing.T) {
	c := NewSQLiteConnector()
	p := sqliteProfile(seedDB(t), false)
	d, err := c.DescribeTable(context.Background(), p, "", "test.db", "books")
	if err != nil {
		t.Fatalf("DescribeTable: %v", err)
	}
	if len(d.Columns) != 3 {
		t.Fatalf("expected 3 columns, got %d (%+v)", len(d.Columns), d.Columns)
	}
	if d.Columns[0].Name != "id" || !d.Columns[0].PrimaryKey {
		t.Fatalf("col0 should be id PK, got %+v", d.Columns[0])
	}
	if d.Columns[1].Name != "title" || d.Columns[1].Nullable {
		t.Fatalf("title should be NOT NULL, got %+v", d.Columns[1])
	}
}

func TestSQLite_ListColumns(t *testing.T) {
	c := NewSQLiteConnector()
	p := sqliteProfile(seedDB(t), false)
	cols, err := c.ListColumns(context.Background(), p, "", "test.db")
	if err != nil {
		t.Fatalf("ListColumns: %v", err)
	}
	// 2 (authors) + 3 (books) = 5 column refs.
	if len(cols) != 5 {
		t.Fatalf("expected 5 column refs, got %d (%+v)", len(cols), cols)
	}
}

func TestSQLite_ListForeignKeys(t *testing.T) {
	c := NewSQLiteConnector()
	p := sqliteProfile(seedDB(t), false)
	fks, err := c.ListForeignKeys(context.Background(), p, "", "test.db", "books")
	if err != nil {
		t.Fatalf("ListForeignKeys: %v", err)
	}
	if len(fks) != 1 || fks[0].Column != "author_id" || fks[0].RefTable != "authors" || fks[0].RefColumn != "id" {
		t.Fatalf("unexpected FKs: %+v", fks)
	}
}

func TestSQLite_ListIndexes(t *testing.T) {
	c := NewSQLiteConnector()
	p := sqliteProfile(seedDB(t), false)
	idx, err := c.ListIndexes(context.Background(), p, "", "test.db", "authors")
	if err != nil {
		t.Fatalf("ListIndexes: %v", err)
	}
	var found *ports.Index
	for i := range idx {
		if idx[i].Name == "idx_authors_name" {
			found = &idx[i]
		}
	}
	if found == nil || !found.Unique || len(found.Columns) != 1 || found.Columns[0] != "name" {
		t.Fatalf("idx_authors_name not found/incorrect: %+v", idx)
	}
}

func TestSQLite_GetSchemaGraph(t *testing.T) {
	c := NewSQLiteConnector()
	p := sqliteProfile(seedDB(t), false)
	g, err := c.GetSchemaGraph(context.Background(), p, "", "test.db")
	if err != nil {
		t.Fatalf("GetSchemaGraph: %v", err)
	}
	if len(g.Tables) != 2 {
		t.Fatalf("expected 2 tables, got %d", len(g.Tables))
	}
	if len(g.ForeignKeys) != 1 || g.ForeignKeys[0].FromTable != "books" || g.ForeignKeys[0].ToTable != "authors" {
		t.Fatalf("unexpected FKs: %+v", g.ForeignKeys)
	}
}
