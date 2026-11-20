//go:build integration

package mysql

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

func TestMySQLConnector_Integration(t *testing.T) {
	connector := NewMySQLConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	p := domain.ConnectionProfile{
		ID:        "mysql-integration-1",
		Name:      "MySQL Local",
		Driver:    "mysql",
		Host:      "127.0.0.1",
		Port:      3306,
		Database:  "information_schema",
		Username:  "root",
		TLSMode:   "none",
	}

	err := connector.TestConnection(ctx, p, "password1!")
	if err != nil {
		t.Fatalf("failed to connect to local MySQL: %v", err)
	}
}

func TestMySQLConnector_ExecuteQueryStream(t *testing.T) {
	connector := NewMySQLConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	p := domain.ConnectionProfile{
		ID:        "mysql-integration-1",
		Name:      "MySQL Local",
		Driver:    "mysql",
		Host:      "127.0.0.1",
		Port:      3306,
		Database:  "information_schema",
		Username:  "root",
		TLSMode:   "none",
	}

	var headers []string
	var rows [][]any

	rowsAffected, err := connector.ExecuteQueryStream(
		ctx, p, "password1!",
		"SELECT SCHEMA_NAME FROM information_schema.schemata LIMIT 2",
		false,
		func(sessionID int64) {},
		func(cols []string) error {
			headers = cols
			return nil
		},
		func(row []any) error {
			rows = append(rows, row)
			return nil
		},
	)

	if err != nil {
		t.Fatalf("failed to execute query stream: %v", err)
	}

	if len(headers) != 1 || headers[0] != "SCHEMA_NAME" {
		t.Errorf("unexpected headers: %v", headers)
	}

	if len(rows) == 0 {
		t.Errorf("expected at least one row, got 0")
	}

	if rowsAffected != int64(len(rows)) {
		t.Errorf("rowsAffected (%d) does not match len(rows) (%d)", rowsAffected, len(rows))
	}
}

func TestMySQLConnector_Cancellation(t *testing.T) {
	connector := NewMySQLConnector()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	p := domain.ConnectionProfile{
		ID:        "mysql-integration-1",
		Name:      "MySQL Local",
		Driver:    "mysql",
		Host:      "127.0.0.1",
		Port:      3306,
		Database:  "information_schema",
		Username:  "root",
		TLSMode:   "none",
	}

	sessionChan := make(chan int64, 1)

	go func() {
		_, _ = connector.ExecuteQueryStream(
			ctx, p, "password1!",
			"SELECT SLEEP(5)",
			false,
			func(sessionID int64) {
				sessionChan <- sessionID
			},
			func(cols []string) error { return nil },
			func(row []any) error { return nil },
		)
	}()

	select {
	case sessionID := <-sessionChan:
		time.Sleep(100 * time.Millisecond)
		err := connector.CancelSession(context.Background(), p, "password1!", sessionID)
		if err != nil {
			t.Fatalf("failed to cancel session: %v", err)
		}
		cancel()
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for query session to start")
	}
}

func TestMySQLConnector_ExecuteBatch(t *testing.T) {
	connector := NewMySQLConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p := domain.ConnectionProfile{
		ID: "mysql-batch-1", Name: "MySQL Local", Driver: "mysql",
		Host: "127.0.0.1", Port: 3306, Database: "devdb", Username: "root", TLSMode: "none",
	}
	pw := "password1!"

	exec := func(q string) error {
		_, err := connector.ExecuteQueryStream(ctx, p, pw, q, false,
			func(int64) {}, func([]string) error { return nil }, func([]any) error { return nil })
		return err
	}
	_ = exec("DROP TABLE IF EXISTS devdb.batch_test")
	if err := exec("CREATE TABLE devdb.batch_test (id INT PRIMARY KEY, v INT)"); err != nil {
		t.Fatalf("setup: %v", err)
	}
	defer exec("DROP TABLE IF EXISTS devdb.batch_test")

	// rollback: duplicate PK in the 2nd statement rolls the whole batch back
	_, failedIndex, err := connector.ExecuteBatch(ctx, p, pw, []string{
		"INSERT INTO devdb.batch_test (id, v) VALUES (1, 10)",
		"INSERT INTO devdb.batch_test (id, v) VALUES (1, 20)",
	})
	if err == nil {
		t.Fatal("expected a duplicate-key error")
	}
	if failedIndex != 1 {
		t.Errorf("expected failedIndex 1, got %d", failedIndex)
	}
	// rollback proof: id=1 is free again, so inserting it now succeeds
	_, fi2, err2 := connector.ExecuteBatch(ctx, p, pw, []string{
		"INSERT INTO devdb.batch_test (id, v) VALUES (1, 99)",
	})
	if err2 != nil || fi2 != -1 {
		t.Fatalf("rollback did not happen — id=1 still present (err=%v, fi=%d)", err2, fi2)
	}

	// commit: distinct ids → both apply atomically
	affected, fi3, err3 := connector.ExecuteBatch(ctx, p, pw, []string{
		"UPDATE devdb.batch_test SET v = 100 WHERE id = 1",
		"INSERT INTO devdb.batch_test (id, v) VALUES (2, 20)",
	})
	if err3 != nil || fi3 != -1 {
		t.Fatalf("expected success, got err=%v fi=%d", err3, fi3)
	}
	if affected != 2 {
		t.Errorf("expected rowsAffected 2, got %d", affected)
	}
}

