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
}
