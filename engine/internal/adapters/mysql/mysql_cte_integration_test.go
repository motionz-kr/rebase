//go:build integration

package mysql

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func TestMySQLConnector_CTEResults(t *testing.T) {
	connector := NewMySQLConnector()
	p := domain.ConnectionProfile{ID: "mysql-cte", Driver: "mysql", Host: "127.0.0.1", Port: 3306, Database: "information_schema", Username: "root", TLSMode: "none"}
	for _, tc := range []struct {
		query   string
		columns []string
		rows    [][]any
	}{
		{`WITH t AS (SELECT 7 AS updated_at, 8 AS created_at) SELECT * FROM t`, []string{"updated_at", "created_at"}, [][]any{{int64(7), int64(8)}}},
		{`WITH t AS (SELECT 'UPDATE; -- /*' AS value) SELECT * FROM t`, []string{"value"}, [][]any{{"UPDATE; -- /*"}}},
		{`SELECT 'a;b' AS value`, []string{"value"}, [][]any{{"a;b"}}},
	} {
		t.Run(tc.query, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var columns []string
			var rows [][]any
			n, err := connector.ExecuteQueryStream(ctx, p, "password1!", tc.query, true, nil,
				func(c []string) error { columns = c; return nil },
				func(r []any) error { rows = append(rows, r); return nil })
			if err != nil || n != 1 || !reflect.DeepEqual(columns, tc.columns) || !reflect.DeepEqual(rows, tc.rows) {
				t.Fatalf("columns=%v rows=%#v n=%d err=%v; want columns=%v rows=%#v", columns, rows, n, err, tc.columns, tc.rows)
			}
		})
	}
}