func TestMySQLConnector_ForeignKeys(t *testing.T) {
	connector := NewMySQLConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p := domain.ConnectionProfile{ID: "mysql-fk-1", Name: "MySQL", Driver: "mysql", Host: "127.0.0.1", Port: 3306, Database: "devdb", Username: "root", TLSMode: "none"}
	pw := "password1!"
	exec := func(q string) error {
		_, err := connector.ExecuteQueryStream(ctx, p, pw, q, false, func(int64) {}, func([]string) error { return nil }, func([]any) error { return nil })
		return err
	}
	_ = exec("DROP TABLE IF EXISTS devdb.fk_child")
	_ = exec("DROP TABLE IF EXISTS devdb.fk_parent")
	if err := exec("CREATE TABLE devdb.fk_parent (id INT PRIMARY KEY)"); err != nil { t.Fatalf("parent: %v", err) }
	defer exec("DROP TABLE IF EXISTS devdb.fk_parent")
	if err := exec("CREATE TABLE devdb.fk_child (id INT, parent_id INT, FOREIGN KEY (parent_id) REFERENCES devdb.fk_parent(id))"); err != nil { t.Fatalf("child: %v", err) }
	defer exec("DROP TABLE IF EXISTS devdb.fk_child")

	fks, err := connector.ListForeignKeys(ctx, p, pw, "devdb", "fk_child")
	if err != nil { t.Fatalf("ListForeignKeys: %v", err) }
	if len(fks) != 1 || fks[0].Column != "parent_id" || fks[0].RefTable != "fk_parent" || fks[0].RefColumn != "id" {
		t.Errorf("unexpected fks: %+v", fks)
	}
}

func TestMySQLConnector_ListIndexes(t *testing.T) {
	connector := NewMySQLConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p := domain.ConnectionProfile{ID: "mysql-idx-1", Name: "MySQL", Driver: "mysql", Host: "127.0.0.1", Port: 3306, Database: "devdb", Username: "root", TLSMode: "none"}
	pw := "password1!"
	exec := func(q string) error {
		_, err := connector.ExecuteQueryStream(ctx, p, pw, q, false, func(int64) {}, func([]string) error { return nil }, func([]any) error { return nil })
		return err
	}
	_ = exec("DROP TABLE IF EXISTS devdb.idx_test")
	if err := exec("CREATE TABLE devdb.idx_test (id INT PRIMARY KEY, a INT, b INT)"); err != nil {
		t.Fatalf("create: %v", err)
	}
	defer exec("DROP TABLE IF EXISTS devdb.idx_test")
	if err := exec("CREATE UNIQUE INDEX ux_ab ON devdb.idx_test (a, b)"); err != nil {
		t.Fatalf("index: %v", err)
	}

	idx, err := connector.ListIndexes(ctx, p, pw, "devdb", "idx_test")
	if err != nil {
		t.Fatalf("ListIndexes: %v", err)
	}
	byName := map[string]ports.Index{}
	for _, i := range idx {
		byName[i.Name] = i
	}
	pk, ok := byName["PRIMARY"]
	if !ok || !pk.Primary || len(pk.Columns) != 1 || pk.Columns[0] != "id" {
		t.Errorf("unexpected PRIMARY: %+v", pk)
	}
	ux, ok := byName["ux_ab"]
	if !ok || !ux.Unique || ux.Primary || len(ux.Columns) != 2 || ux.Columns[0] != "a" || ux.Columns[1] != "b" {
		t.Errorf("unexpected ux_ab: %+v", ux)
	}
}

