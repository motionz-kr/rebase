package adapters

import (
	"context"
	"database/sql"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlsession"
	_ "modernc.org/sqlite"
)

func TestExecuteSessionQueryReturnsAffectedRowsAndSupportsReturning(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "query-session.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()

	var headers [][]string
	var returnedRows [][]any
	rowsAffected, err := ExecuteSessionQuery(context.Background(), sqlsession.Queryer(tx),
		`INSERT INTO items(name) VALUES ('affected')`,
		func(columns []string) error { headers = append(headers, columns); return nil },
		func(row []any) error { returnedRows = append(returnedRows, row); return nil },
	)
	if err != nil {
		t.Fatal(err)
	}
	if rowsAffected != 1 {
		t.Fatalf("rows affected = %d, want 1", rowsAffected)
	}
	if len(headers) != 1 || len(headers[0]) != 0 || len(returnedRows) != 0 {
		t.Fatalf("non-returning INSERT callbacks: headers=%v rows=%v", headers, returnedRows)
	}

	headerCount := len(headers)
	rowsAffected, err = ExecuteSessionQuery(context.Background(), sqlsession.Queryer(tx),
		`INSERT INTO items(name) VALUES ('returned') RETURNING id, name`,
		func(columns []string) error { headers = append(headers, columns); return nil },
		func(row []any) error { returnedRows = append(returnedRows, row); return nil },
	)
	if err != nil {
		t.Fatal(err)
	}
	if rowsAffected != 1 || len(headers) != headerCount+1 || !reflect.DeepEqual(headers[headerCount], []string{"id", "name"}) {
		t.Fatalf("RETURNING result: rows affected=%d headers=%v", rowsAffected, headers[headerCount:])
	}
	if len(returnedRows) != 1 || returnedRows[0][1] != "returned" {
		t.Fatalf("RETURNING rows = %#v, want one returned row", returnedRows)
	}
	for _, query := range []string{
		`UPDATE items SET name='returning output'`,
		`WITH t AS (SELECT 'UPDATE' AS value) UPDATE items SET name=(SELECT value FROM t)`,
	} {
		var columns []string
		var rows [][]any
		n, err := ExecuteSessionQuery(context.Background(), tx, query,
			func(c []string) error { columns = c; return nil },
			func(r []any) error { rows = append(rows, r); return nil })
		if err != nil || n != 2 || len(columns) != 0 || len(rows) != 0 {
			t.Fatalf("non-returning UPDATE: columns=%v rows=%v affected=%d err=%v", columns, rows, n, err)
		}
	}
}

func TestExecuteSessionQueryPreservesQueryResults(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, query := range []string{
		`WITH t AS (SELECT 7 AS updated_at, 8 AS created_at) SELECT updated_at, created_at FROM t`,
		`WITH t AS (SELECT 'update; -- /*' AS value) SELECT value FROM t`,
		`SELECT 'a;b' AS value`,
	} {
		t.Run(query, func(t *testing.T) {
			var wantColumns []string
			var wantRows [][]any
			rows, err := db.Query(query)
			if err != nil {
				t.Fatal(err)
			}
			_, err = StreamRows(rows, func(c []string) error { wantColumns = c; return nil }, func(r []any) error { wantRows = append(wantRows, r); return nil })
			rows.Close()
			if err != nil {
				t.Fatal(err)
			}
			var columns []string
			var gotRows [][]any
			n, err := ExecuteSessionQuery(context.Background(), db, query,
				func(c []string) error { columns = c; return nil },
				func(r []any) error { gotRows = append(gotRows, r); return nil })
			if err != nil || n != 1 || !reflect.DeepEqual(columns, wantColumns) || !reflect.DeepEqual(gotRows, wantRows) {
				t.Fatalf("got columns=%v rows=%v n=%d err=%v; want columns=%v rows=%v", columns, gotRows, n, err, wantColumns, wantRows)
			}
		})
	}
}

func TestSessionQueryReturnsRows(t *testing.T) {
	for _, tc := range []struct {
		query string
		want  bool
	}{
		{`WITH t AS (SELECT updated_at FROM items) SELECT * FROM t`, true},
		{`WITH changed AS (DELETE FROM items RETURNING id) SELECT * FROM changed`, true},
		{`WITH changed AS (DELETE FROM items RETURNING id) UPDATE items SET value=1`, false},
		{`WITH t AS (SELECT 1) UPDATE items SET value=1`, false},
		{`SELECT 'a;b'`, true},
		{`(WITH t AS (SELECT updated_at FROM items) SELECT * FROM t)`, true},
		{`WITH`, false},
		{`WITH t AS (SELECT 1)`, false},
		{`UPDATE items SET output=1`, false},
		{`UPDATE items SET value='returning output'`, false},
		{`UPDATE items SET value=1 /* RETURNING id */`, false},
		{`UPDATE items SET "returning"=1`, false},
		{`UPDATE items SET value=1 RETURNING id`, true},
		{`UPDATE items SET value=1 OUTPUT inserted.id`, true},
		{`UPDATE items SET value=1 OUTPUT inserted.id INTO @saved`, false},
		{`CALL get_items()`, true},
	} {
		t.Run(tc.query, func(t *testing.T) {
			if got := sessionQueryReturnsRows(tc.query); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIsPlainDMLWrite(t *testing.T) {
	cases := map[string]bool{
		"INSERT INTO t VALUES (1)":                                     true,
		"  update t set a = 1 where id = 2;":                           true,
		"-- note\nDELETE FROM t WHERE id = 1":                          true,
		"/* c */ UPDATE t SET a = 1":                                   true,
		"REPLACE INTO t VALUES (1)":                                    true,
		"MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE": true,
		"WITH x AS (SELECT 1) UPDATE t SET a = 1":                      true,
		"WITH x AS (SELECT 1) /* n */ DELETE FROM t":                   true,
		"UPDATE t SET a = 1 RETURNING id":                              false,
		"INSERT INTO t VALUES (1) RETURNING *":                         false,
		"DELETE FROM t OUTPUT deleted.id":                              false,
		"WITH x AS (SELECT 1) SELECT * FROM x":                         false,
		"SELECT 1":                                                     false,
		"EXEC sp_help 't'":                                             false,
		"EXECUTE sp_spaceused":                                         false,
		"DECLARE @n int = 1 SELECT @n":                                 false,
		"PREPARE p AS UPDATE t SET a = 1":                              false,
		"EXECUTE p":                                                    false,
		"EXPLAIN ANALYZE UPDATE t SET a = 1":                           false,
		"UPDATE t SET a = 1; SELECT 2":                                 false,
		"CREATE TABLE t (a int)":                                       false,
		"":                                                             false,
		"; UPDATE t SET v=1 RETURNING id":                              false,
		";; INSERT INTO t VALUES (1)":                                  true,
		"UPDATE t SET v = '\\' RETURNING id":                           false,
		"UPDATE t SET v = 'unterminated":                               false,
		"/*! UPDATE t SET v=1 */":                                      false,
		"-- only a comment":                                            false,
	}
	for query, want := range cases {
		if got := IsPlainDMLWrite(query); got != want {
			t.Errorf("IsPlainDMLWrite(%q) = %v, want %v", query, got, want)
		}
	}
}
