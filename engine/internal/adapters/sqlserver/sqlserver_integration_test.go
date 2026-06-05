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

// compile-time assurance the test file's sql import is used even if helpers change.
var _ = sql.ErrNoRows
