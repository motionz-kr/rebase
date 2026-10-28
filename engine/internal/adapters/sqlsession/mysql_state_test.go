package sqlsession

import "testing"

func TestMySQLSessionBoundaries(t *testing.T) {
	for _, tc := range []struct {
		sql  string
		want bool
	}{
		{"CREATE TABLE t (id INT)", true},
		{"CREATE TEMPORARY TABLE t (id INT)", false},
		{"CREATE\nTEMPORARY TABLE t (id INT)", false},
		{"DROP TEMPORARY TABLE t", false},
		{"ALTER TABLE t ADD COLUMN name TEXT", true},
		{"UPDATE t SET id=2 WHERE id=1", false},
		{"SELECT 'COMMIT'", false},
	} {
		if got := mysqlImplicitCommit(tc.sql); got != tc.want {
			t.Errorf("%q: %v", tc.sql, got)
		}
	}
	for _, tc := range []struct {
		sql       string
		value, ok bool
	}{
		{"SET autocommit=0", false, true},
		{"SET SESSION autocommit = ON", true, true},
		{"SET @@session.autocommit=1;", true, true},
		{"SET SESSION time_zone='+09:00'", false, false},
		{"SELECT 'SET autocommit=1'", false, false},
	} {
		v, ok := mysqlAutoCommit(tc.sql)
		if v != tc.value || ok != tc.ok {
			t.Errorf("%q: %v %v", tc.sql, v, ok)
		}
	}
}