func TestMySQLConnector_Views(t *testing.T) {
	connector := NewMySQLConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p := domain.ConnectionProfile{ID: "mysql-views-1", Name: "MySQL", Driver: "mysql", Host: "127.0.0.1", Port: 3306, Database: "devdb", Username: "root", TLSMode: "none"}
	pw := "password1!"
	exec := func(q string) error {
		_, err := connector.ExecuteQueryStream(ctx, p, pw, q, false, func(int64) {}, func([]string) error { return nil }, func([]any) error { return nil })
		return err
	}
	_ = exec("DROP VIEW IF EXISTS devdb.v_test")
	_ = exec("DROP TABLE IF EXISTS devdb.vt_base")
	if err := exec("CREATE TABLE devdb.vt_base (id INT)"); err != nil { t.Fatalf("base: %v", err) }
	defer exec("DROP TABLE IF EXISTS devdb.vt_base")
	if err := exec("CREATE VIEW devdb.v_test AS SELECT id FROM devdb.vt_base"); err != nil { t.Fatalf("view: %v", err) }
	defer exec("DROP VIEW IF EXISTS devdb.v_test")

	views, err := connector.ListViews(ctx, p, pw, "devdb")
	if err != nil { t.Fatalf("ListViews: %v", err) }
	names := map[string]bool{}
	for _, v := range views { names[v.Name] = true }
	if !names["v_test"] { t.Errorf("expected v_test in views, got %v", views) }

	tables, err := connector.ListTables(ctx, p, pw, "devdb")
	if err != nil { t.Fatalf("ListTables: %v", err) }
	for _, tb := range tables { if tb.Name == "v_test" { t.Errorf("ListTables must exclude views, but contained v_test") } }

	ddl, err := connector.GetViewDDL(ctx, p, pw, "devdb", "v_test")
	if err != nil { t.Fatalf("GetViewDDL: %v", err) }
	if !strings.Contains(ddl, "v_test") || !strings.Contains(strings.ToUpper(ddl), "SELECT") {
		t.Errorf("unexpected view DDL: %q", ddl)
	}
}

// A server-side KILL CONNECTION must leave the query session in a recoverable
// "lost" state instead of failing every later run with the raw driver error.
func TestMySQLConnector_QuerySessionKilledByServerIsLost(t *testing.T) {
	connector := NewMySQLConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p := domain.ConnectionProfile{
		ID: "mysql-lost-1", Name: "MySQL Local", Driver: "mysql",
		Host: "127.0.0.1", Port: 3306, Database: "information_schema",
		Username: "root", TLSMode: "none",
	}
	const password = "password1!"

	id, err := connector.OpenQuerySession(ctx, p, password, "owner", "information_schema", false, true)
	if err != nil {
		t.Skipf("local MySQL unavailable: %v", err)
	}
	defer connector.CloseQuerySession("owner", id)

	var connectionID int64
	if _, err := connector.ExecuteQuerySessionStream(ctx, p, password, "owner", "information_schema", id,
		"SELECT CONNECTION_ID()", false, func(sid int64) { connectionID = sid },
		func([]string) error { return nil }, func([]any) error { return nil }); err != nil {
		t.Fatal(err)
	}

	killer, err := connector.connect(ctx, p, password, "")
	if err != nil {
		t.Fatal(err)
	}
	defer killer.Close()
	if _, err := killer.ExecContext(ctx, "KILL CONNECTION "+strconv.FormatInt(connectionID, 10)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)

	run := func() error {
		_, err := connector.ExecuteQuerySessionStream(ctx, p, password, "owner", "information_schema", id,
			"SELECT 75", false, nil, func([]string) error { return nil }, func([]any) error { return nil })
		return err
	}
	first := run()
	if first == nil {
		t.Fatal("run on a killed connection must fail")
	}
	t.Logf("driver error on the first run after KILL CONNECTION: %T %v", first, first)
	if state, err := connector.QuerySessionState("owner", id); err != nil || state != "lost" {
		t.Fatalf("state = %q, %v; want lost", state, err)
	}
}

// KILL CONNECTION while a statement is running must also leave the session lost
// (the driver reports "invalid connection" here too).
func TestMySQLConnector_QuerySessionKilledMidStatementIsLost(t *testing.T) {
	connector := NewMySQLConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	p := domain.ConnectionProfile{
		ID: "mysql-lost-2", Name: "MySQL Local", Driver: "mysql",
		Host: "127.0.0.1", Port: 3306, Database: "information_schema",
		Username: "root", TLSMode: "none",
	}
	const password = "password1!"

	id, err := connector.OpenQuerySession(ctx, p, password, "owner", "information_schema", false, true)
	if err != nil {
		t.Skipf("local MySQL unavailable: %v", err)
	}
	defer connector.CloseQuerySession("owner", id)

	started := make(chan int64, 1)
	result := make(chan error, 1)
	go func() {
		_, err := connector.ExecuteQuerySessionStream(ctx, p, password, "owner", "information_schema", id,
			"SELECT SLEEP(10)", false, func(sid int64) { started <- sid },
			func([]string) error { return nil }, func([]any) error { return nil })
		result <- err
	}()
	connectionID := <-started
	time.Sleep(300 * time.Millisecond)
	killer, err := connector.connect(ctx, p, password, "")
	if err != nil {
		t.Fatal(err)
	}
	defer killer.Close()
	if _, err := killer.ExecContext(ctx, "KILL CONNECTION "+strconv.FormatInt(connectionID, 10)); err != nil {
		t.Fatal(err)
	}
	runErr := <-result
	if runErr == nil {
		t.Fatal("SLEEP must be interrupted by KILL CONNECTION")
	}
	t.Logf("driver error for a statement interrupted by KILL CONNECTION: %T %v", runErr, runErr)
	if state, err := connector.QuerySessionState("owner", id); err != nil || state != "lost" {
		t.Fatalf("state = %q, %v; want lost (error was %v)", state, err, runErr)
	}
}
