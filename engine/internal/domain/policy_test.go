package domain

import "testing"

func TestClassifyQuery(t *testing.T) {
	cases := []struct {
		name        string
		query       string
		readOnly    bool
		destructive bool
		verb        string
	}{
		{"select", "SELECT * FROM users", true, false, "SELECT"},
		{"lowercase select", "select id from users where id = 1", true, false, "SELECT"},
		{"select with leading whitespace", "   \n  SELECT 1", true, false, "SELECT"},
		{"show", "SHOW TABLES", true, false, "SHOW"},
		{"explain", "EXPLAIN SELECT 1", true, false, "EXPLAIN"},
		{"line comment before select", "-- pull users\nSELECT * FROM users", true, false, "SELECT"},
		{"block comment before select", "/* report */ SELECT 1", true, false, "SELECT"},
		{"cte select is read-only", "WITH t AS (SELECT 1) SELECT * FROM t", true, false, "WITH"},

		{"insert is write", "INSERT INTO users (id) VALUES (1)", false, false, "INSERT"},
		{"update with where is non-destructive write", "UPDATE users SET name='x' WHERE id=1", false, false, "UPDATE"},
		{"update without where is destructive", "UPDATE users SET name='x'", false, true, "UPDATE"},
		{"delete with where is non-destructive write", "DELETE FROM users WHERE id=1", false, false, "DELETE"},
		{"delete without where is destructive", "DELETE FROM users", false, true, "DELETE"},

		{"drop is destructive", "DROP TABLE users", false, true, "DROP"},
		{"truncate is destructive", "TRUNCATE TABLE users", false, true, "TRUNCATE"},
		{"alter is destructive", "ALTER TABLE users ADD COLUMN x INT", false, true, "ALTER"},
		{"grant is destructive", "GRANT ALL ON db.* TO 'a'@'%'", false, true, "GRANT"},
		{"create table is non-destructive write", "CREATE TABLE t (id INT)", false, false, "CREATE"},
		{"create user is destructive", "CREATE USER 'a'@'%' IDENTIFIED BY 'p'", false, true, "CREATE"},

		{"multi statement is unsafe", "SELECT 1; DROP TABLE users", false, true, "MULTI"},
		{"trailing semicolon is fine", "SELECT 1;", true, false, "SELECT"},
		{"cte write is not read-only", "WITH t AS (SELECT 1) DELETE FROM users", false, false, "WITH"},
		{"unknown verb is treated as write", "VACUUM users", false, false, "VACUUM"},
		{"empty query is read-only", "   ", true, false, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyQuery(tc.query)
			if got.ReadOnly != tc.readOnly {
				t.Errorf("ReadOnly: got %v, want %v", got.ReadOnly, tc.readOnly)
			}
			if got.Destructive != tc.destructive {
				t.Errorf("Destructive: got %v, want %v", got.Destructive, tc.destructive)
			}
			if got.Verb != tc.verb {
				t.Errorf("Verb: got %q, want %q", got.Verb, tc.verb)
			}
		})
	}
}
