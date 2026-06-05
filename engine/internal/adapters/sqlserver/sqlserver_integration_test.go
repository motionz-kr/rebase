package sqlserver

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// sqlserverProfile reads SQLSERVER_TEST_DSN and builds a ConnectionProfile plus
// the password and target database name. It skips the test when the env is
// unset, mirroring the postgres/mysql integration guard.
//
// Expected DSN form:
//
//	sqlserver://sa:Strong!Passw0rd@localhost:1433?database=master&encrypt=disable
func sqlserverProfile(t *testing.T) (domain.ConnectionProfile, string, string) {
	t.Helper()
	dsn := os.Getenv("SQLSERVER_TEST_DSN")
	if dsn == "" {
		t.Skip("SQLSERVER_TEST_DSN not set; skipping SQL Server integration test")
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse SQLSERVER_TEST_DSN: %v", err)
	}
	host := u.Hostname()
	port := 1433
	if ps := u.Port(); ps != "" {
		if n, err := strconv.Atoi(ps); err == nil {
			port = n
		}
	}
	username := ""
	password := ""
	if u.User != nil {
		username = u.User.Username()
		password, _ = u.User.Password()
	}
	database := u.Query().Get("database")
	if database == "" {
		database = "master"
	}
	tlsMode := "none"
	if enc := u.Query().Get("encrypt"); enc == "true" {
		tlsMode = "require"
	}
	p := domain.ConnectionProfile{
		ID:       "mssql-it-1",
		Name:     "MSSQL Local",
		Driver:   "sqlserver",
		Host:     host,
		Port:     port,
		Database: database,
		Username: username,
		TLSMode:  tlsMode,
	}
	return p, password, database
}

// seedDB (re)creates the rebase_test database with two tables, a view, a unique
// index and some rows. Idempotent.
func seedDB(t *testing.T, p domain.ConnectionProfile, password string) {
	t.Helper()
	c := NewSQLServerConnector()

	// 1) DROP/CREATE DATABASE must run against master, each on its own batch.
	master, err := c.connect(p, password, "master")
	if err != nil {
		t.Fatalf("connect master: %v", err)
	}
	defer master.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if _, err := master.ExecContext(ctx, "IF DB_ID('rebase_test') IS NOT NULL BEGIN ALTER DATABASE rebase_test SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE rebase_test; END"); err != nil {
		t.Fatalf("drop rebase_test: %v", err)
	}
	if _, err := master.ExecContext(ctx, "CREATE DATABASE rebase_test"); err != nil {
		t.Fatalf("create rebase_test: %v", err)
	}

	// 2) Tables + data in rebase_test.
	rdb, err := c.connect(p, password, "rebase_test")
	if err != nil {
		t.Fatalf("connect rebase_test: %v", err)
	}
	defer rdb.Close()

	stmts := []string{
		`CREATE TABLE authors (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(100) NOT NULL)`,
		`CREATE TABLE books (id INT IDENTITY(1,1) PRIMARY KEY, title NVARCHAR(200) NOT NULL, author_id INT NULL REFERENCES authors(id))`,
		// CREATE VIEW must be the only statement in its batch.
		`CREATE VIEW book_titles AS SELECT title FROM books`,
		`CREATE UNIQUE INDEX idx_authors_name ON authors(name)`,
		`INSERT INTO authors (name) VALUES ('Ann'),('Bob')`,
		`INSERT INTO books (title, author_id) VALUES ('Go',1),('SQL',2)`,
	}
	for _, s := range stmts {
		if _, err := rdb.ExecContext(ctx, s); err != nil {
			t.Fatalf("seed %q: %v", s, err)
		}
	}
}

func TestSQLServer_TestConnection(t *testing.T) {
	p, pw, _ := sqlserverProfile(t)
	c := NewSQLServerConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := c.TestConnection(ctx, p, pw); err != nil {
		t.Fatalf("TestConnection: %v", err)
	}
}

func TestSQLServer_ListDatabases_Tables_Views(t *testing.T) {
	p, pw, _ := sqlserverProfile(t)
	seedDB(t, p, pw)
	c := NewSQLServerConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	dbs, err := c.ListDatabases(ctx, p, pw)
	if err != nil {
		t.Fatalf("ListDatabases: %v", err)
	}
	found := false
	for _, d := range dbs {
		if d.Name == "rebase_test" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected rebase_test in databases, got %v", dbs)
	}

	tables, err := c.ListTables(ctx, p, pw, "rebase_test")
	if err != nil {
		t.Fatalf("ListTables: %v", err)
	}
	var tnames []string
	for _, tb := range tables {
		tnames = append(tnames, tb.Name)
	}
	if len(tnames) != 2 || tnames[0] != "authors" || tnames[1] != "books" {
		t.Errorf("expected [authors books], got %v", tnames)
	}

	views, err := c.ListViews(ctx, p, pw, "rebase_test")
	if err != nil {
		t.Fatalf("ListViews: %v", err)
	}
	if len(views) != 1 || views[0].Name != "book_titles" {
		t.Errorf("expected [book_titles], got %v", views)
	}
}

