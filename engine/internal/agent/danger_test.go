package agent

import "testing"

func TestClassifyStatement(t *testing.T) {
	cases := []struct {
		name string
		sql  string
		want Risk
	}{
		{"plain select", "SELECT * FROM users WHERE id = 1", RiskSafe},
		{"insert", "INSERT INTO users (id) VALUES (1)", RiskSafe},
		{"update with where", "UPDATE users SET name='a' WHERE id=1", RiskSafe},
		{"update no where", "UPDATE users SET name='a'", RiskDangerous},
		{"delete no where", "DELETE FROM users", RiskDangerous},
		{"delete with where", "DELETE FROM users WHERE id=1", RiskSafe},
		{"drop table", "DROP TABLE users", RiskDangerous},
		{"truncate", "TRUNCATE TABLE users", RiskDangerous},
		{"alter drop col", "ALTER TABLE users DROP COLUMN x", RiskDangerous},
		{"where only inside comment is not a real where", "DELETE FROM logs -- WHERE keep", RiskDangerous},
		{"lowercase drop", "drop table users", RiskDangerous},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ClassifyStatement(c.sql)
			if got.Risk != c.want {
				t.Fatalf("ClassifyStatement(%q).Risk = %q, want %q (reasons=%v)", c.sql, got.Risk, c.want, got.Reasons)
			}
			if c.want == RiskDangerous && len(got.Reasons) == 0 {
				t.Errorf("dangerous result should explain why")
			}
		})
	}
}
