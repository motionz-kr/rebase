package domain

import (
	"reflect"
	"testing"
)

func TestSQLTokens(t *testing.T) {
	for _, tc := range []struct {
		query    string
		want     []string
		complete bool
	}{
		{`WITH t AS (SELECT updated_at) SELECT * FROM t`, []string{"WITH", "T", "AS", "(", "SELECT", "UPDATED_AT", ")", "SELECT", "*", "FROM", "T"}, true},
		{`SELECT 'it''s; -- /* UPDATE */', "a""b", ` + "`a``b`" + `, [a]]b]`, []string{"SELECT", "?", ",", "?", ",", "?", ",", "?"}, true},
		{"/* report */ SELECT 1 -- comment\r\n;", []string{"SELECT", "1", ";"}, true},
		{`SELECT $$UPDATE; -- /*$$, $tag$DELETE; 'x'$tag$`, []string{"SELECT", "?", ",", "?"}, true},
		{`SELECT 'unfinished`, []string{"SELECT", "?"}, false},
		{`SELECT 'back\slash'`, []string{"SELECT", "?"}, true},
		{`SELECT 'back\'slash'`, []string{"SELECT", "?"}, false},
		{`SELECT 1 /*! INTO OUTFILE 'file' */`, []string{"SELECT", "1"}, false},
		{`SELECT 1 /* unfinished`, []string{"SELECT", "1"}, false},
	} {
		t.Run(tc.query, func(t *testing.T) {
			got, complete := SQLTokens(tc.query)
			if !reflect.DeepEqual(got, tc.want) || complete != tc.complete {
				t.Fatalf("got %v, %v; want %v, %v", got, complete, tc.want, tc.complete)
			}
		})
	}
}