func TestSQLServer_GetViewDDL(t *testing.T) {
	p, pw, _ := sqlserverProfile(t)
	seedDB(t, p, pw)
	c := NewSQLServerConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	ddl, err := c.GetViewDDL(ctx, p, pw, "rebase_test", "book_titles")
	if err != nil {
		t.Fatalf("GetViewDDL: %v", err)
	}
	if ddl == "" {
		t.Fatal("expected non-empty view DDL")
	}
	if !strings.Contains(ddl, "book_titles") && !strings.Contains(strings.ToUpper(ddl), "SELECT") {
		t.Errorf("unexpected view DDL: %q", ddl)
	}
}

func TestSQLServer_DescribeTable(t *testing.T) {
	p, pw, _ := sqlserverProfile(t)
	seedDB(t, p, pw)
	c := NewSQLServerConnector()
	d, err := c.DescribeTable(context.Background(), p, pw, "rebase_test", "books")
	if err != nil {
		t.Fatalf("DescribeTable: %v", err)
	}
	if len(d.Columns) != 3 {
		t.Fatalf("want 3 cols, got %d (%+v)", len(d.Columns), d.Columns)
	}
	// id is PK + not null; title not null; author_id nullable
	byName := map[string]ports.ColumnInfo{}
	for _, col := range d.Columns {
		byName[col.Name] = col
	}
	if !byName["id"].PrimaryKey {
		t.Fatalf("id should be PK: %+v", byName["id"])
	}
	if byName["title"].Nullable {
		t.Fatalf("title should be NOT NULL")
	}
	if !byName["author_id"].Nullable {
		t.Fatalf("author_id should be nullable")
	}
}

func TestSQLServer_ListColumns(t *testing.T) {
	p, pw, _ := sqlserverProfile(t)
	seedDB(t, p, pw)
	c := NewSQLServerConnector()
	cols, err := c.ListColumns(context.Background(), p, pw, "rebase_test")
	if err != nil {
		t.Fatalf("ListColumns: %v", err)
	}
	if len(cols) != 5 {
		t.Fatalf("want 5 column refs (2+3), got %d", len(cols))
	}
}

func TestSQLServer_ListForeignKeys(t *testing.T) {
	p, pw, _ := sqlserverProfile(t)
	seedDB(t, p, pw)
	c := NewSQLServerConnector()
	fks, err := c.ListForeignKeys(context.Background(), p, pw, "rebase_test", "books")
	if err != nil {
		t.Fatalf("ListForeignKeys: %v", err)
	}
	if len(fks) != 1 || fks[0].Column != "author_id" || fks[0].RefTable != "authors" || fks[0].RefColumn != "id" {
		t.Fatalf("unexpected FKs: %+v", fks)
	}
}

func TestSQLServer_ListIndexes(t *testing.T) {
	p, pw, _ := sqlserverProfile(t)
	seedDB(t, p, pw)
	c := NewSQLServerConnector()
	idx, err := c.ListIndexes(context.Background(), p, pw, "rebase_test", "authors")
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
		t.Fatalf("idx_authors_name missing/incorrect: %+v", idx)
	}
}

func TestSQLServer_GetSchemaGraph(t *testing.T) {
	p, pw, _ := sqlserverProfile(t)
	seedDB(t, p, pw)
	c := NewSQLServerConnector()
	g, err := c.GetSchemaGraph(context.Background(), p, pw, "rebase_test")
	if err != nil {
		t.Fatalf("GetSchemaGraph: %v", err)
	}
	if len(g.Tables) != 2 {
		t.Fatalf("want 2 tables, got %d", len(g.Tables))
	}
	if len(g.ForeignKeys) != 1 || g.ForeignKeys[0].FromTable != "books" || g.ForeignKeys[0].ToTable != "authors" {
		t.Fatalf("unexpected FKs: %+v", g.ForeignKeys)
	}
}

func TestSQLServer_GetTableDDL(t *testing.T) {
	p, pw, _ := sqlserverProfile(t)
	seedDB(t, p, pw)
	c := NewSQLServerConnector()
	ddl, err := c.GetTableDDL(context.Background(), p, pw, "rebase_test", "books")
	if err != nil {
		t.Fatalf("GetTableDDL: %v", err)
	}
	for _, want := range []string{"CREATE TABLE", "[books]", "IDENTITY", "PRIMARY KEY"} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("DDL missing %q:\n%s", want, ddl)
		}
	}
}

// compile-time assurance the test file's sql import is used even if helpers change.
var _ = sql.ErrNoRows
