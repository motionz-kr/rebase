package domain

import "testing"

func TestTransactionCommand(t *testing.T) {
	for _, tc := range []struct {
		sql, action string
		chain       bool
	}{
		{"-- comment\nSTART TRANSACTION READ WRITE", "begin", false},
		{"BEGIN IMMEDIATE TRANSACTION;", "begin", false},
		{"BEGIN TRANSACTION", "begin", false},
		{"COMMIT WORK AND CHAIN", "commit", true},
		{"COMMIT AND NO CHAIN", "commit", false},
		{"ROLLBACK", "rollback", false},
		{"ROLLBACK WORK TO SAVEPOINT before_change", "rollback-to", false},
		{"SAVEPOINT before_change", "savepoint", false},
		{"RELEASE SAVEPOINT before_change", "release", false},
		{"SELECT 'ROLLBACK'", "", false},
		{"START REPLICA", "", false},
		{"BEGINNING", "", false},
	} {
		got := ParseTransactionCommand(tc.sql)
		if got.Action != tc.action || got.Chain != tc.chain {
			t.Errorf("%q: %+v", tc.sql, got)
		}
	}
}

func TestTransactionSavepointNames(t *testing.T) {
	for _, sql := range []string{"SAVEPOINT savepointed", "RELEASE savepointed", "RELEASE SAVEPOINT savepointed"} {
		if got := ParseTransactionCommand(sql).Name; got != "SAVEPOINTED" {
			t.Fatalf("%q: %q", sql, got)
		}
	}
}
