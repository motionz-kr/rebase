package postgres

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

func TestPostgreSQLConnector_ExecuteBatch(t *testing.T) {
	connector := NewPostgreSQLConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p := domain.ConnectionProfile{
		ID: "pg-batch-1", Name: "PG Local", Driver: "postgres",
		Host: "127.0.0.1", Port: 5432, Database: "postgres", Username: "postgres", TLSMode: "none",
	}
	pw := "postgres"

	exec := func(q string) error {
		_, err := connector.ExecuteQueryStream(ctx, p, pw, q, false,
			func(int64) {}, func([]string) error { return nil }, func([]any) error { return nil })
		return err
	}
	_ = exec("DROP TABLE IF EXISTS batch_test")
	if err := exec("CREATE TABLE batch_test (id INT PRIMARY KEY, v INT)"); err != nil {
		t.Fatalf("setup: %v", err)
	}
	defer exec("DROP TABLE IF EXISTS batch_test")

	_, failedIndex, err := connector.ExecuteBatch(ctx, p, pw, []string{
		"INSERT INTO batch_test (id, v) VALUES (1, 10)",
		"INSERT INTO batch_test (id, v) VALUES (1, 20)",
	})
	if err == nil {
		t.Fatal("expected a duplicate-key error")
	}
	if failedIndex != 1 {
		t.Errorf("expected failedIndex 1, got %d", failedIndex)
	}
	_, fi2, err2 := connector.ExecuteBatch(ctx, p, pw, []string{
		"INSERT INTO batch_test (id, v) VALUES (1, 99)",
	})
	if err2 != nil || fi2 != -1 {
		t.Fatalf("rollback did not happen — id=1 still present (err=%v, fi=%d)", err2, fi2)
	}

	affected, fi3, err3 := connector.ExecuteBatch(ctx, p, pw, []string{
		"UPDATE batch_test SET v = 100 WHERE id = 1",
		"INSERT INTO batch_test (id, v) VALUES (2, 20)",
	})
	if err3 != nil || fi3 != -1 {
		t.Fatalf("expected success, got err=%v fi=%d", err3, fi3)
	}
	if affected != 2 {
		t.Errorf("expected rowsAffected 2, got %d", affected)
	}
}

func TestPostgreSQLConnector_ForeignKeys(t *testing.T) {
	connector := NewPostgreSQLConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p := domain.ConnectionProfile{ID: "pg-fk-1", Name: "PG", Driver: "postgres", Host: "127.0.0.1", Port: 5432, Database: "postgres", Username: "postgres", TLSMode: "none"}
	pw := "postgres"
	exec := func(q string) error {
		_, err := connector.ExecuteQueryStream(ctx, p, pw, q, false, func(int64) {}, func([]string) error { return nil }, func([]any) error { return nil })
		return err
	}
	_ = exec("DROP TABLE IF EXISTS fk_child")
	_ = exec("DROP TABLE IF EXISTS fk_parent")
	if err := exec("CREATE TABLE fk_parent (id INT PRIMARY KEY)"); err != nil { t.Fatalf("parent: %v", err) }
	defer exec("DROP TABLE IF EXISTS fk_parent")
	if err := exec("CREATE TABLE fk_child (id INT, parent_id INT REFERENCES fk_parent(id))"); err != nil { t.Fatalf("child: %v", err) }
	defer exec("DROP TABLE IF EXISTS fk_child")

	fks, err := connector.ListForeignKeys(ctx, p, pw, "postgres", "fk_child")
	if err != nil { t.Fatalf("ListForeignKeys: %v", err) }
	if len(fks) != 1 || fks[0].Column != "parent_id" || fks[0].RefTable != "fk_parent" || fks[0].RefColumn != "id" {
		t.Errorf("unexpected fks: %+v", fks)
	}
}

func TestPostgreSQLConnector_ListIndexes(t *testing.T) {
	connector := NewPostgreSQLConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p := domain.ConnectionProfile{ID: "pg-idx-1", Name: "PG", Driver: "postgres", Host: "127.0.0.1", Port: 5432, Database: "postgres", Username: "postgres", TLSMode: "none"}
	pw := "postgres"
	exec := func(q string) error {
		_, err := connector.ExecuteQueryStream(ctx, p, pw, q, false, func(int64) {}, func([]string) error { return nil }, func([]any) error { return nil })
		return err
	}
	_ = exec("DROP TABLE IF EXISTS idx_test")
	if err := exec("CREATE TABLE idx_test (id INT PRIMARY KEY, a INT, b INT)"); err != nil {
		t.Fatalf("create: %v", err)
	}
	defer exec("DROP TABLE IF EXISTS idx_test")
	if err := exec("CREATE UNIQUE INDEX ux_ab ON idx_test (a, b)"); err != nil {
		t.Fatalf("index: %v", err)
	}

	idx, err := connector.ListIndexes(ctx, p, pw, "postgres", "idx_test")
	if err != nil {
		t.Fatalf("ListIndexes: %v", err)
	}
	byName := map[string]ports.Index{}
	for _, i := range idx {
		byName[i.Name] = i
	}
	ux, ok := byName["ux_ab"]
	if !ok || !ux.Unique || ux.Primary || len(ux.Columns) != 2 || ux.Columns[0] != "a" || ux.Columns[1] != "b" {
		t.Errorf("unexpected ux_ab: %+v", ux)
	}
	// the PK index exists and is flagged primary
	var foundPK bool
	for _, i := range idx {
		if i.Primary && len(i.Columns) == 1 && i.Columns[0] == "id" {
			foundPK = true
		}
	}
	if !foundPK {
		t.Errorf("expected a primary index on id, got %+v", idx)
	}
}

func TestPostgreSQLConnector_Views(t *testing.T) {
	connector := NewPostgreSQLConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p := domain.ConnectionProfile{ID: "pg-views-1", Name: "PG", Driver: "postgres", Host: "127.0.0.1", Port: 5432, Database: "postgres", Username: "postgres", TLSMode: "none"}
	pw := "postgres"
	exec := func(q string) error {
		_, err := connector.ExecuteQueryStream(ctx, p, pw, q, false, func(int64) {}, func([]string) error { return nil }, func([]any) error { return nil })
		return err
	}
	_ = exec("DROP VIEW IF EXISTS v_test")
	_ = exec("DROP TABLE IF EXISTS vt_base")
	if err := exec("CREATE TABLE vt_base (id INT)"); err != nil { t.Fatalf("base: %v", err) }
	defer exec("DROP TABLE IF EXISTS vt_base")
	if err := exec("CREATE VIEW v_test AS SELECT id FROM vt_base"); err != nil { t.Fatalf("view: %v", err) }
	defer exec("DROP VIEW IF EXISTS v_test")

	views, err := connector.ListViews(ctx, p, pw, "postgres")
	if err != nil { t.Fatalf("ListViews: %v", err) }
	found := false
	for _, v := range views { if v.Name == "v_test" { found = true } }
	if !found { t.Errorf("expected v_test in views, got %v", views) }

	tables, err := connector.ListTables(ctx, p, pw, "postgres")
	if err != nil { t.Fatalf("ListTables: %v", err) }
	for _, tb := range tables { if tb.Name == "v_test" { t.Errorf("ListTables must exclude views") } }

	ddl, err := connector.GetViewDDL(ctx, p, pw, "postgres", "v_test")
	if err != nil { t.Fatalf("GetViewDDL: %v", err) }
	if !strings.Contains(ddl, "v_test") || !strings.Contains(strings.ToUpper(ddl), "SELECT") {
		t.Errorf("unexpected view DDL: %q", ddl)
	}
}
